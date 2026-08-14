/**
 * Offline contract tests for the client: every request this SDK makes is asserted against a
 * stub `fetch`, so the wire shape is pinned WITHOUT staging.
 *
 * These exist because the staging observations behind this SDK (the `%3A` archive encoding,
 * the `sessionTarget` strip, `desired_state` vs `actual_state`, the silent 500-event
 * truncation) are expensive to re-derive and easy to undo by accident. Each one is locked
 * here by the assertion nearest to it.
 *
 * The RESPONSE half lives in `responses.test.ts`, replayed from recorded staging bodies.
 *
 * Everything is imported through `./index.js`, the published entry point — the same specifier a
 * consumer resolves — so a symbol that falls out of `src/index.ts` fails a test here rather than
 * somebody's build.
 */
import { expect, test } from 'vitest'
import { createZooclawClient, DEFAULT_BASE_URL, ZooclawError, type ScheduleUpdate } from './index.js'

const BASE = 'https://api.test/service/v1'
const KEY = 'zct_test_key'

interface Recorded {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
  signal?: AbortSignal
}

interface Reply {
  status?: number
  body?: string
}

type Responder = (call: Recorded, index: number) => Reply | Response | Promise<Reply | Response>

/**
 * `process.env` without a Node type dependency — the SDK ships no `@types/node` on purpose
 * (it targets Workers and browsers too), so the tests read the environment the same guarded
 * way `readEnv` does.
 */
const procEnv = (): Record<string, string | undefined> =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}

/** A stub fetch that records every call and answers from `responder`. */
function harness(responder: Responder | Reply) {
  const calls: Recorded[] = []
  const fetchImpl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const rec: Recorded = {
      url: input,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body,
      ...(init.signal ? { signal: init.signal } : {}),
    }
    calls.push(rec)
    const out = typeof responder === 'function' ? await responder(rec, calls.length - 1) : responder
    if (out instanceof Response) return out
    // `null`, not `''`: 204/205/304 reject a non-null body at construction.
    return new Response(out.body ?? null, { status: out.status ?? 200 })
  }
  const client = createZooclawClient({ apiKey: KEY, baseUrl: BASE, fetch: fetchImpl })
  return { calls, client }
}

const jsonReply = (value: unknown): Reply => ({ body: JSON.stringify(value) })

/** The path (with query) of the n-th recorded call, base stripped. */
const path = (calls: Recorded[], n = 0): string => calls[n]!.url.slice(BASE.length)

async function rejection(p: Promise<unknown>): Promise<ZooclawError> {
  try {
    await p
  } catch (e) {
    return e as ZooclawError
  }
  throw new Error('expected a rejection, got a resolved promise')
}

/** A fetch that never answers — the stalled-gateway case. Rejects only when cancelled. */
const stalledFetch = async (_input: string, init: RequestInit = {}): Promise<Response> => {
  const signal = init.signal as AbortSignal | undefined
  return new Promise<Response>((_resolve, reject) => {
    const fail = (): void => reject(new DOMException('The operation was aborted.', 'AbortError'))
    if (signal?.aborted) {
      fail()
      return
    }
    signal?.addEventListener('abort', fail, { once: true })
  })
}

// ── construction ───────────────────────────────────────────────────────────

test('construction refuses to build a client with no key at all', () => {
  const env = procEnv()
  const saved = env.ZOOCLAW_API_KEY
  delete env.ZOOCLAW_API_KEY
  try {
    expect(() => createZooclawClient({ baseUrl: BASE })).toThrow(/No ZooClaw API key/)
  } finally {
    if (saved !== undefined) env.ZOOCLAW_API_KEY = saved
  }
})

test('construction falls back to ZOOCLAW_API_KEY / ZOOCLAW_BASE_URL, and strips trailing slashes', async () => {
  const env = procEnv()
  const savedKey = env.ZOOCLAW_API_KEY
  const savedUrl = env.ZOOCLAW_BASE_URL
  env.ZOOCLAW_API_KEY = 'zct_from_env'
  env.ZOOCLAW_BASE_URL = 'https://env.test/service/v1///'
  try {
    const calls: Recorded[] = []
    const client = createZooclawClient({
      fetch: async (input, init = {}) => {
        calls.push({ url: input, method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string>, body: init.body })
        return new Response('[]')
      },
    })
    await client.listModels()
    expect(calls[0]!.url).toBe('https://env.test/service/v1/models')
    expect(calls[0]!.headers.Authorization).toBe('Bearer zct_from_env')
  } finally {
    if (savedKey === undefined) delete env.ZOOCLAW_API_KEY
    else env.ZOOCLAW_API_KEY = savedKey
    if (savedUrl === undefined) delete env.ZOOCLAW_BASE_URL
    else env.ZOOCLAW_BASE_URL = savedUrl
  }
})

