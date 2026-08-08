/**
 * Fixture recorder — turns a live staging run into replayable response fixtures.
 *
 * The SDK's whole value is encoding what the wire ACTUALLY sends, so the regression suite has
 * to assert against real bytes. A hand-authored fixture encodes the same guess the type does
 * and can only ever confirm the bug, which is why nothing here invents a response: this wraps
 * `fetch`, copies the body BEFORE the SDK parses or normalizes it, and writes it verbatim.
 *
 * Wiring (see `examples/surface-probe.ts`):
 *
 * ```ts
 * const rec = createFixtureRecorder({ baseUrl, enabled: process.env.ZOOCLAW_RECORD_FIXTURES === '1' })
 * const zc = createZooclawClient({ fetch: rec.fetch })
 * rec.tag('get-agent')                 // names the NEXT response
 * await zc.getAgent(agentId)
 * await rec.flush()                    // scrub, dedupe, write
 * ```
 *
 * Recording is OFF unless `enabled`, and when off `rec.fetch` is `globalThis.fetch` with a
 * bookkeeping wrapper — the probe behaves identically either way.
 *
 * Two rules this file exists to enforce:
 *
 *  1. RAW, not normalized. Post-normalization capture would smooth away exactly the quirks the
 *     fixtures are meant to pin (`latest_version: "1"` as a string, `status: null`, absent keys
 *     that the types wrongly promise).
 *  2. Nothing sensitive lands on disk. Headers are never recorded, so no `Authorization` can
 *     leak; ids, org/tenant identifiers and e-mails are rewritten to stable placeholders; and
 *     the API key itself is used as a search needle for a final belt-and-braces pass.
 */
import { writeFile, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ZooclawConfig } from '../src/index.js'

/** The on-disk shape. The request is kept with the response so a fixture is self-describing. */
export interface Fixture {
  method: string
  /** Path relative to the base URL, ids already scrubbed. */
  path: string
  status: number
  /** The response body exactly as it arrived: parsed JSON, or the raw string if it was not JSON. */
  body: unknown
}

export interface FixtureRecorder {
  /** Drop-in for `ZooclawConfig['fetch']`. */
  fetch: NonNullable<ZooclawConfig['fetch']>
  /** Name the NEXT recorded response. Un-tagged responses fall back to a derived endpoint slug. */
  tag: (name: string) => void
  /** Register a value to scrub, when the auto-scan cannot find it (e.g. a name you generated). */
  literal: (real: string, replacement: string) => void
  /** Scrub, dedupe and write every buffered response. Returns the file names written. */
  flush: () => Promise<string[]>
}

interface Buffered {
  tag?: string
  method: string
  path: string
  status: number
  text: string
}

/**
 * Keys whose STRING values are rewritten to placeholders wherever they appear afterwards.
 *
 * The replacement is a substring pass over the serialized JSON, not a key-by-key edit, because
 * ids are also embedded inside other strings — a schedule's `scheduleId` is the fully-qualified
 * `cron/{computer}/{agent}/{id}`, and a session's `session_key` carries the agent id. Editing
 * only the leaf keys would leave both intact.
 */
const KIND_BY_KEY: Record<string, string> = {
  agent_id: 'agent',
  agentId: 'agent',
  computer_id: 'computer',
  computerId: 'computer',
  session_id: 'session',
  sessionId: 'session',
  skill_id: 'skill',
  skillId: 'skill',
  environment_id: 'environment',
  environmentId: 'environment',
  build_id: 'build',
  buildId: 'build',
  org_id: 'org',
  orgId: 'org',
  organization_id: 'org',
  owner_uid: 'user',
  ownerUid: 'user',
  user_id: 'user',
  userId: 'user',
  uid: 'user',
  created_by: 'user',
  createdBy: 'user',
  creator_principal_ref: 'user',
  creatorPrincipalRef: 'user',
  email: 'email',
  user_email: 'email',
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
/** One JSON string literal, escapes included — the unit the CJK pass replaces whole. */
const JSON_STRING_RE = /"(?:[^"\\]|\\.)*"/g
const CJK_RE = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Below this length a value is too generic to substring-replace without corrupting the body. */
const MIN_SCRUB_LEN = 8

