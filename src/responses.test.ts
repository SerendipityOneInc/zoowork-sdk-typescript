/**
 * Offline RESPONSE contract tests. Every recorded staging response in `src/__fixtures__/` is
 * replayed through the SDK method that returns it, and the shape the types PROMISE is checked
 * against the shape the server actually SENT.
 *
 * `client.test.ts` pins the request half. This is the other half, and it is the half that has
 * actually been wrong: every response-shape bug this SDK has shipped — `ScheduleRecord.schedule`,
 * `EnvironmentVersionRecord.state`, `SessionRecord.status`, `EnvironmentRecord.ownership` — was a
 * field the types declared and the server never sends. So the assertions here come in pairs: the
 * field the SDK declares must be present with the right primitive kind, AND the field it used to
 * declare must be ABSENT from the wire. A suite that only checked declared fields loosely would
 * have passed on all eight.
 *
 * The fixtures are real recorded responses (see `src/__fixtures__/README.md`), never hand-authored.
 * A disagreement between this file and a fixture is therefore the SDK being wrong, not the fixture.
 */
import { expect, test } from 'vitest'
import {
  createZooclawClient,
  ZooclawError,
  type AgentRecord,
  type AgentSkill,
  type AgentStatus,
  type ArtifactPage,
  type OutcomeConfig,
  type SystemPromptInfo,
  type SystemPromptPreview,
  type EnvironmentConfig,
  type EnvironmentRecord,
  type EnvironmentVersionRecord,
  type ModelInfo,
  type Ownership,
  type SchedulePayload,
  type ScheduleRecord,
  type ScheduleRun,
  type SessionEvent,
  type SessionHistoryEntry,
  type SessionRecord,
  type SkillRecord,
  type ZooclawClient,
} from './index.js'

const BASE = 'https://api.test/service/v1'
const AGENT = 'agt_AGENT100000000000000000000'
const COLD_AGENT = 'agt_AGENT200000000000000000000'
const SESSION = 'SESSION2000000000000000000000000'
const MISSING_SESSION = 'SESSION3000000000000000000000000'
const SKILL = 'skl_SKILL190000000000000000000'
const SCHEDULE = 'surface-probe-schedule'
const ENVIRONMENT = 'env_ENVIRONMENT100000000000000000000'

// ── the fixture set ────────────────────────────────────────────────────────

/** The recorder's wrapper: the request that produced the body, and the body verbatim. */
interface Fixture {
  method: string
  path: string
  status: number
  body: unknown
}

/**
 * Every fixture, loaded as one glob rather than 55 imports — so a newly recorded file is picked
 * up without editing an import list, and the coverage test at the bottom of this file can prove
 * that no recorded response is sitting on disk unasserted.
 */
interface GlobbedMeta {
  glob(pattern: string, opts: { eager: true; import: 'default' }): Record<string, Fixture>
}
const RECORDED = (import.meta as unknown as GlobbedMeta).glob('./__fixtures__/*.json', { eager: true, import: 'default' })

const recordedNames = (): string[] =>
  Object.keys(RECORDED).map((p) => p.replace('./__fixtures__/', '').replace('.json', ''))

/** Fixtures actually replayed by a test in this file. Read by the coverage test, which runs last. */
const exercised = new Set<string>()

function fixture(name: string): Fixture {
  const found = RECORDED[`./__fixtures__/${name}.json`]
  if (!found) throw new Error(`no recorded fixture named ${name} — have: ${recordedNames().join(', ')}`)
  exercised.add(name)
  return found
}

// ── replay harness ─────────────────────────────────────────────────────────

interface Replayed<T> {
  /** What the SDK method handed back. */
  result: T
  /** The recorded body, untouched — for asserting what the SDK's type does NOT mention. */
  raw: Record<string, unknown>
  /** The path (with query) the SDK asked for, base stripped. */
  path: string
  method: string
}

/**
 * Answer every request with one recorded response.
 *
 * `body: null` in a fixture means the response carried NO body (the 204s), which is also the only
 * thing `new Response` accepts for a 204 — a `''` body throws at construction.
 */
function stub(fx: Fixture): { client: ZooclawClient; calls: { url: string; method: string }[] } {
  const calls: { url: string; method: string }[] = []
  const client = createZooclawClient({
    apiKey: 'zct_test_key',
    baseUrl: BASE,
    fetch: async (input: string, init: RequestInit = {}) => {
      calls.push({ url: input, method: init.method ?? 'GET' })
      return new Response(fx.body === null ? null : JSON.stringify(fx.body), { status: fx.status })
    },
  })
  return { client, calls }
}

async function replay<T>(name: string, call: (client: ZooclawClient) => Promise<T>): Promise<Replayed<T>> {
  const fx = fixture(name)
  const { client, calls } = stub(fx)
  const result = await call(client)
  return {
    result,
    raw: (fx.body ?? {}) as Record<string, unknown>,
    path: calls[0]!.url.slice(BASE.length),
    method: calls[0]!.method,
  }
}

/** The rejection half: error fixtures are replayed the same way, and the thrown error is asserted. */
async function replayError(name: string, call: (client: ZooclawClient) => Promise<unknown>): Promise<ZooclawError> {
  const fx = fixture(name)
  const { client } = stub(fx)
  try {
    await call(client)
  } catch (e) {
    return e as ZooclawError
  }
  throw new Error(`expected ${name} to reject, got a resolved promise`)
}

// ── shape helpers ──────────────────────────────────────────────────────────

/**
 * `absent` is the JSON sense of it: no such key. JSON cannot carry `undefined`, so on wire data
 * `undefined` and "key missing" are the same fact — and `null` is emphatically NOT one of them.
 * That distinction is the whole of bug #5 (`latest_ready_version: null`) and bug #6
 * (`state` missing, compared against `'ready'` forever).
 */
type Kind = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object' | 'absent'

function kindOf(value: unknown): Kind {
  if (value === null) return 'null'
  if (value === undefined) return 'absent'
  if (Array.isArray(value)) return 'array'
  const t = typeof value
  return t === 'string' || t === 'number' || t === 'boolean' ? t : 'object'
}

/**
 * Exactly these keys, nothing more and nothing less.
 *
 * Deliberately strict in BOTH directions. A key the server drops is a broken promise; a key the
 * server adds is news the SDK should carry a type for. Either way a re-record should land as a red
 * test rather than as silent drift.
 */
function expectExactKeys(value: unknown, keys: string[]): void {
  expect(Object.keys(value as Record<string, unknown>).sort()).toEqual([...keys].sort())
}

/** Per-field primitive kind. `"1"` is not `1`, and `null` is not absent. */
function expectKinds(value: unknown, kinds: Record<string, Kind>): void {
  const v = value as Record<string, unknown>
  const actual: Record<string, Kind> = {}
  for (const k of Object.keys(kinds)) actual[k] = kindOf(v[k])
  expect(actual).toEqual(kinds)
}

/**
 * Keys the server does not send. Uses `in`, not `=== undefined`, so a present-but-null key still
 * counts as sent — see the note on {@link Kind}.
 */
function expectNoKeys(value: unknown, ...keys: string[]): void {
  const present = keys.filter((k) => k in (value as Record<string, unknown>))
  expect(present).toEqual([])
}

/**
 * Read a field THROUGH the SDK's declared type, and assert what the server sent for it.
 *
 * Both halves are load-bearing. If the SDK stops DECLARING the field, the record's
 * `[k: string]: unknown` index signature widens the expression to `unknown`, the explicit type
 * argument stops accepting it, and `pnpm typecheck` fails. If the SERVER stops sending it, the kind
 * assertion fails. That pair is what makes a response-shape regression hard to land.
 */
function declared<T>(value: T, kind: Kind): T {
  expect(kindOf(value)).toBe(kind)
  return value
}

/**
 * The recorded value, written out in source and assigned to the slot the SDK declares for it.
 *
 * This is the direction {@link declared} cannot check. Assignability runs the other way there, so a
 * type that is too NARROW still passes: `string | undefined` is assignable to
 * `string | null | undefined`, and a caller reading it never notices until the `null` arrives.
 * Written this way round, a type that cannot HOLD what the server sent stops compiling — which is
 * precisely what `SkillRecord.ownership: Ownership` did to `owner_uid: null`.
 */