test('construction accepts the privileged serviceToken auth as the bearer', async () => {
  const calls: Recorded[] = []
  const client = createZooclawClient({
    auth: { serviceToken: 'svc_internal' },
    baseUrl: BASE,
    fetch: async (input, init = {}) => {
      calls.push({ url: input, method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string>, body: init.body })
      return new Response('[]')
    },
  })
  await client.listModels()
  expect(calls[0]!.headers.Authorization).toBe('Bearer svc_internal')
})

test('DEFAULT_BASE_URL carries the /service/v1 gateway prefix', () => {
  expect(DEFAULT_BASE_URL.endsWith('/service/v1')).toBe(true)
})

// ── models / agents ────────────────────────────────────────────────────────

test('listModels accepts both the bare-array and the {models} envelope', async () => {
  const a = harness(jsonReply([{ model: 'm1' }]))
  expect(await a.client.listModels()).toEqual([{ model: 'm1' }])
  expect(path(a.calls)).toBe('/models')

  const b = harness(jsonReply({ models: [{ model: 'm2' }] }))
  expect(await b.client.listModels()).toEqual([{ model: 'm2' }])

  const c = harness(jsonReply({}))
  expect(await c.client.listModels()).toEqual([])
})

test('createAgent POSTs the envelope and sends Idempotency-Key only when given one', async () => {
  const { calls, client } = harness(jsonReply({ agent_id: 'agt_1', config_version: 1 }))
  const input = { resource: { name: 'a' }, ownership: { owner_uid: 'u', org_id: 'o' } }
  const created = await client.createAgent(input, 'key-1')
  expect(created.agent_id).toBe('agt_1')
  expect([calls[0]!.method, path(calls)]).toEqual(['POST', '/agents'])
  expect(JSON.parse(calls[0]!.body as string)).toEqual(input)
  expect(calls[0]!.headers['Idempotency-Key']).toBe('key-1')
  expect(calls[0]!.headers['Content-Type']).toBe('application/json')

  const bare = harness(jsonReply({ agent_id: 'agt_1' }))
  await bare.client.createAgent(input)
  expect('Idempotency-Key' in bare.calls[0]!.headers).toBe(false)
})

test('listAgents unwraps agents and builds label.* / page query from the options supplied', async () => {
  const all = harness(jsonReply({ page: 1, page_size: 100, total: 1, agents: [{ agent_id: 'agt_1' }] }))
  expect(await all.client.listAgents()).toEqual([{ agent_id: 'agt_1' }])
  expect(path(all.calls)).toBe('/agents')

  const filtered = harness(jsonReply({ agents: [] }))
  await filtered.client.listAgents({ labels: { workspace_id: 'w1', pack_id: 'p 1' }, page: 2 })
  expect(path(filtered.calls)).toBe('/agents?page=2&label.workspace_id=w1&label.pack_id=p+1')

  const empty = harness(jsonReply({}))
  expect(await empty.client.listAgents()).toEqual([])
})

test('agent ids are percent-encoded into the path', async () => {
  const { calls, client } = harness(jsonReply({ agent_id: 'a/b' }))
  await client.getAgent('a/b')
  expect(path(calls)).toBe('/agents/a%2Fb')
})

test('updateAgent PUTs the sections verbatim', async () => {
  const { calls, client } = harness(jsonReply({ agent_id: 'agt_1' }))
  await client.updateAgent('agt_1', { model: { primary: 'm' } })
  expect([calls[0]!.method, path(calls)]).toEqual(['PUT', '/agents/agt_1'])
  expect(JSON.parse(calls[0]!.body as string)).toEqual({ model: { primary: 'm' } })
})

test('deleteAgent tolerates a 204 with no body', async () => {
  const { calls, client } = harness({ status: 204 })
  await expect(client.deleteAgent('agt_1')).resolves.toBeUndefined()
  expect(calls[0]!.method).toBe('DELETE')
})

test('start/stop default warnings to an empty array', async () => {
  const started = harness(jsonReply({ warnings: ['channel_routes_reload_failed'] }))
  expect(await started.client.startAgent('agt_1')).toEqual({ warnings: ['channel_routes_reload_failed'] })
  expect([started.calls[0]!.method, path(started.calls)]).toEqual(['POST', '/agents/agt_1/start'])

  const stopped = harness(jsonReply({}))
  expect(await stopped.client.stopAgent('agt_1')).toEqual({ warnings: [] })
  expect(path(stopped.calls)).toBe('/agents/agt_1/stop')
})

// ── waitUntilRunning ───────────────────────────────────────────────────────