/**
 * Mint a placeholder that keeps the SHAPE of the value it replaces — same length, same
 * `prefix_` if there was one, UUIDs still UUID-shaped — so a fixture stays a realistic sample
 * while being unmistakably synthetic.
 */
const mint = (kind: string, n: number, sample: string): string => {
  if (kind === 'email' || sample.includes('@')) return `user${n}@example.invalid`
  if (UUID_RE.test(sample)) return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const m = /^([A-Za-z][A-Za-z0-9]*_)(.*)$/.exec(sample)
  const prefix = m?.[1] ?? ''
  const rest = m?.[2] ?? sample
  const seed = `${kind.toUpperCase()}${n}`
  const filled = rest.length > seed.length ? seed + '0'.repeat(rest.length - seed.length) : seed
  return prefix + filled
}

/** Turn `/agents/AGENT1…/sessions/SESSION1…/events?limit=2` into `get-agents-id-sessions-id-events`. */
const slugOf = (method: string, path: string, isId: (seg: string) => boolean): string => {
  const parts = (path.split('?')[0] ?? '')
    .split('/')
    .filter(Boolean)
    .flatMap((seg) => decodeURIComponent(seg).split(':'))
    .filter(Boolean)
    .map((seg) => (isId(seg) ? 'id' : seg.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()))
  return [method.toLowerCase(), ...parts].join('-')
}