const holds = <T>(value: T): T => value

const agentInput = { resource: { name: 'x' }, ownership: { owner_uid: 'u', org_id: 'o' } }
const envInput = {
  resource: { name: 'x', config: {} as EnvironmentConfig },
  ownership: { owner_uid: 'u', org_id: 'o' },
}

// ── agents ─────────────────────────────────────────────────────────────────

test('createAgent answers the FLAT receipt: config_version at the top level, no declared block', async () => {
  for (const name of ['create-agent', 'post-agents']) {
    const { result } = await replay(name, (c) => c.createAgent(agentInput))
    expectExactKeys(result, ['agent_id', 'computer_id', 'resolved_skills', 'config_version', 'ownership', 'resolved_environment'])
    declared<string>(result.agent_id, 'string')
    declared<number | undefined>(result.config_version, 'number')
    // The read projection's two markers are simply not here.
    expectNoKeys(result, 'declared', 'status', 'environment_locked')
    declared<Ownership | undefined>(result.ownership, 'object')
    expectKinds(result.ownership, { owner_uid: 'string', org_id: 'string' })
  }
})

test('getAgent answers the OTHER projection: config_version moves under status and declared appears', async () => {
  for (const name of ['get-agent', 'get-agents-id']) {
    const { result } = await replay(name, (c) => c.getAgent(AGENT))
    expectExactKeys(result, [
      'agent_id',
      'computer_id',
      'ownership',
      'declared',
      'labels',
      'resolved_skills',
      'resolved_environment',
      'environment_locked',
      'environment_locked_at',
      'bootstrap_state',
      'status',
    ])
    // THE PROJECTION SPLIT: the create receipt's top-level version is gone here, and the read's
    // `declared` block is absent there. The documented read handles both.
    expectNoKeys(result, 'config_version')
    declared<Record<string, unknown> | undefined>(result.declared, 'object')
    expect(result.status?.config_version ?? result.config_version).toBe(3)
  }
})

test('getAgent parks actual_state at activating while desired_state already says running', async () => {
  const { result } = await replay('get-agent-locked', (c) => c.getAgent(AGENT))
  // The readiness trap this SDK exists to prevent, as data: an API-only agent is fully usable
  // (`desired_state: running`) while `actual_state` — chat-channel health — never leaves
  // `activating`, and `channels.expected` is 0 because there are no channels to connect.
  declared<string | undefined>(result.status?.desired_state, 'string')
  expect(result.status?.desired_state).toBe('running')
  expect(result.status?.actual_state).toBe('activating')
  expect(result.status?.channels?.expected).toBe(0)
  expect(result.status?.actual_state).not.toBe('running')
  declared<boolean | undefined>(result.environment_locked, 'boolean')
  expect(result.environment_locked).toBe(true)
  declared<string | null | undefined>(result.environment_locked_at, 'string')
})

test('getAgent on a never-warmed agent reports environment_locked_at as null, not absent', async () => {
  const { result } = await replay('get-agent-unlocked', (c) => c.getAgent(COLD_AGENT))
  expect(result.environment_locked).toBe(false)
  // `null`, and the key IS there — a caller testing `if (agent.environment_locked_at)` is fine,
  // one testing `'environment_locked_at' in agent` learns nothing.
  declared<string | null | undefined>(result.environment_locked_at, 'null')
  expect(result.environment_locked_at).toBe(holds<AgentRecord['environment_locked_at']>(null))
  expect('environment_locked_at' in result).toBe(true)
  expect(result.status?.desired_state).toBe('stopped')
})

test('startAgent reports channel_routes_reload_failed as a warning, not a failure', async () => {
  const { result } = await replay('post-agents-id-start', (c) => c.startAgent(AGENT))
  expectExactKeys(result, ['warnings'])
  expect(result.warnings).toHaveLength(1)
  expect(result.warnings[0]).toContain('channel_routes_reload_failed')
})

test('deleteAgent answers 204 with no body at all', async () => {
  const fx = fixture('delete-agents-id')
  expect(fx.status).toBe(204)
  expect(fx.body).toBeNull()
  const { client } = stub(fx)
  await expect(client.deleteAgent(COLD_AGENT)).resolves.toBeUndefined()
})

// ── error envelopes ────────────────────────────────────────────────────────

test('the agents family answers a DIFFERENT error envelope — {code, detail}, not {error:{type,message}}', async () => {
  const err = await replayError('error-404-agent-not-found', (c) => c.getAgent('agt_01000000000000000000000000'))
  const raw = fixture('error-404-agent-not-found').body as Record<string, unknown>
  expectExactKeys(raw, ['code', 'detail'])
  expectNoKeys(raw, 'error')
  // The SDK reads BOTH envelopes, so `type` is usable on this family too. Note the vocabulary
  // differs: this family answers dotted `service_api.*` codes, the sessions family answers bare
  // ones. Match on what you find; do not assume one spelling.
  expect(err.status).toBe(404)
  expect(err.type).toBe('service_api.not_found')
  expect(err.message).toBe('Not found')
})

test('the sessions family answers the {error:{type,message}} envelope', async () => {
  const err = await replayError('error-404-session-not-found', (c) => c.getSession(AGENT, MISSING_SESSION))
  expect(err).toBeInstanceOf(ZooclawError)
  expect(err.status).toBe(404)
  expect(err.type).toBe('not_found')
  expect(err.message).toBe('session not found')
})

test('createAgent against a still-building environment version is 409 environment_not_ready', async () => {
  const err = await replayError('error-409-environment-not-ready', (c) => c.createAgent(agentInput))
  expect(err.status).toBe(409)
  // The pair to the `latest_version` / `latest_ready_version` trap below: pin the wrong number and
  // this is what you get.
  expect(err.type).toBe('environment_not_ready')
})

test('postEvents to an archived session is 409 session_archived', async () => {
  const err = await replayError('error-409-session-archived', (c) => c.postEvents(AGENT, SESSION, [{ type: 'user.message' }]))
  expect(err.status).toBe(409)
  expect(err.type).toBe('session_archived')
})

test('a raw getSchedule round trip is 400, and the 400 names the server-derived fields', async () => {
  const err = await replayError('error-400-schedule-server-derived-fields', (c) =>
    // Cast because the four fields are compile errors by design — this reproduces what a
    // JavaScript caller (or a cast) would send, which is the body the server refused.
    c.updateSchedule(AGENT, SCHEDULE, { enabled: false } as Record<string, unknown>),
  )
  expect(err.status).toBe(400)
  expect(err.type).toBe('invalid_request')
  for (const field of ['execution', 'originMetadata', 'creatorPrincipalRef', 'contextSnapshot']) {
    expect(err.message).toContain(field)
  }
})

// ── sessions ───────────────────────────────────────────────────────────────

test('createSession answers a receipt with status, and no run_status', async () => {
  for (const name of ['create-session', 'post-agents-id-sessions']) {
    const { result } = await replay(name, (c) => c.createSession(AGENT, {}))
    expectExactKeys(result, ['session_id', 'session_key', 'status', 'created_at'])
    // The receipt is the ONE surface where `status` carries something: `running`. Every later read
    // of the same session answers `status: null` — see the next test.
    expect(result.status).toBe('running')
    expectNoKeys(result, 'run_status', 'channel', 'archived')
    expect(result.session_key).toBe(`api:${result.session_id}`)
  }
})

test('getSession answers status: null — the outcome is on run_status', async () => {
  const { result } = await replay('get-session', (c) => c.getSession(AGENT, SESSION))
  expectExactKeys(result, [
    'session_id',
    'session_key',
    'channel',
    'run_status',
    'updated_at',
    'metadata',
    'archived',
    'status',
    'pending_approvals',
    'entry',
  ])
  // The bug in one line: `status` is present, null, and useless; the answer is next to it.
  declared<string | null | undefined>(result.status, 'null')
  expect(result.status).toBe(holds<SessionRecord['status']>(null))
  declared<string | undefined>(result.run_status, 'string')
  expect(result.run_status).toBe('succeeded')
  declared<boolean | undefined>(result.archived, 'boolean')
})