test('waitUntilRunning polls desired_state and IGNORES actual_state', async () => {
  // actual_state parks at 'activating' for an API-only agent and never says 'running' —
  // a loop that watched it would hang here forever.
  const pages = [
    jsonReply({ agent_id: 'a', status: { desired_state: 'stopped', actual_state: 'running' } }),
    jsonReply({ agent_id: 'a', status: { desired_state: 'running', actual_state: 'activating' } }),
  ]
  const { calls, client } = harness((_c, i) => pages[Math.min(i, pages.length - 1)]!)
  const agent = await client.waitUntilRunning('a', { intervalMs: 5, timeoutMs: 2000 })
  expect(agent.status?.desired_state).toBe('running')
  expect(calls.length).toBe(2)
  expect(path(calls)).toBe('/agents/a')
})

test('waitUntilRunning throws 408/timeout when the agent never gets there', async () => {
  const { client } = harness(jsonReply({ agent_id: 'a', status: { desired_state: 'stopped' } }))
  const err = await rejection(client.waitUntilRunning('a', { timeoutMs: 120, intervalMs: 20 }))
  expect(err).toBeInstanceOf(ZooclawError)
  expect([err.status, err.type]).toEqual([408, 'timeout'])
  expect(err.message).toContain('last seen: stopped')
})

test('waitUntilRunning throws 0/aborted for a signal that is already aborted', async () => {
  const { calls, client } = harness(jsonReply({ agent_id: 'a', status: { desired_state: 'stopped' } }))
  const ctl = new AbortController()
  ctl.abort()
  const err = await rejection(client.waitUntilRunning('a', { signal: ctl.signal }))
  expect([err.status, err.type]).toEqual([0, 'aborted'])
  expect(calls.length).toBe(0) // it never even asked
})

test('waitUntilRunning honors timeoutMs while a request is IN FLIGHT (stalled gateway)', async () => {
  // Regression: `fetch` has no default timeout, so an unbounded poll parks the promise
  // forever on a gateway that accepts the connection and then stalls.
  const client = createZooclawClient({ apiKey: KEY, baseUrl: BASE, fetch: stalledFetch })
  const started = Date.now()
  const err = await rejection(client.waitUntilRunning('a', { timeoutMs: 150, intervalMs: 50 }))
  expect([err.status, err.type]).toEqual([408, 'timeout'])
  expect(Date.now() - started).toBeLessThan(2000)
})

test('waitUntilRunning honors an abort while a request is IN FLIGHT', async () => {
  const client = createZooclawClient({ apiKey: KEY, baseUrl: BASE, fetch: stalledFetch })
  const ctl = new AbortController()
  setTimeout(() => ctl.abort(), 30)
  const started = Date.now()
  const err = await rejection(client.waitUntilRunning('a', { timeoutMs: 60_000, intervalMs: 50, signal: ctl.signal }))
  expect([err.status, err.type]).toEqual([0, 'aborted'])
  expect(Date.now() - started).toBeLessThan(5000) // not the 60s budget
})

test('waitUntilRunning does not sleep out the rest of its interval after an abort', async () => {
  // The abort lands DURING the request, on a stub that ignores signals — so it is the
  // sleep, not the fetch, that has to notice an already-aborted signal.
  const client = createZooclawClient({
    apiKey: KEY,
    baseUrl: BASE,
    fetch: async () =>
      new Promise<Response>((resolve) =>
        setTimeout(() => resolve(new Response(JSON.stringify({ agent_id: 'a', status: { desired_state: 'stopped' } }))), 20),
      ),
  })
  const ctl = new AbortController()
  setTimeout(() => ctl.abort(), 5)
  const started = Date.now()
  const err = await rejection(client.waitUntilRunning('a', { timeoutMs: 600_000, intervalMs: 3000, signal: ctl.signal }))
  expect([err.status, err.type]).toEqual([0, 'aborted'])
  expect(Date.now() - started).toBeLessThan(1500) // NOT the 3000ms poll interval
})

// ── skills ─────────────────────────────────────────────────────────────────

test('listAgentSkills adds ?verbose=true only when asked', async () => {
  const plain = harness(jsonReply({ skills: [{ skill_id: 's1' }] }))
  expect(await plain.client.listAgentSkills('a')).toEqual([{ skill_id: 's1' }])
  expect(path(plain.calls)).toBe('/agents/a/skills')

  const verbose = harness(jsonReply({}))
  expect(await verbose.client.listAgentSkills('a', { verbose: true })).toEqual([])
  expect(path(verbose.calls)).toBe('/agents/a/skills?verbose=true')
})