export function createFixtureRecorder(opts: {
  baseUrl: string
  /** Defaults to `src/__fixtures__` next to this file's package root. */
  outDir?: string
  enabled: boolean
  /** Wipe the directory first, so a re-record cannot leave a stale fixture behind. Default true. */
  clean?: boolean
}): FixtureRecorder {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const outDir = opts.outDir ?? fileURLToPath(new URL('../src/__fixtures__/', import.meta.url))
  const buffer: Buffered[] = []
  const scrub = new Map<string, string>()
  const counters = new Map<string, number>()
  let pendingTag: string | undefined

  const register = (kind: string, real: unknown): void => {
    if (typeof real !== 'string' || real.length < MIN_SCRUB_LEN || scrub.has(real)) return
    const n = (counters.get(kind) ?? 0) + 1
    counters.set(kind, n)
    scrub.set(real, mint(kind, n, real))
  }

  /** Walk a parsed body and register every identifier it exposes, so later files scrub it too. */
  const harvest = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const v of node) harvest(v)
      return
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const kind = KIND_BY_KEY[k]
        if (kind && typeof v === 'string') register(kind, v)
        harvest(v)
      }
      return
    }
    if (typeof node === 'string') for (const m of node.match(EMAIL_RE) ?? []) register('email', m)
  }

  /**
   * Substring pass over the SERIALIZED json, longest needle first so one id cannot eat another's
   * prefix. Working on the serialized form is what keeps embedded ids (FQNs, session keys, URLs)
   * from surviving, and it cannot alter structure: only characters inside string literals match.
   */
  const clean = (text: string): string => {
    let out = text
    const needles = [...scrub.keys()].sort((a, b) => b.length - a.length)
    for (const real of needles) out = out.split(real).join(scrub.get(real) as string)
    // Belt and braces. The key is never recorded (headers are not captured at all); this only
    // guarantees that a server that ECHOED it back cannot smuggle it onto disk.
    const key = typeof process !== 'undefined' ? process.env?.ZOOCLAW_API_KEY : undefined
    if (key && key.length >= MIN_SCRUB_LEN) out = out.split(key).join('REDACTED')
    out = out.replace(/zct_[A-Za-z0-9_-]{8,}/g, 'zct_REDACTED')
    out = out.replace(/(Bearer )[A-Za-z0-9._~+/-]{8,}=*/g, '$1REDACTED')
    out = out.replace(EMAIL_RE, 'user@example.invalid')
    // This repository is English-only, and some platform skills carry bilingual descriptions.
    // A whole string literal goes, rather than the CJK runs inside it, so the result is honest
    // prose rather than mangled prose. Only free text is ever affected: every key in these
    // bodies is ASCII, and no id, status or enum value has ever been anything else. The keys,
    // their order, and the types on both sides of them are untouched.
    return out.replace(JSON_STRING_RE, (lit) => (CJK_RE.test(lit) ? '"<non-English text removed>"' : lit))
  }

  const baseFetch: NonNullable<ZooclawConfig['fetch']> = (input, init) => fetch(input, init)

  const recorderFetch: NonNullable<ZooclawConfig['fetch']> = async (input, init) => {
    const tag = pendingTag
    pendingTag = undefined
    const res = await baseFetch(input, init)
    if (!opts.enabled) return res
    // NEVER tee a live stream: cloning an SSE response and not draining the copy stalls the
    // real one behind backpressure, which would hang every streamEvents() call.
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) return res
    try {
      const text = await res.clone().text()
      const url = String(input)
      const path = url.startsWith(base) ? url.slice(base.length) : new URL(url).pathname
      buffer.push({ ...(tag ? { tag } : {}), method: (init?.method ?? 'GET').toUpperCase(), path, status: res.status, text })
    } catch {
      /* a body that cannot be copied is not worth failing a live probe over */
    }
    return res
  }

  return {
    fetch: opts.enabled ? recorderFetch : baseFetch,
    tag: (name) => {
      if (opts.enabled) pendingTag = name
    },
    literal: (real, replacement) => {
      if (real.length >= MIN_SCRUB_LEN) scrub.set(real, replacement)
    },
    flush: async () => {
      if (!opts.enabled || buffer.length === 0) return []

      // Harvest first, write second: an id learned from the LAST response still has to be
      // scrubbed out of the FIRST file, so nothing can be written before every id is known.
      for (const b of buffer) {
        try {
          harvest(JSON.parse(b.text))
        } catch {
          /* non-JSON body — the regex passes in clean() still cover it */
        }
      }

      const isId = (seg: string): boolean =>
        scrub.has(seg) || [...scrub.values()].includes(seg) || /^\d+$/.test(seg) || seg.length >= 24

      await mkdir(outDir, { recursive: true })
      if (opts.clean !== false) {
        for (const f of await readdir(outDir)) if (f.endsWith('.json')) await rm(join(outDir, f))
      }

      const written: string[] = []
      const seenSlug = new Set<string>()
      const skipped = new Map<string, number>()

      for (const b of buffer) {
        const scrubbedText = clean(b.text)
        const name = b.tag ?? slugOf(b.method, clean(b.path), isId)
        // A tag is deliberate, so it always wins; an untagged endpoint keeps its FIRST response
        // and counts the rest, otherwise every poll loop would fill the directory.
        if (!b.tag) {
          if (seenSlug.has(name)) {
            skipped.set(name, (skipped.get(name) ?? 0) + 1)
            continue
          }
          seenSlug.add(name)
        }
        let body: unknown = null
        if (scrubbedText.length > 0) {
          try {
            body = JSON.parse(scrubbedText)
          } catch {
            body = scrubbedText
          }
        }
        const fixture: Fixture = { method: b.method, path: clean(b.path), status: b.status, body }
        const file = `${name}.json`
        await writeFile(join(outDir, file), `${JSON.stringify(fixture, null, 2)}\n`)
        written.push(file)
      }

      console.log(`\n▸ fixtures → ${outDir}`)
      console.log(`  ${written.length} file(s) from ${buffer.length} response(s); ${scrub.size} value(s) scrubbed`)
      for (const [slug, n] of skipped) console.log(`  (${n} extra response(s) collapsed into ${slug}.json)`)
      return written
    },
  }
}