test('getSession also sends pending_approvals and entry, which SessionRecord does not name', async () => {
  const { result, raw } = await replay('get-session', (c) => c.getSession(AGENT, SESSION))
  // Not a defect — the index signature is what carries them — but they are real, and the JSDoc
  // claim that `run_status` is list-only is wrong: it is on both surfaces.
  expectKinds(raw, { pending_approvals: 'number', entry: 'object', run_status: 'string' })
  expect(result.pending_approvals).toBe(0)
})

test('getSession omits history entirely unless you ask for it', async () => {
  const { result: without } = await replay('get-session', (c) => c.getSession(AGENT, SESSION))
  expectNoKeys(without, 'history')

  const { result: with_, path } = await replay('get-session-with-history', (c) =>
    c.getSession(AGENT, SESSION, { history: true, limit: 20 }),
  )
  expect(path).toContain('history=true')
  const history = declared<SessionHistoryEntry[] | undefined>(with_.history, 'array')!
  expect(history).toHaveLength(2)
  expectExactKeys(history[0], ['seq', 'entry_type', 'entry', 'created_at'])
  expectKinds(history[0], { seq: 'number', entry_type: 'string', entry: 'object', created_at: 'string' })
  // The at-rest transcript, not the event log: the text is under `entry.message`.
  expect(history[0]!.entry_type).toBe('message')
  const message = history[0]!.entry.message as { role: string; content: { type: string; text?: string }[] }
  expect(message.role).toBe('user')
  expect(message.content[0]!.text).toContain('SURFACE-PROBE-MARKER')
})

test('listSessions rows carry run_status and have NO status key at all', async () => {
  const { result } = await replay('list-sessions', (c) => c.listSessions(AGENT))
  expect(result).toHaveLength(2)
  for (const row of result) {
    expectExactKeys(row, ['session_id', 'session_key', 'channel', 'run_status', 'updated_at', 'metadata', 'archived'])
    // Reading `status` off a list row gets you `undefined`, not the outcome.
    expectNoKeys(row, 'status', 'pending_approvals', 'entry', 'history')
    expect(row.run_status).toBe('succeeded')
  }
})

test('a cron-fired session is recognisable by channel and session_key, not by a schedule field', async () => {
  const { result } = await replay('list-sessions', (c) => c.listSessions(AGENT))
  const cron = result.find((s) => s.channel === 'cron')!
  expect(cron).toBeDefined()
  // The only link back to the schedule that fired it — no run row carries a session_id, so this
  // prefix match is the whole walk from schedule to session.
  expect(cron.session_key).toMatch(new RegExp(`^agent:${AGENT}:cron:${SCHEDULE}:`))
  expect(result.find((s) => s.channel === 'api')!.session_key).toBe(`api:${SESSION}`)
})

test('listSessions reports run_status: running while a turn is still in flight', async () => {
  const { result } = await replay('get-agents-id-sessions', (c) => c.listSessions(AGENT))
  expect(result[0]!.run_status).toBe('running')
})

test('a session read after archiveSession still answers, with archived: true', async () => {
  const { result: receipt } = await replay('archive-session', (c) => c.archiveSession(AGENT, SESSION))
  expectExactKeys(receipt, ['session_id', 'archived'])
  expect(receipt.archived).toBe(true)

  const { result: after } = await replay('get-agents-id-sessions-id', (c) => c.getSession(AGENT, SESSION))
  // Archiving closes WRITES (409 session_archived), not reads.
  expect(after.archived).toBe(true)
  expect(after.run_status).toBe('succeeded')
})

test('deleteSession answers 204 with no body', async () => {
  const fx = fixture('delete-agents-id-sessions-id')
  expect(fx.status).toBe(204)
  expect(fx.body).toBeNull()
  const { client } = stub(fx)
  await expect(client.deleteSession(AGENT, MISSING_SESSION)).resolves.toBeUndefined()
})

// ── events ─────────────────────────────────────────────────────────────────