test('putAgentSkill defaults to enabled and an unpinned version', async () => {
  const { calls, client } = harness(jsonReply({ config_version: 4 }))
  await client.putAgentSkill('a', 'skl_1')
  expect([calls[0]!.method, path(calls)]).toEqual(['PUT', '/agents/a/skills/skl_1'])
  expect(JSON.parse(calls[0]!.body as string)).toEqual({ enabled: true, version_pin: null })

  const pinned = harness(jsonReply({}))
  await pinned.client.putAgentSkill('a', 'skl_1', { enabled: false, versionPin: 3 })
  expect(JSON.parse(pinned.calls[0]!.body as string)).toEqual({ enabled: false, version_pin: 3 })
})

test('uploadSkill posts multipart with files[] + scope and lets the runtime set Content-Type', async () => {
  const { calls, client } = harness(jsonReply({ skill_id: 'skl_1', latest_version: '1' }))
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04])
  const rec = await client.uploadSkill(zip, { scope: 'org', fileName: 'market-research.zip', description: 'd', idempotencyKey: 'k' })
  expect(rec.skill_id).toBe('skl_1')
  expect([calls[0]!.method, path(calls)]).toEqual(['POST', '/skills'])
  // Hand-writing the boundary produces a body the server cannot parse, so the SDK must NOT
  // set Content-Type here.
  expect('Content-Type' in calls[0]!.headers).toBe(false)
  expect(calls[0]!.headers['Idempotency-Key']).toBe('k')
  const form = calls[0]!.body as FormData
  expect(form.get('scope')).toBe('org')
  expect(form.get('description')).toBe('d')
  const file = form.get('files[]') as File
  expect(file.name).toBe('market-research.zip')
  expect(await file.arrayBuffer()).toEqual(zip.buffer)
})

test('uploadSkillVersion targets /skills/{id}/versions and defaults the filename', async () => {
  const { calls, client } = harness(jsonReply({ skill_id: 'skl_1' }))
  await client.uploadSkillVersion('skl 1', new Blob([new Uint8Array([1])]))
  expect(path(calls)).toBe('/skills/skl%201/versions')
  const form = calls[0]!.body as FormData
  expect((form.get('files[]') as File).name).toBe('skill.zip')
  expect(form.get('description')).toBe(null)
})

test('listSkills builds its query from the options actually supplied', async () => {
  const all = harness(jsonReply({ skills: [] }))
  await all.client.listSkills()
  expect(path(all.calls)).toBe('/skills')

  const filtered = harness(jsonReply({ skills: [{ skill_id: 's' }] }))
  await filtered.client.listSkills({ scope: 'org', q: 'market research', page: 2 })
  expect(path(filtered.calls)).toBe('/skills?scope=org&q=market+research&page=2')
})

test('deleteSkill DELETEs the encoded id', async () => {
  const { calls, client } = harness({ status: 204 })
  await client.deleteSkill('skl/1')
  expect([calls[0]!.method, path(calls)]).toEqual(['DELETE', '/skills/skl%2F1'])
})

// ── sessions & events ──────────────────────────────────────────────────────

test('createSession posts the input and forwards an idempotency key', async () => {
  const { calls, client } = harness(jsonReply({ session_id: 'ses_1' }))
  await client.createSession('a', { metadata: { k: 'v' } }, 'idem')
  expect([calls[0]!.method, path(calls)]).toEqual(['POST', '/agents/a/sessions'])
  expect(JSON.parse(calls[0]!.body as string)).toEqual({ metadata: { k: 'v' } })
  expect(calls[0]!.headers['Idempotency-Key']).toBe('idem')
})

test('getSession sends history/limit only when requested', async () => {
  const plain = harness(jsonReply({ session_id: 's' }))
  await plain.client.getSession('a', 's')
  expect(path(plain.calls)).toBe('/agents/a/sessions/s')

  const full = harness(jsonReply({ session_id: 's', history: [] }))
  await full.client.getSession('a', 's', { history: true, limit: 20 })
  expect(path(full.calls)).toBe('/agents/a/sessions/s?history=true&limit=20')
})

test('listSessions pages, archiveSession normalizes, deleteSession is a 204 DELETE', async () => {
  const listed = harness(jsonReply({ sessions: [{ session_id: 's1' }], page: 2 }))
  expect(await listed.client.listSessions('a', { page: 2 })).toEqual([{ session_id: 's1' }])
  expect(path(listed.calls)).toBe('/agents/a/sessions?page=2')

  const archived = harness(jsonReply({ session_id: 's1', archived: true }))
  expect(await archived.client.archiveSession('a', 's1')).toEqual({ session_id: 's1', archived: true })
  expect([archived.calls[0]!.method, path(archived.calls)]).toEqual(['POST', '/agents/a/sessions/s1/archive'])

  const silent = harness(jsonReply({}))
  expect((await silent.client.archiveSession('a', 's1')).archived).toBe(false)

  const deleted = harness({ status: 204 })
  await expect(deleted.client.deleteSession('a', 's1')).resolves.toBeUndefined()
  expect([deleted.calls[0]!.method, path(deleted.calls)]).toEqual(['DELETE', '/agents/a/sessions/s1'])
})

test('postEvents wraps the events and defaults the receipt', async () => {
  const { calls, client } = harness(jsonReply({ events: [{ id: 'e1', accepted: true }] }))
  const out = await client.postEvents('a', 's', [{ type: 'user.message', content: 'hi' }])
  expect(out.events).toEqual([{ id: 'e1', accepted: true }])
  expect(path(calls)).toBe('/agents/a/sessions/s/events')
  expect(JSON.parse(calls[0]!.body as string)).toEqual({ events: [{ type: 'user.message', content: 'hi' }] })

  const empty = harness(jsonReply({}))
  expect((await empty.client.postEvents('a', 's', [])).events).toEqual([])
})

test('listEvents passes after/types/limit and normalizes the REST wire shape', async () => {
  const { calls, client } = harness(
    jsonReply({ events: [{ seq: 7, event_type: 'agent.assistant', payload: { message: {} }, run_id: 'r1', created_at: 't' }] }),
  )
  const events = await client.listEvents('a', 's', { after: 3, types: ['agent.assistant', 'run.finished'], limit: 50 })
  expect(path(calls)).toBe('/agents/a/sessions/s/events?after=3&types=agent.assistant%2Crun.finished&limit=50')
  expect(events).toEqual([{ seq: 7, eventType: 'agent.assistant', payload: { message: {} }, runId: 'r1', createdAt: 't' }])
})

test('listAllEvents walks `after`, dedupes the boundary replay, and stops on a short page', async () => {
  const pages = [
    jsonReply({ events: [{ seq: 1, event_type: 'x', payload: {} }, { seq: 2, event_type: 'x', payload: {} }] }),
    // The server replays the boundary event; it must not be emitted twice.
    jsonReply({ events: [{ seq: 2, event_type: 'x', payload: {} }, { seq: 3, event_type: 'x', payload: {} }] }),
    jsonReply({ events: [{ seq: 3, event_type: 'x', payload: {} }] }),
  ]
  const { calls, client } = harness((_c, i) => pages[Math.min(i, pages.length - 1)]!)
  const all = await client.listAllEvents('a', 's', { pageSize: 2 })
  expect(all.map((e) => e.seq)).toEqual([1, 2, 3])
  expect(calls.length).toBe(3)
  expect(path(calls, 0)).toBe('/agents/a/sessions/s/events?after=0&limit=2')
  expect(path(calls, 1)).toBe('/agents/a/sessions/s/events?after=2&limit=2')
})

test('listAllEvents stops instead of spinning when the server ignores `after`', async () => {
  const { calls, client } = harness(jsonReply({ events: [{ seq: 1, event_type: 'x', payload: {} }, { seq: 2, event_type: 'x', payload: {} }] }))
  const all = await client.listAllEvents('a', 's', { pageSize: 2 })
  expect(all.map((e) => e.seq)).toEqual([1, 2])
  expect(calls.length).toBe(2) // the stuck-cursor guard, not an infinite walk
})

test('listAllEvents clamps pageSize to the server maximum of 500', async () => {
  const { calls, client } = harness(jsonReply({ events: [] }))
  await client.listAllEvents('a', 's', { pageSize: 5000 })
  expect(path(calls)).toBe('/agents/a/sessions/s/events?after=0&limit=500')
})

test('streamEvents parses SSE, skips chat.delta preview frames, and resumes from `after`', async () => {
  const sse =
    'id: 5\ndata: {"seq":5,"eventType":"run.started","payload":{}}\n\n' +
    'event: event_delta\ndata: {"seq":6,"eventType":"chat.delta","payload":{}}\n\n' +
    'id: 7\ndata: {"seq":7,"eventType":"agent.assistant","payload":{}}\n\n'
  const { calls, client } = harness(() => new Response(sse))
  const seen = []
  for await (const e of client.streamEvents('a', 's', { after: 4 })) seen.push(e.seq)
  expect(seen).toEqual([5, 7])
  expect(path(calls)).toBe('/agents/a/sessions/s/events/stream?after=4')
  expect(calls[0]!.headers.Accept).toBe('text/event-stream')
})

test('streamEvents drops a replayed boundary event on resume', async () => {
  const sse =
    'id: 5\ndata: {"seq":5,"eventType":"run.started","payload":{}}\n\n' +
    'id: 6\ndata: {"seq":6,"eventType":"run.finished","payload":{"status":"succeeded"}}\n\n'
  const { client } = harness(() => new Response(sse))
  const seen = []
  for await (const e of client.streamEvents('a', 's', { after: 5 })) seen.push(e.seq)
  expect(seen).toEqual([6])
})