test('REST event rows are snake_case, and normalizeEvent folds them into the camelCase shape', async () => {
  for (const name of ['list-events', 'get-agents-id-sessions-id-events']) {
    const { result, raw } = await replay(name, (c) => c.listEvents(AGENT, SESSION))
    const wire = (raw.events as Record<string, unknown>[])[0]!
    // THE WIRE, as recorded: snake_case, and no top-level `type`.
    expectExactKeys(wire, ['seq', 'run_id', 'turn', 'event_type', 'payload', 'created_at'])
    expectNoKeys(wire, 'eventType', 'runId', 'createdAt', 'type')

    // What the caller is promised instead.
    const first: SessionEvent = result[0]!
    expectExactKeys(first, ['seq', 'eventType', 'payload', 'runId', 'turn', 'createdAt'])
    expectKinds(first, { seq: 'number', eventType: 'string', payload: 'object', runId: 'string', turn: 'number', createdAt: 'string' })
    expect(first.eventType).toBe('run.started')
    expect(result.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(result[result.length - 1]!.eventType).toBe('run.finished')
    expect(result[result.length - 1]!.payload.status).toBe('succeeded')
  }
})

// ── skills ─────────────────────────────────────────────────────────────────

test('uploadSkill answers latest_version as the STRING "1"', async () => {
  const { result } = await replay('upload-skill', (c) => c.uploadSkill(new Blob(['z']), { scope: 'org' }))
  expectExactKeys(result, [
    'skill_id',
    'scope',
    'pack_id',
    'name',
    'description',
    'latest_version',
    'status',
    'created_by',
    'created_at',
    'updated_at',
    'ownership',
  ])
  // A number everywhere else, a string here. `=== 1` is false; `Number(...)` or a loose compare.
  declared<number | string | null | undefined>(result.latest_version, 'string')
  expect(result.latest_version).toBe(holds<SkillRecord['latest_version']>('1'))
  expect(Number(result.latest_version)).toBe(1)
})

test('an org-scope skill answers ownership.owner_uid: null — it belongs to the org, not a person', async () => {
  const { result } = await replay('upload-skill', (c) => c.uploadSkill(new Blob(['z']), { scope: 'org' }))
  // `Ownership` requires both as strings; `SkillRecord.ownership` is deliberately looser, and this
  // is why. Typing it as `Ownership` made every org-scope skill a lie.
  expectKinds(result.ownership, { owner_uid: 'null', org_id: 'string' })
  declared<string | null | undefined>(result.ownership?.owner_uid, 'null')
  // The type has to be able to HOLD the recording. `Ownership` — both fields required strings —
  // cannot, and typing it that way is what made every org-scope skill a lie.
  expect(result.ownership).toEqual(holds<SkillRecord['ownership']>({ owner_uid: null, org_id: 'ORG10000000000000000000000000000' }))
})

test('a global catalog skill answers BOTH ownership fields as null', async () => {
  const { result, raw } = await replay('list-skills', (c) => c.listSkills())
  // The catalog size DRIFTS as global skills get added (22 → 24 between recordings); assert the
  // unwrap against the recording itself, never a pinned count.
  expect(result).toHaveLength((raw.skills as unknown[]).length)
  const global = result.find((s) => s.scope === 'global')!
  expectKinds(global.ownership, { owner_uid: 'null', org_id: 'null' })
  expect(global.latest_version).toBe('1')
})

test('listSkills({ q }) narrows to the matching row and keeps the same shape', async () => {
  const { result, path } = await replay('get-skills', (c) => c.listSkills({ q: 'sdk-surface-probe-skill' }))
  expect(path).toBe('/skills?q=sdk-surface-probe-skill')
  expect(result).toHaveLength(1)
  expect(result[0]!.scope).toBe('org')
  expect(result[0]!.name).toBe('sdk-surface-probe-skill')
})

test('listAgentSkills rows are a DIFFERENT shape from a registry SkillRecord', async () => {
  const { result, raw } = await replay('list-agent-skills', (c) => c.listAgentSkills(AGENT))
  // The attached count follows the global catalog and DRIFTS between recordings.
  expect(result).toHaveLength((raw.skills as unknown[]).length)
  const row = result[0]!
  // The resolved/merged view: file manifest, base path, content hash — and no `latest_version`,
  // `created_at` or `ownership` from the registry row.
  expectExactKeys(row, [
    'name',
    'files',
    'scope',
    'version',
    'basePath',
    'eligible',
    'location',
    'skill_id',
    'contentHash',
    'description',
    'promptVersion',
  ])
  expectNoKeys(row, 'latest_version', 'ownership', 'created_at', 'status')
  declared<number | string | undefined>(row.version, 'string')
  // The probe's own upload is the row whose version is knowable: version 1, spelled "1".
  const probeRow = result.find((s) => s.name === 'sdk-surface-probe-skill')!
  expect(probeRow.version).toBe(holds<AgentSkill['version']>('1'))
  declared<{ path: string }[] | undefined>(row.files, 'array')
  expectKinds(row.files?.[0], { path: 'string', size: 'number', sha256: 'string' })
})

test('deleteAgentSkill removes exactly the one row', async () => {
  const { result: before } = await replay('list-agent-skills', (c) => c.listAgentSkills(AGENT))
  const { result: after } = await replay('list-agent-skills-after-detach', (c) => c.listAgentSkills(AGENT))
  // Absolute counts drift with the global catalog; the DELTA is the assertion. The probe skill
  // is found by its scrub-stable NAME — its minted id number follows the catalog size.
  expect(before.length - after.length).toBe(1)
  expect(before.some((s) => s.name === 'sdk-surface-probe-skill')).toBe(true)
  expect(after.some((s) => s.name === 'sdk-surface-probe-skill')).toBe(false)
})

test('putAgentSkill and deleteAgentSkill answer the same {config_version, warnings} receipt', async () => {
  const { result: attached } = await replay('put-agent-skill', (c) => c.putAgentSkill(AGENT, SKILL))
  expectExactKeys(attached, ['config_version', 'warnings'])
  expectKinds(attached, { config_version: 'number', warnings: 'array' })
  expect(attached.config_version).toBe(4)

  // deleteAgentSkill resolves to void, so the shape is asserted on the recorded body: the route
  // answers 200 with a receipt, not 204, and the version bumps again.
  const detached = fixture('delete-agents-id-skills-id')
  expect(detached.status).toBe(200)
  expectExactKeys(detached.body, ['config_version', 'warnings'])
  expect((detached.body as { config_version: number }).config_version).toBe(5)
})

test('deleteSkill answers 204 with no body', async () => {
  const fx = fixture('delete-skills-id')
  expect(fx.status).toBe(204)
  expect(fx.body).toBeNull()
  const { client } = stub(fx)
  await expect(client.deleteSkill(SKILL)).resolves.toBeUndefined()
})

// ── schedules ──────────────────────────────────────────────────────────────

test('createSchedule answers ONLY schedule_name, and it is fully qualified', async () => {
  const { result } = await replay('create-schedule', (c) =>
    c.createSchedule(AGENT, { schedule_id: SCHEDULE, schedule: { kind: 'cron', expr: '0 9 * * *' }, payload: { kind: 'agentTurn' } }),
  )
  expectExactKeys(result, ['schedule_name'])
  // Not the definition, and not the id you passed — read it back if you need either.
  expect(result.schedule_name).toBe(`cron/cmp_COMPUTER100000000000000000/${AGENT}/${SCHEDULE}`)
  expectNoKeys(result, 'scheduleId', 'name', 'schedule', 'scheduleSpec', 'payload')
})

test('getSchedule sends NEITHER schedule NOR sessionTarget — the cadence is scheduleSpec.cronExpressions[0]', async () => {
  const { result } = await replay('get-schedule', (c) => c.getSchedule(AGENT, SCHEDULE))
  expectExactKeys(result, [
    'scheduleId',
    'computerId',
    'agentId',
    'apiAgentId',
    'name',
    'jobKind',
    'execution',
    'originMetadata',
    'contextSnapshot',
    'scheduleSpec',
    'payload',
    'delivery',
    'origin',
    'enabled',
    'deleteAfterRun',
    'consecutiveErrors',
    'createdAt',
    'updatedAt',
  ])
  // BUG #1, both halves. Nothing you sent comes back under the name you sent it: there is no
  // `schedule` key and no `sessionTarget` key on any read, so `record.schedule.expr` was undefined.
  expectNoKeys(result, 'schedule', 'sessionTarget')
  const spec = declared<{ cronExpressions?: string[]; timezoneName?: string } | undefined>(result.scheduleSpec, 'object')!
  expect(spec.cronExpressions).toEqual(['0 9 * * *'])
  expect(spec.timezoneName).toBe('Asia/Singapore')
  // …and the target is `execution.kind`.
  declared<{ kind?: string } | undefined>(result.execution, 'object')
  expect(result.execution?.kind).toBe('isolated')
  declared<SchedulePayload | undefined>(result.payload, 'object')
})

test('getSchedule scheduleId is the FQN; the id you chose is name', async () => {
  const { result } = await replay('get-schedule', (c) => c.getSchedule(AGENT, SCHEDULE))
  declared<string | undefined>(result.scheduleId, 'string')
  expect(result.scheduleId).toBe(`cron/cmp_COMPUTER100000000000000000/${AGENT}/${SCHEDULE}`)
  // Passing `scheduleId` back to get/update/delete builds a nonsense path. `name` is the one.
  declared<string | undefined>(result.name, 'string')
  expect(result.name).toBe(SCHEDULE)
})

test('updateSchedule answers the create-style receipt, not the updated record', async () => {
  const { result } = await replay('put-agents-id-schedules-id', (c) => c.updateSchedule(AGENT, SCHEDULE, { enabled: false }))
  expectExactKeys(result, ['schedule_name'])
  expectNoKeys(result, 'scheduleSpec', 'enabled')
})

test('a PUT carrying scheduleSpec answers 200 and changes nothing — the response cannot tell you', async () => {
  // BUG #3. Byte-identical to the receipt above, which is exactly the problem: a caller echoing
  // back the `scheduleSpec` they just read gets a 200 that looks like every successful update,
  // while the cadence keeps its old value. Only a follow-up read shows it.
  const noop = fixture('put-schedule-schedulespec-silent-noop')
  expect(noop.status).toBe(200)
  expect(noop.body).toEqual(fixture('put-agents-id-schedules-id').body)

  const { result: after } = await replay('get-agents-id-schedules-id', (c) => c.getSchedule(AGENT, SCHEDULE))
  // The cadence that DID apply came from a `schedule: {kind:'cron',expr}` body — the input
  // vocabulary — and reads back as `30 9 * * *`.
  expect(after.scheduleSpec?.cronExpressions).toEqual(['30 9 * * *'])
})

test('listSchedules merges the raw Temporal describe with the camelCase projection', async () => {
  const { result } = await replay('list-schedules', (c) => c.listSchedules(AGENT))
  expect(result).toHaveLength(1)
  const row = result[0]!
  // A THIRD vocabulary: not the create receipt, not the single-schedule read.
  expectExactKeys(row, ['schedule_name', 'spec', 'state', 'memo', 'next_action_times', 'scheduleSpec', 'payload', 'delivery', 'enabled'])
  expectNoKeys(row, 'scheduleId', 'name', 'execution', 'createdAt')
  declared<Record<string, unknown> | undefined>(row.spec, 'object')
  // `state` here is Temporal's `{paused, note}`, NOT a lifecycle state and unrelated to `enabled`.
  declared<{ paused?: boolean } | undefined>(row.state, 'object')
  expect(row.state?.paused).toBe(false)
  expect(row.enabled).toBe(true)
  // On this projection your own id is at `memo.schedule_id`.
  expect(row.memo?.schedule_id).toBe(SCHEDULE)
  declared<string[] | undefined>(row.next_action_times, 'array')
  expect(row.next_action_times).toHaveLength(5)
})

test('listSchedules answers an empty array once the schedule is deleted', async () => {
  const { result } = await replay('get-agents-id-schedules', (c) => c.listSchedules(AGENT))
  expect(result).toEqual([])
})

test('triggerSchedule answers {schedule_name, triggered}', async () => {
  const { result } = await replay('trigger-schedule', (c) => c.triggerSchedule(AGENT, SCHEDULE))
  expectExactKeys(result, ['schedule_name', 'triggered'])
  expectKinds(result, { schedule_name: 'string', triggered: 'boolean' })
  expect(result.triggered).toBe(true)
})

test('triggerSchedule on a DISABLED schedule still answers triggered: true while the run is skipped', async () => {
  const { result } = await replay('trigger-schedule-disabled', (c) => c.triggerSchedule(AGENT, SCHEDULE))
  // `triggered` means "the fire was dispatched", never "the turn ran". The outcome is only in the
  // run projection, and there it says `skipped`.
  expect(result.triggered).toBe(true)
  const { result: runs } = await replay('list-schedule-runs', (c) => c.listScheduleRuns(AGENT, SCHEDULE))
  const outcome = runs.find((r) => r.source === 'run_projection')!
  expect(outcome.status).toBe('skipped')
})

test('listScheduleRuns returns ONE array with TWO row shapes, discriminated by source', async () => {
  const { result } = await replay('list-schedule-runs', (c) => c.listScheduleRuns(AGENT, SCHEDULE))
  expect(result).toHaveLength(3)

  // BUG #4. An outcome row…
  const projection = result.find((r) => r.source === 'run_projection')!
  expectExactKeys(projection, ['source', 'schedule_id', 'fired_at', 'status', 'consecutive_errors'])
  expectKinds(projection, { source: 'string', schedule_id: 'string', fired_at: 'string', status: 'string', consecutive_errors: 'number' })
  declared<string | undefined>(projection.status, 'string')

  // …and a dispatch row, which shares only `source` with it.
  const temporal = result.find((r) => r.source === 'temporal')!
  expectExactKeys(temporal, ['source', 'scheduled_at', 'taken_at', 'workflow_id', 'temporal_run_id'])
  expectNoKeys(temporal, 'status', 'fired_at', 'consecutive_errors')
  declared<string | undefined>(temporal.workflow_id, 'string')

  // NEITHER carries a session_id, on either shape. There is no walk from a fire to its session.
  for (const row of result) expectNoKeys(row, 'session_id', 'run_id')
})

test('listScheduleRuns rows are GROUPED BY SOURCE, not sorted by time — runs[0] is not the latest fire', async () => {
  const { result } = await replay('get-agents-id-schedules-id-runs', (c) => c.listScheduleRuns(AGENT, SCHEDULE, { limit: 20 }))
  expect(result.map((r) => r.source)).toEqual(['run_projection', 'temporal'])
  // The projection row fired BEFORE the dispatch row that follows it, so reading the array as one
  // reverse-chronological list is wrong.
  expect(Date.parse(result[0]!.fired_at!)).toBeLessThan(Date.parse(result[1]!.scheduled_at!))
})

test('deleteSchedule answers 204 with no body', async () => {
  const fx = fixture('delete-agents-id-schedules-id')
  expect(fx.status).toBe(204)
  expect(fx.body).toBeNull()
  const { client } = stub(fx)
  await expect(client.deleteSchedule(AGENT, SCHEDULE)).resolves.toBeUndefined()
})

// ── environments ───────────────────────────────────────────────────────────

const ENVIRONMENT_KEYS = [
  'environment_id',
  'scope',
  'org_id',
  'name',
  'description',
  'status',
  'latest_version',
  'latest_ready_version',
  'created_by',
  'created_at',
  'updated_at',
  'archived_at',
]

test('an Environment has status and a FLAT scope/org_id — there is no state and no ownership', async () => {
  const { result } = await replay('get-environment', (c) => c.getEnvironment(ENVIRONMENT))
  expectExactKeys(result, ENVIRONMENT_KEYS)
  // BUG #5, all three halves.
  expectNoKeys(result, 'state', 'ownership')
  declared<string | undefined>(result.status, 'string')
  expect(result.status).toBe('active')
  declared<string | undefined>(result.scope, 'string')
  declared<string | undefined>(result.org_id, 'string')
})

test('createEnvironment answers latest_version: 1 while latest_ready_version is still null', async () => {
  const { result } = await replay('create-environment', (c) => c.createEnvironment(envInput))
  expectExactKeys(result, [...ENVIRONMENT_KEYS, 'version'])
  // THE TWO NUMBERS ARE NOT THE SAME NUMBER. Pin `latest_version` here and createAgent answers
  // 409 environment_not_ready, because version 1 is still `queued`.
  declared<number | null | undefined>(result.latest_version, 'number')
  expect(result.latest_version).toBe(1)
  declared<number | null | undefined>(result.latest_ready_version, 'null')
  expect(result.latest_ready_version).toBe(holds<EnvironmentRecord['latest_ready_version']>(null))
  expect(result.version?.status).toBe('queued')
})

test('getEnvironmentVersion has status and NO state — polling `state === "ready"` never terminates', async () => {
  const { result } = await replay('get-environment-version-building', (c) => c.getEnvironmentVersion(ENVIRONMENT, 1))
  expectExactKeys(result, [
    'environment_id',
    'version',
    'status',
    'config',
    'base_environment_id',
    'base_version',
    'source_hash',
    'spec_hash',
    'e2b_template_name',
    'e2b_template_id',
    'e2b_build_id',
    'template_ref',
    'base_template_ref',
    'failure_stage',
    'failure_message',
    'created_by',
    'created_at',
    'ready_at',
  ])
  // BUG #6, the infinite loop. `state` is not merely wrong here, it is ABSENT — so a loop written
  // against it compares `undefined` to `'ready'` for as long as the process lives.
  expectNoKeys(result, 'state')
  declared<string | undefined>(result.status, 'string')
  expect(result.status).toBe('building')
})

test('a version can carry e2b_build_id while still building — build_id is not a readiness signal', async () => {
  const { result } = await replay('get-environment-version-building', (c) => c.getEnvironmentVersion(ENVIRONMENT, 1))
  expectKinds(result, { status: 'string', e2b_build_id: 'string', template_ref: 'null', ready_at: 'null' })
  expect(result.template_ref).toBe(holds<EnvironmentVersionRecord['template_ref']>(null))
  expect(result.ready_at).toBe(holds<EnvironmentVersionRecord['ready_at']>(null))
  // `status === 'ready'` is the only signal. `template_ref` and `ready_at` follow it; `e2b_build_id`
  // does not wait for it.
  expect(result.status).not.toBe('ready')
})

test('listEnvironments rows keep latest_ready_version after archiving', async () => {
  const { result, raw } = await replay('list-environments', (c) => c.listEnvironments())
  // The org accretes archived probe Environments between recordings; count against the recording.
  expect(result).toHaveLength((raw.environments as unknown[]).length)
  for (const row of result) expectExactKeys(row, ENVIRONMENT_KEYS)
  // The point: archiving does not null the build lineage out. At least one archived row still
  // carries a numeric latest_ready_version and its archive stamp.
  const archived = result.find((r) => r.status === 'archived' && typeof r.latest_ready_version === 'number')!
  expect(archived).toBeDefined()
  expectKinds(archived, { latest_version: 'number', latest_ready_version: 'number', archived_at: 'string' })
})

test('archiveEnvironment percent-encodes the colon and flips status to archived', async () => {
  // The archived id's scrub number follows how many environments the recording saw first, so it
  // is read off the fixture instead of pinned.
  const recordedPath = fixture('archive-environment').path
  const archivedId = recordedPath.slice('/environments/'.length).replace(/%3Aarchive$/, '')
  const { result, path, method } = await replay('archive-environment', (c) => c.archiveEnvironment(archivedId))
  // The route quirk and its response, pinned together: a raw `:` here is a 404.
  expect(method).toBe('POST')
  expect(path).toBe(`/environments/${archivedId}%3Aarchive`)
  expect(path).not.toContain(':')
  expect(path).toBe(recordedPath)
  expect(result.status).toBe('archived')
  declared<string | null | undefined>(result.archived_at, 'string')
})

// ── models, exec, wake, approvals ──────────────────────────────────────────

test('listModels answers a BARE array, not a {models} envelope', async () => {
  const { result, raw } = await replay('list-models', (c) => c.listModels())
  expect(Array.isArray(raw)).toBe(true)
  expect(result).toHaveLength(27)
  expectExactKeys(result[0], ['model', 'display_name', 'family', 'api'])
  expectKinds(result[0], { model: 'string', display_name: 'string', family: 'string', api: 'string' })
})

test('exec resolves on a non-zero exit — a failed command is not a failed call', async () => {
  const { result: ok } = await replay('exec-exit-0', (c) => c.exec(AGENT, ['bash', '-lc', 'pwd']))
  expectExactKeys(ok, ['exit_code', 'stdout', 'stderr'])
  expectKinds(ok, { exit_code: 'number', stdout: 'string', stderr: 'string' })
  expect(ok.exit_code).toBe(0)
  expect(ok.stdout).toContain('/workspace')

  const { result: failed } = await replay('exec-exit-7', (c) => c.exec(AGENT, ['bash', '-lc', 'exit 7']))
  // HTTP 200 with exit_code 7. It resolves; check the number.
  expect(fixture('exec-exit-7').status).toBe(200)
  expect(failed.exit_code).toBe(7)
})

test('wake answers {mode, queued, triggered} and triggered is false on next-heartbeat', async () => {
  const { result } = await replay('wake', (c) => c.wake(AGENT, { text: 'ping' }))
  expectExactKeys(result, ['mode', 'queued', 'triggered'])
  expectKinds(result, { mode: 'string', queued: 'boolean', triggered: 'boolean' })
  expect(result.mode).toBe('next-heartbeat')
  // Queued is not delivered: nothing consumes the row unless the agent has a heartbeat.
  expect(result.queued).toBe(true)
  expect(result.triggered).toBe(false)
})

test('listApprovals answers an empty array with and without the status filter', async () => {
  const { result: filtered, path } = await replay('list-approvals', (c) => c.listApprovals(AGENT, { status: 'pending' }))
  expect(path).toBe(`/agents/${AGENT}/approvals?status=pending`)
  expect(filtered).toEqual([])
  const { result: all } = await replay('get-agents-id-approvals', (c) => c.listApprovals(AGENT))
  expect(all).toEqual([])
  // Both recordings are empty, so the shape of an APPROVAL ROW is still unproven — which is what
  // `ApprovalRecord`'s doc comment says. Nothing here may be read as confirming those field names.
})

// ── system prompt & artifacts (0.0.6) ──────────────────────────────────────

test('getSystemPrompt answers the pin AND the effective template — a fresh agent is platform-pinned from birth', async () => {
  const { result, path } = await replay('get-system-prompt', (c) => c.getSystemPrompt(AGENT))
  expect(path).toBe(`/agents/${AGENT}/system-prompt`)
  expect(result.declaration).toEqual({ source: 'platform', version: 1 })
  const effective = result.effective as Record<string, unknown>
  expectKinds(effective, { source: 'string', templateHash: 'string', templateVersion: 'number' })
  // Platform v1 is the byte-compatible legacy PROFILE under the template machinery — `source`
  // says the pin is real while `profile` still says the assembled bytes are the legacy ones.
  expect(effective.source).toBe('platform')
  expect(effective.profile).toBe('legacy')
})

test('previewSystemPrompt assembles without a session: 13 slot hashes, transcript pinned to []', async () => {
  const { result, path, method } = await replay('preview-system-prompt', (c) =>
    c.previewSystemPrompt(AGENT, {
      config_version: 5,
      now_ms: 0,
      session_id: 's',
      model_display: 'm',
      workspace_dir: '/workspace',
      tool_names: [],
    }),
  )
  expect(method).toBe('POST')
  // RAW colon on the wire — recorded through the gateway exactly like this. (The environments
  // family needs %3A; this family is the opposite.)
  expect(path).toBe(`/agents/${AGENT}/system-prompt:preview`)
  expect(path).toBe(fixture('preview-system-prompt').path)
  declared<string | undefined>(result.system_prompt, 'string')
  expect(Object.keys(result.slot_hashes ?? {})).toHaveLength(13)
  expect(result.transcript).toEqual([])
  expectKinds(result, { char_count: 'number', config_version: 'number' })
})

test('upgradeSystemPrompt answers the new pin and the version bump it cost', async () => {
  const { result, path, method } = await replay('upgrade-system-prompt', (c) =>
    c.upgradeSystemPrompt(AGENT, { expected_config_version: 5 }),
  )
  expect(method).toBe('POST')
  // The `{id}:verb` grammar, RAW colon — reachable through the gateway since fix #3387
  // (2026-08-14); it answered the gateway's own 404 envelope until that day.
  expect(path).toBe(`/agents/${AGENT}:upgrade-system-prompt`)
  expect(path).toBe(fixture('upgrade-system-prompt').path)
  expectKinds(result, { config_version: 'number', template_hash: 'string' })
  expect(result.declaration).toEqual({ source: 'platform', version: 1 })
})

test('a stale expected_config_version is 409 config_version_changed — a real CAS, not a re-apply', async () => {
  const err = await replayError('error-409-upgrade-config-version-changed', (c) =>
    c.upgradeSystemPrompt(AGENT, { expected_config_version: 5 }),
  )
  expect(err.status).toBe(409)
  expect(err.type).toBe('config_version_changed')
})

/**
 * Artifact methods make TWO requests — the projection GET the selectors derive from, then the
 * artifact call — so their replays answer the projection from its own recorded fixture and
 * everything else from `name`. `path`/`method` describe the LAST call.
 */
async function replayArtifacts<T>(name: string, call: (client: ZooclawClient) => Promise<T>): Promise<Replayed<T>> {
  const projection = fixture('get-agents-id')
  const fx = fixture(name)
  const calls: { url: string; method: string }[] = []
  const client = createZooclawClient({
    apiKey: 'zct_test_key',
    baseUrl: BASE,
    fetch: async (input: string, init: RequestInit = {}) => {
      calls.push({ url: input, method: init.method ?? 'GET' })
      const src = input === `${BASE}/agents/${AGENT}` ? projection : fx
      return new Response(src.body === null ? null : JSON.stringify(src.body), { status: src.status })
    },
  })
  const result = await call(client)
  const last = calls[calls.length - 1]!
  return { result, raw: (fx.body ?? {}) as Record<string, unknown>, path: last.url.slice(BASE.length), method: last.method }
}

test('listArtifacts derives the selectors the engine demands and answers {artifacts, page, has_more}', async () => {
  const { result, path } = await replayArtifacts('list-artifacts', (c) => c.listArtifacts(AGENT))
  // The recorded path IS the selector rule on disk: owner_uid+org_id in the query, taken from
  // the same projection this replay answers — byte-identical to what staging received.
  expect(path).toBe(fixture('list-artifacts').path)
  expect(result.artifacts).toEqual([])
  // Unlike listEvents, THIS list says when it truncated.
  expect(result.has_more).toBe(false)
  expect(result.page).toBe(1)
})

test('the untagged warm-up recording agrees with list-artifacts byte for byte', () => {
  // The probe's cache-warming call recorded the same endpoint under its derived slug; keeping
  // the two equal means neither can drift alone.
  expect(fixture('get-agents-id-artifacts').body).toEqual(fixture('list-artifacts').body)
  expect(fixture('get-agents-id-artifacts').path).toBe(fixture('list-artifacts').path)
})

test('the artifacts route without selectors is 400 ownership_required — the ENGINE envelope', () => {
  // The SDK cannot produce this request (it always derives and sends both selectors), so the
  // recording is asserted raw. `{error:{type,message}}` — the engine's envelope, not the
  // gateway's: the request got through, and the ENGINE demanded the selectors.
  const fx = fixture('error-400-artifacts-ownership-required')
  expect(fx.status).toBe(400)
  expect(fx.body).toEqual({ error: { type: 'ownership_required', message: 'owner_uid and org_id are required' } })
  expect(fx.path.includes('owner_uid')).toBe(false)
})

test('getArtifact on an unknown id is 404 not_found (hidden, not 403)', async () => {
  const fx = fixture('error-404-artifact-not-found')
  const projection = fixture('get-agents-id')
  const client = createZooclawClient({
    apiKey: 'zct_test_key',
    baseUrl: BASE,
    fetch: async (input: string) => {
      const src = input === `${BASE}/agents/${AGENT}` ? projection : fx
      return new Response(JSON.stringify(src.body), { status: src.status })
    },
  })
  try {
    await client.getArtifact(AGENT, 'art_01000000000000000000000000')
    expect.unreachable('a nonexistent artifact resolved')
  } catch (e) {
    const err = e as ZooclawError
    expect(err).toBeInstanceOf(ZooclawError)
    expect(err.status).toBe(404)
    expect(err.type).toBe('not_found')
  }
})

// ── outcome (0.0.6) ────────────────────────────────────────────────────────

test('createSchedule with payload.outcome answers the same bare receipt as any create', async () => {
  const { result, method } = await replay('create-schedule-outcome', (c) =>
    c.createSchedule(AGENT, {
      schedule_id: 'surface-probe-outcome-schedule',
      schedule: { kind: 'cron', expr: '0 9 1 1 *', tz: 'UTC' },
      payload: {
        kind: 'agentTurn',
        message: 'x',
        outcome: { description: 'd', evaluator: { type: 'command', command: 'true' } },
      },
      sessionTarget: 'isolated',
      delivery: { mode: 'none' },
      enabled: false,
    }),
  )
  expect(method).toBe('POST')
  expectExactKeys(result, ['schedule_name'])
})

test('getSchedule reads payload.outcome back VERBATIM — stored as written, not defaulted', async () => {
  const { result } = await replay('get-schedule-outcome', (c) => c.getSchedule(AGENT, 'surface-probe-outcome-schedule'))
  expect(result.payload?.outcome).toEqual({
    publish: 'after_satisfied',
    evaluator: { type: 'command', command: 'test -s /workspace/report.md' },
    description: 'A non-empty report exists at /workspace/report.md.',
    maxIterations: 2,
  })
})

test('an agent-level outcome PUT lands in declared.outcome exactly as written — NO defaults injected', async () => {
  const { result, method } = await replay('put-agent-outcome', (c) =>
    c.updateAgent(AGENT, {
      outcome: {
        description: 'Unattended runs leave a non-empty /workspace/report.md.',
        evaluator: { type: 'command', command: 'test -s /workspace/report.md' },
      },
    }),
  )
  expect(method).toBe('PUT')
  const declaredOutcome = (result.declared as { outcome?: Record<string, unknown> } | undefined)?.outcome
  // What was written is what is stored: no publish / maxIterations defaults appear. Defaulting
  // happens at RUN time, so today's defaults are never frozen into yesterday's row.
  expect(declaredOutcome).toEqual({
    evaluator: { type: 'command', command: 'test -s /workspace/report.md' },
    description: 'Unattended runs leave a non-empty /workspace/report.md.',
  })
})

// ── declaration coverage: what the SDK promises vs what the wire carries ───
//
// The tests above assert the fields the SDK gets RIGHT. This section is the other way round: for
// each record type, every key the type declares must be carried by at least one recorded response.
// That is the assertion the eight bugs failed. `ScheduleRecord.schedule`, `SessionRecord`'s missing
// `run_status`, `EnvironmentRecord.state`, `EnvironmentVersionRecord.state` — each was a key the
// SDK promised that no real response has ever contained, and each would be red here.

/**
 * The keys a type EXPLICITLY declares, with the `[k: string]: unknown` index signature filtered
 * out — the compiler's own view of what this SDK promises for a record.
 */
type DeclaredKeys<T> = keyof { [K in keyof T as string extends K ? never : number extends K ? never : K]: unknown }

/**
 * Compile-time completeness for the lists below. Resolves to `unknown` while a list names every key
 * its type declares, and to an error-shaped tuple naming the stragglers when it does not — so
 * adding a field to an SDK type fails `pnpm typecheck`, by name, until somebody comes back here and
 * points at a recorded response that carries it.
 */
type Covered<T, K extends PropertyKey> = Exclude<DeclaredKeys<T>, K> extends never
  ? unknown
  : ['no key list covers these declared keys:', Exclude<DeclaredKeys<T>, K>]

/**
 * Both directions in one diff:
 *  - `declaredButNeverSent` — a field the SDK promises that no recorded response carries. Always
 *    empty. This is the whole class of bug this file exists for.
 *  - `sentButNotDeclared` — a field the wire carries that the type does not name. Legitimate (the
 *    index signature carries it), but it has to be listed deliberately, so a NEW server field
 *    arrives as a red test rather than as an undocumented surprise.
 */
function expectDeclarationCoverage(declared: readonly string[], sentButNotDeclared: readonly string[], bodies: unknown[]): void {
  const sent = new Set<string>()
  for (const body of bodies) for (const k of Object.keys(body as Record<string, unknown>)) sent.add(k)
  expect({
    declaredButNeverSent: declared.filter((k) => !sent.has(k)).sort(),
    sentButNotDeclared: [...sent].filter((k) => !declared.includes(k)).sort(),
  }).toEqual({ declaredButNeverSent: [], sentButNotDeclared: [...sentButNotDeclared].sort() })
}

const body = (name: string): Record<string, unknown> => fixture(name).body as Record<string, unknown>
const rows = (name: string, key: string): Record<string, unknown>[] => body(name)[key] as Record<string, unknown>[]

const AGENT_RECORD_KEYS = [
  'agent_id',
  'computer_id',
  'config_version',
  'declared',
  'resolved_skills',
  'resolved_environment',
  'environment_locked',
  'environment_locked_at',
  'status',
  'ownership',
] as const satisfies readonly DeclaredKeys<AgentRecord>[]
const _agentRecordCovered: Covered<AgentRecord, (typeof AGENT_RECORD_KEYS)[number]> = undefined

test('AgentRecord declares nothing the wire does not carry across BOTH projections', () => {
  // `config_version` only exists on the create receipt and `declared`/`status` only on the read,
  // which is why the union of the two is the unit of coverage here.
  expectDeclarationCoverage(AGENT_RECORD_KEYS, ['bootstrap_state', 'labels'], [body('create-agent'), body('get-agent')])
})

const AGENT_STATUS_KEYS = [
  'desired_state',
  'actual_state',
  'config_version',
  'render_state',
  'status_message',
  'channels',
] as const satisfies readonly DeclaredKeys<AgentStatus>[]
const _agentStatusCovered: Covered<AgentStatus, (typeof AGENT_STATUS_KEYS)[number]> = undefined

test('AgentStatus declares nothing the wire does not carry', () => {
  expectDeclarationCoverage(AGENT_STATUS_KEYS, ['render'], [body('get-agent').status, body('get-agent-unlocked').status])
})

const AGENT_SKILL_KEYS = ['skill_id', 'name', 'version', 'scope', 'eligible', 'files'] as const satisfies readonly DeclaredKeys<AgentSkill>[]
const _agentSkillCovered: Covered<AgentSkill, (typeof AGENT_SKILL_KEYS)[number]> = undefined

test('AgentSkill declares nothing the wire does not carry', () => {
  expectDeclarationCoverage(
    AGENT_SKILL_KEYS,
    ['basePath', 'contentHash', 'description', 'location', 'promptVersion'],
    rows('list-agent-skills', 'skills'),
  )
})

const SESSION_RECORD_KEYS = [
  'session_id',
  'session_key',
  'channel',
  'run_status',
  'status',
  'metadata',
  'archived',
  'updated_at',
  'history',
] as const satisfies readonly DeclaredKeys<SessionRecord>[]
const _sessionRecordCovered: Covered<SessionRecord, (typeof SESSION_RECORD_KEYS)[number]> = undefined

test('SessionRecord declares nothing the wire does not carry, on any of its three surfaces', () => {
  // `pending_approvals` and `entry` are real and unnamed; `created_at` appears on the create receipt
  // only. All three reach callers through the index signature.
  expectDeclarationCoverage(
    SESSION_RECORD_KEYS,
    ['created_at', 'entry', 'pending_approvals'],
    [body('get-session-with-history'), body('create-session'), ...rows('list-sessions', 'sessions')],
  )
})

const SESSION_HISTORY_KEYS = ['seq', 'entry_type', 'entry', 'created_at'] as const satisfies readonly DeclaredKeys<SessionHistoryEntry>[]
const _sessionHistoryCovered: Covered<SessionHistoryEntry, (typeof SESSION_HISTORY_KEYS)[number]> = undefined

test('SessionHistoryEntry declares nothing the wire does not carry', () => {
  expectDeclarationCoverage(SESSION_HISTORY_KEYS, [], body('get-session-with-history').history as unknown[])
})

const SKILL_RECORD_KEYS = [
  'skill_id',
  'scope',
  'name',
  'description',
  'latest_version',
  'status',
  'pack_id',
  'created_by',
  'created_at',
  'updated_at',
  'ownership',
] as const satisfies readonly DeclaredKeys<SkillRecord>[]
const _skillRecordCovered: Covered<SkillRecord, (typeof SKILL_RECORD_KEYS)[number]> = undefined

test('SkillRecord declares nothing the wire does not carry', () => {
  expectDeclarationCoverage(SKILL_RECORD_KEYS, [], [body('upload-skill'), ...rows('list-skills', 'skills')])
})

const SCHEDULE_RECORD_KEYS = [
  'scheduleId',
  'name',
  'computerId',
  'agentId',
  'apiAgentId',
  'schedule_name',
  'scheduleSpec',
  'execution',
  'payload',
  'jobKind',
  'delivery',
  'enabled',
  'deleteAfterRun',
  'originMetadata',
  'contextSnapshot',
  'origin',
  'consecutiveErrors',
  'createdAt',
  'updatedAt',
  'spec',
  'state',
  'memo',
  'next_action_times',
] as const satisfies readonly DeclaredKeys<ScheduleRecord>[]
const _scheduleRecordCovered: Covered<ScheduleRecord, (typeof SCHEDULE_RECORD_KEYS)[number]> = undefined

test('ScheduleRecord declares nothing the wire does not carry — and `schedule` is not among its keys', () => {
  // BUG #1's regression guard. `schedule` and `sessionTarget` are the write vocabulary; if either
  // is ever re-added to this READ type, it lands in the list above and `declaredButNeverSent` goes
  // red, because no recorded response has ever carried them.
  expectDeclarationCoverage(SCHEDULE_RECORD_KEYS, [], [body('get-schedule'), body('create-schedule'), ...rows('list-schedules', 'schedules')])
  expect(SCHEDULE_RECORD_KEYS).not.toContain('schedule')
  expect(SCHEDULE_RECORD_KEYS).not.toContain('sessionTarget')
})

const SCHEDULE_RUN_KEYS = [
  'source',
  'schedule_id',
  'fired_at',
  'status',
  'consecutive_errors',
  'scheduled_at',
  'taken_at',
  'workflow_id',
  'temporal_run_id',
] as const satisfies readonly DeclaredKeys<ScheduleRun>[]
const _scheduleRunCovered: Covered<ScheduleRun, (typeof SCHEDULE_RUN_KEYS)[number]> = undefined

test('ScheduleRun declares nothing the wire does not carry, across both row shapes', () => {
  expectDeclarationCoverage(SCHEDULE_RUN_KEYS, [], rows('list-schedule-runs', 'runs'))
})

const ENVIRONMENT_RECORD_KEYS = [
  'environment_id',
  'name',
  'description',
  'scope',
  'org_id',
  'status',
  'latest_version',
  'latest_ready_version',
  'created_by',
  'created_at',
  'updated_at',
  'archived_at',
  'version',
] as const satisfies readonly DeclaredKeys<EnvironmentRecord>[]
const _environmentRecordCovered: Covered<EnvironmentRecord, (typeof ENVIRONMENT_RECORD_KEYS)[number]> = undefined

test('EnvironmentRecord declares nothing the wire does not carry — no `state`, no `ownership`', () => {
  expectDeclarationCoverage(ENVIRONMENT_RECORD_KEYS, [], [body('create-environment'), body('get-environment'), ...rows('list-environments', 'environments')])
})

const ENVIRONMENT_VERSION_KEYS = [
  'environment_id',
  'version',
  'status',
  'config',
  'base_environment_id',
  'base_version',
  'source_hash',
  'spec_hash',
  'e2b_template_name',
  'e2b_template_id',
  'e2b_build_id',
  'template_ref',
  'base_template_ref',
  'failure_stage',
  'failure_message',
  'created_by',
  'created_at',
  'ready_at',
] as const satisfies readonly DeclaredKeys<EnvironmentVersionRecord>[]
const _environmentVersionCovered: Covered<EnvironmentVersionRecord, (typeof ENVIRONMENT_VERSION_KEYS)[number]> = undefined

test('EnvironmentVersionRecord declares nothing the wire does not carry — this is where `state` died', () => {
  // BUG #6's regression guard, and the sharpest one: re-adding `state` here means adding it to the
  // list above (nothing else compiles), and then no recorded version response carries it.
  expectDeclarationCoverage(ENVIRONMENT_VERSION_KEYS, [], [body('get-environment-version-building'), body('create-environment').version])
  expect(ENVIRONMENT_VERSION_KEYS).not.toContain('state')
})

const MODEL_INFO_KEYS = ['model', 'display_name', 'family', 'api'] as const satisfies readonly DeclaredKeys<ModelInfo>[]
const _modelInfoCovered: Covered<ModelInfo, (typeof MODEL_INFO_KEYS)[number]> = undefined

test('ModelInfo declares nothing the wire does not carry', () => {
  expectDeclarationCoverage(MODEL_INFO_KEYS, [], fixture('list-models').body as unknown[])
})

const SYSTEM_PROMPT_INFO_KEYS = ['agent_id', 'config_version', 'declaration', 'effective'] as const satisfies readonly DeclaredKeys<SystemPromptInfo>[]
const _systemPromptInfoCovered: Covered<SystemPromptInfo, (typeof SYSTEM_PROMPT_INFO_KEYS)[number]> = undefined

test('SystemPromptInfo declares nothing the wire does not carry', () => {
  expectDeclarationCoverage(SYSTEM_PROMPT_INFO_KEYS, [], [body('get-system-prompt')])
})

const SYSTEM_PROMPT_PREVIEW_KEYS = ['agent_id', 'config_version', 'system_prompt', 'char_count', 'slot_hashes', 'transcript'] as const satisfies readonly DeclaredKeys<SystemPromptPreview>[]
const _systemPromptPreviewCovered: Covered<SystemPromptPreview, (typeof SYSTEM_PROMPT_PREVIEW_KEYS)[number]> = undefined

test('SystemPromptPreview declares nothing the wire does not carry', () => {
  expectDeclarationCoverage(SYSTEM_PROMPT_PREVIEW_KEYS, [], [body('preview-system-prompt')])
})

const ARTIFACT_PAGE_KEYS = ['artifacts', 'page', 'has_more'] as const satisfies readonly DeclaredKeys<ArtifactPage>[]
const _artifactPageCovered: Covered<ArtifactPage, (typeof ARTIFACT_PAGE_KEYS)[number]> = undefined

test('ArtifactPage declares nothing the wire does not carry', () => {
  // ArtifactRecord itself has NO coverage list yet, deliberately: every recording so far is an
  // empty page, so no row shape has been observed. Its doc comment says as much; enroll it the
  // first time a probe publishes a real artifact and records a populated page.
  expectDeclarationCoverage(ARTIFACT_PAGE_KEYS, [], [body('list-artifacts')])
})

const OUTCOME_CONFIG_KEYS = ['description', 'evaluator', 'maxIterations', 'publish'] as const satisfies readonly DeclaredKeys<OutcomeConfig>[]
const _outcomeConfigCovered: Covered<OutcomeConfig, (typeof OUTCOME_CONFIG_KEYS)[number]> = undefined

test('OutcomeConfig declares nothing the wire does not carry, across both storage sites', () => {
  const scheduleOutcome = (body('get-schedule-outcome').payload as { outcome: Record<string, unknown> }).outcome
  const agentOutcome = (body('put-agent-outcome').declared as { outcome: Record<string, unknown> }).outcome
  expectDeclarationCoverage(OUTCOME_CONFIG_KEYS, [], [scheduleOutcome, agentOutcome])
})

// ── coverage ───────────────────────────────────────────────────────────────

test('every recorded fixture is exercised by a test in this file', () => {
  // Must stay LAST: it reads what the tests above replayed. A fixture nobody replays is a recorded
  // reality with no test defending it, which is the exact gap this file was written to close.
  const unexercised = recordedNames().filter((n) => !exercised.has(n))
  expect(unexercised).toEqual([])
  expect(exercised.size).toBe(recordedNames().length)
})