test('streamEvents ends quietly when the caller aborts, and throws otherwise', async () => {
  const ctl = new AbortController()
  ctl.abort()
  const { client } = harness(async (call) => {
    if (call.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    return new Response('')
  })
  const seen = []
  for await (const e of client.streamEvents('a', 's', { signal: ctl.signal })) seen.push(e)
  expect(seen).toEqual([])

  const failing = harness({ status: 503, body: 'nope' })
  const err = await rejection(
    (async () => {
      for await (const _ of failing.client.streamEvents('a', 's')) void _
    })(),
  )
  expect(err.status).toBe(503)
})

// ── approvals / schedules / wake / exec ────────────────────────────────────

test('listApprovals sends status only when supplied', async () => {
  const pending = harness(jsonReply({ approvals: [{ approval_id: 'ap1' }] }))
  await pending.client.listApprovals('a', { status: 'pending' })
  expect(path(pending.calls)).toBe('/agents/a/approvals?status=pending')

  const all = harness(jsonReply({}))
  expect(await all.client.listApprovals('a')).toEqual([])
  expect(path(all.calls)).toBe('/agents/a/approvals')
})

test('resolveApproval posts the decision vocabulary verbatim', async () => {
  const { calls, client } = harness(jsonReply({ resolved: true }))
  await client.resolveApproval('a', 'ap 1', { decision: 'allow-once', resolvedBy: 'u@x' })
  expect(path(calls)).toBe('/agents/a/approvals/ap%201/resolve')
  expect(JSON.parse(calls[0]!.body as string)).toEqual({ decision: 'allow-once', resolvedBy: 'u@x' })
})

test('getSystemPrompt and previewSystemPrompt hit their paths — the preview colon goes RAW', async () => {
  const get = harness(jsonReply({ agent_id: 'a', declaration: { source: 'platform', version: 1 } }))
  await get.client.getSystemPrompt('a')
  expect(path(get.calls)).toBe('/agents/a/system-prompt')

  const preview = harness(jsonReply({ system_prompt: 'x', transcript: [] }))
  const input = {
    config_version: 3,
    now_ms: 1755150000000,
    session_id: 'ses_p',
    model_display: 'probe',
    workspace_dir: '/workspace',
    tool_names: ['read'],
  }
  await preview.client.previewSystemPrompt('a', input)
  // RAW ':' — this family matches the literal colon; the environments family needs %3A instead.
  expect(path(preview.calls)).toBe('/agents/a/system-prompt:preview')
  expect(preview.calls[0]!.method).toBe('POST')
  expect(JSON.parse(preview.calls[0]!.body as string)).toEqual(input)
})

test('upgradeSystemPrompt POSTs the agent-id-suffix verb with a RAW colon and the CAS body', async () => {
  const { calls, client } = harness(jsonReply({ agent_id: 'a', config_version: 4 }))
  await client.upgradeSystemPrompt('a', { expected_config_version: 3 })
  // `{id}:verb` grammar — reachable through the gateway since fix #3387 (2026-08-14).
  expect(path(calls)).toBe('/agents/a:upgrade-system-prompt')
  expect(calls[0]!.method).toBe('POST')
  expect(JSON.parse(calls[0]!.body as string)).toEqual({ expected_config_version: 3 })

  const pinned = harness(jsonReply({ agent_id: 'a', config_version: 5 }))
  await pinned.client.upgradeSystemPrompt('a', { expected_config_version: 4, template_version: 2 })
  expect(JSON.parse(pinned.calls[0]!.body as string)).toEqual({ expected_config_version: 4, template_version: 2 })
})

/** The projection every artifact test answers for the selector-derivation GET. */
const AGENT_PROJECTION = { agent_id: 'a', ownership: { owner_uid: 'u1', org_id: 'o1' } }

test('artifact methods derive owner_uid/org_id from the projection ONCE and cache them', async () => {
  const { calls, client } = harness((call) =>
    call.url.endsWith('/agents/a')
      ? jsonReply(AGENT_PROJECTION)
      : jsonReply({ artifacts: [], page: 1, has_more: false }),
  )
  const page = await client.listArtifacts('a')
  expect(page.artifacts).toEqual([])
  expect(page.has_more).toBe(false)
  // Call 0 is the projection fetch the selectors come from; call 1 carries both of them.
  expect(path(calls, 0)).toBe('/agents/a')
  expect(path(calls, 1)).toBe('/agents/a/artifacts?owner_uid=u1&org_id=o1')

  await client.listArtifacts('a', {
    page: 2,
    limit: 10,
    sessionId: 's1',
    sourcePath: '/workspace/r.md',
    createdBefore: '2026-08-14T00:00:00Z',
  })
  // The ownership cache held: three calls total, not four.
  expect(calls.length).toBe(3)
  expect(path(calls, 2)).toBe(
    '/agents/a/artifacts?owner_uid=u1&org_id=o1&page=2&limit=10&session_id=s1&source_path=%2Fworkspace%2Fr.md&created_before=2026-08-14T00%3A00%3A00Z',
  )
})

test('getArtifact / downloadArtifact / deleteArtifact carry the selectors — download keeps a RAW colon', async () => {
  const { calls, client } = harness((call) =>
    call.url.endsWith('/agents/a')
      ? jsonReply(AGENT_PROJECTION)
      : jsonReply({ artifact_id: 'art_1', url: 'https://x.invalid/a' }),
  )
  await client.getArtifact('a', 'art_1')
  await client.downloadArtifact('a', 'art_1')
  await client.deleteArtifact('a', 'art_1')
  expect(path(calls, 1)).toBe('/agents/a/artifacts/art_1?owner_uid=u1&org_id=o1')
  expect(path(calls, 2)).toBe('/agents/a/artifacts/art_1:download?owner_uid=u1&org_id=o1')
  expect(calls[2]!.method).toBe('POST')
  expect(path(calls, 3)).toBe('/agents/a/artifacts/art_1?owner_uid=u1&org_id=o1')
  expect(calls[3]!.method).toBe('DELETE')
})

test('a projection without ownership is a loud ownership_unavailable, not a selector-less 400', async () => {
  const { client } = harness(jsonReply({ agent_id: 'a' }))
  const err = await rejection(client.listArtifacts('a'))
  expect(err.type).toBe('ownership_unavailable')
  expect(err.status).toBe(500)
})

test('schedule CRUD hits the documented paths', async () => {
  const listed = harness(jsonReply({ schedules: [{ scheduleId: 'sc1' }] }))
  expect(await listed.client.listSchedules('a')).toEqual([{ scheduleId: 'sc1' }])
  expect(path(listed.calls)).toBe('/agents/a/schedules')

  const created = harness(jsonReply({ schedule_name: 'cron/c/a/sc1' }))
  await created.client.createSchedule(
    'a',
    { schedule_id: 'sc1', schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Singapore' }, payload: { kind: 'agentTurn' } },
    'idem',
  )
  expect([created.calls[0]!.method, path(created.calls)]).toEqual(['POST', '/agents/a/schedules'])
  expect(created.calls[0]!.headers['Idempotency-Key']).toBe('idem')

  const got = harness(jsonReply({ scheduleId: 'sc1', computerId: 'c', agentId: 'a' }))
  expect((await got.client.getSchedule('a', 'sc1')).scheduleId).toBe('sc1')

  const deleted = harness({ status: 204 })
  await expect(deleted.client.deleteSchedule('a', 'sc1')).resolves.toBeUndefined()
  expect([deleted.calls[0]!.method, path(deleted.calls)]).toEqual(['DELETE', '/agents/a/schedules/sc1'])

  const triggered = harness(jsonReply({ schedule_name: 'cron/c/a/sc1', triggered: true }))
  expect(await triggered.client.triggerSchedule('a', 'sc1')).toEqual({ schedule_name: 'cron/c/a/sc1', triggered: true })
  expect(path(triggered.calls)).toBe('/agents/a/schedules/sc1/trigger')

  const runs = harness(jsonReply({ runs: [{ run_id: 'r1' }] }))
  await runs.client.listScheduleRuns('a', 'sc1', { limit: 5 })
  expect(path(runs.calls)).toBe('/agents/a/schedules/sc1/runs?limit=5')
})

test('updateSchedule STRIPS every field a getSchedule() body carries and the PUT refuses', async () => {
  const { calls, client } = harness(jsonReply({ scheduleId: 'sc1' }))
  // A JavaScript caller round-tripping a getSchedule() result verbatim. The types say `never`,
  // but only the strip protects an untyped caller — and staging refuses these six for three
  // different reasons: sessionTarget is `immutable`, execution/originMetadata/contextSnapshot/
  // creatorPrincipalRef are `server-derived`, and scheduleSpec is accepted then SILENTLY IGNORED
  // (a 200 that drops the cadence change is worse than the 400s).
  const roundTripped = {
    enabled: false,
    schedule: { kind: 'cron', expr: '30 9 * * *' },
    sessionTarget: 'isolated',
    scheduleSpec: { timezoneName: 'Asia/Singapore', cronExpressions: ['0 9 * * *'] },
    execution: { kind: 'isolated' },
    originMetadata: { kind: 'management' },
    contextSnapshot: [],
    creatorPrincipalRef: 'someone',
  } as unknown as ScheduleUpdate
  await client.updateSchedule('a', 'sc1', roundTripped)
  expect([calls[0]!.method, path(calls)]).toEqual(['PUT', '/agents/a/schedules/sc1'])
  // `schedule` survives: it is the INPUT vocabulary, and the only one that actually applies.
  expect(JSON.parse(calls[0]!.body as string)).toEqual({
    enabled: false,
    schedule: { kind: 'cron', expr: '30 9 * * *' },
  })
})

test('wake and exec post their documented bodies', async () => {
  const woken = harness(jsonReply({ mode: 'now', queued: true, triggered: true }))
  expect(await woken.client.wake('a', { text: 'check email', mode: 'now' })).toEqual({ mode: 'now', queued: true, triggered: true })
  expect(path(woken.calls)).toBe('/agents/a/wake')

  const ran = harness(jsonReply({ exit_code: 1, stdout: '', stderr: 'boom' }))
  const res = await ran.client.exec('a', ['bash', '-lc', 'false'])
  expect(res.exit_code).toBe(1) // a failed command RESOLVES; it does not reject
  expect(path(ran.calls)).toBe('/agents/a/exec')
  expect(JSON.parse(ran.calls[0]!.body as string)).toEqual({ args: ['bash', '-lc', 'false'] })
})

// ── environments ───────────────────────────────────────────────────────────

test('environment reads and creates hit the documented paths', async () => {
  const listed = harness(jsonReply({ environments: [{ environment_id: 'env1' }] }))
  await listed.client.listEnvironments({ page: 3 })
  expect(path(listed.calls)).toBe('/environments?page=3')

  const got = harness(jsonReply({ environment_id: 'env1' }))
  await got.client.getEnvironment('env 1')
  expect(path(got.calls)).toBe('/environments/env%201')

  const created = harness(jsonReply({ environment_id: 'env1' }))
  const input = { resource: { name: 'e', config: { packages: { apt: ['jq'] } } }, ownership: { owner_uid: 'u', org_id: 'o' } }
  await created.client.createEnvironment(input, 'idem')
  expect([created.calls[0]!.method, path(created.calls)]).toEqual(['POST', '/environments'])
  expect(JSON.parse(created.calls[0]!.body as string)).toEqual(input)

  const version = harness(jsonReply({ environment_id: 'env1', version: 2 }))
  await version.client.createEnvironmentVersion('env1', { build: { script: 'make' } })
  expect(path(version.calls)).toBe('/environments/env1/versions')
  expect(JSON.parse(version.calls[0]!.body as string)).toEqual({ resource: { config: { build: { script: 'make' } } } })

  const read = harness(jsonReply({ version: 2, state: 'ready' }))
  await read.client.getEnvironmentVersion('env1', 2)
  expect(path(read.calls)).toBe('/environments/env1/versions/2')
})

test('archiveEnvironment percent-encodes the colon — a raw ":" is a 404 on the engine', async () => {
  const { calls, client } = harness(jsonReply({ environment_id: 'env1', state: 'archived' }))
  await client.archiveEnvironment('env1')
  expect(path(calls)).toBe('/environments/env1%3Aarchive')
  expect(calls[0]!.url).not.toContain('env1:archive')
  expect(calls[0]!.method).toBe('POST')
})

// ── error envelope ─────────────────────────────────────────────────────────

test('an API error envelope becomes a ZooclawError carrying status, type and message', async () => {
  const { client } = harness({ status: 409, body: JSON.stringify({ error: { type: 'agent_not_running', message: 'agent is not running' } }) })
  const err = await rejection(client.createSession('a', {}))
  expect(err).toBeInstanceOf(ZooclawError)
  expect([err.status, err.type, err.message]).toEqual([409, 'agent_not_running', 'agent is not running'])
})

test('a non-JSON error body keeps a clean HTTP status message and no type', async () => {
  const { client } = harness({ status: 502, body: '<html>bad gateway</html>' })
  const err = await rejection(client.getAgent('a'))
  expect([err.status, err.type, err.message]).toEqual([502, undefined, 'HTTP 502'])
})

test('the multipart path raises the same envelope as the JSON path', async () => {
  const { client } = harness({
    status: 400,
    body: JSON.stringify({ error: { type: 'invalid_skill_package', message: "top-level directory 'x' must match SKILL.md name 'y'" } }),
  })
  const err = await rejection(client.uploadSkill(new Uint8Array([1]), { scope: 'org' }))
  expect([err.status, err.type]).toEqual([400, 'invalid_skill_package'])
  expect(err.message).toContain('must match SKILL.md name')
})

test('a 200 whose body is not JSON is an error, not a silent empty object', async () => {
  const { client } = harness({ status: 200, body: 'not json at all' })
  const err = await rejection(client.getAgent('a'))
  expect(err.status).toBe(200)
  expect(err.message).toBe('non-JSON response: /agents/a')
})
