// Synthetic control-flow cases only. These are not recorded API response fixtures.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as sdk from '../src/index.js'
import { baseURL, guardedFetch, safeFailure } from './guard.ts'
import { smoke } from './smoke.ts'
import type { SmokeRecord } from './smoke.ts'

const base = 'https://staging.example.invalid/service/v1'
const sentinel = 'synthetic-sensitive-value-do-not-emit'
function agentPage(data: sdk.AgentRecord[], total = data.length): sdk.AgentPagePromise {
  return sdk.createZooworkClient({ apiKey: 'zct_test_key', baseUrl: base,
    fetch: async () => Response.json({ agents: data, page: 1, page_size: 100, total }),
  }).listAgents()
}
function setup(overrides: Partial<sdk.ZooworkClient> = {}) {
  const calls: string[] = []
  let deleted = false
  const events = [sdk.normalizeEvent({ seq: 1, event_type: 'agent.assistant', payload: { message: { content: 'SDK_E2E_OK' } } }),
    sdk.normalizeEvent({ seq: 2, event_type: 'run.finished', payload: { status: 'succeeded' } })]
  const client = {
    listModels: async () => [{ model: 'synthetic-model' }],
    createAgent: async (input, key) => { calls.push('create'); assert.equal(input.resource.labels?.sdk_e2e_run, 'test-run'); assert.equal(key, 'test-run'); return { agent_id: 'agt_SYNTHETIC' } },
    startAgent: async () => { calls.push('start'); return { warnings: [] } },
    waitUntilRunning: async () => { calls.push('ready'); return { agent_id: 'agt_SYNTHETIC', status: { desired_state: 'running' } } },
    createSession: async (_agent, _input, key) => { calls.push('session'); assert.equal(key, 'test-run-session'); return { session_id: 'SYNTHETIC_SESSION' } },
    streamEvents: async function* () { calls.push('stream'); yield* events },
    listAllEvents: async () => { calls.push('rest'); return events },
    deleteSession: async () => { calls.push('delete_session') },
    stopAgent: async () => { calls.push('stop'); return { warnings: [] } },
    deleteAgent: async () => { calls.push('delete'); deleted = true },
    getAgent: async () => { calls.push('get'); if (deleted) throw new sdk.ZooworkError(404, sentinel); return { agent_id: 'agt_SYNTHETIC' } },
    listAgents: () => { calls.push('recover'); return agentPage([]) },
    ...overrides,
  } as sdk.ZooworkClient
  const records: SmokeRecord[] = []
  const options = { runId: 'test-run', signal: new AbortController().signal,
    cleanupMode: () => { calls.push('cleanup_mode') }, save: (record: SmokeRecord) => records.push(record) }
  return { client, calls, records, options, events }
}
test('one lifecycle/turn, REST-SSE agreement, then stop and soft-delete only owned resources', async () => {
  const f = setup(); const result = await smoke(sdk, f.client, f.options)
  assert.equal(result.passed, true); assert.equal(result.cleanup.complete, true)
  assert.deepEqual(f.calls, ['create', 'start', 'ready', 'session', 'stream', 'rest', 'cleanup_mode', 'delete_session', 'stop', 'delete', 'get'])
  assert.equal(JSON.stringify(f.records).includes('SDK_E2E_OK'), false)
})
test('REST mismatch fails and still cleans up', async () => {
  const f = setup({ listAllEvents: async () => [] }); const result = await smoke(sdk, f.client, f.options)
  assert.equal(result.passed, false); assert.equal(result.cleanup.complete, true)
  assert.equal(result.failure?.kind, 'rest_missing_successful_turn'); assert.ok(f.calls.includes('delete'))
})
test('failed or missing run.finished never counts as success', async () => {
  const f = setup({ streamEvents: async function* () { yield sdk.normalizeEvent({ seq: 1, event_type: 'run.finished', payload: { status: 'failed', message: sentinel } }) } })
  const result = await smoke(sdk, f.client, f.options)
  assert.equal(result.passed, false); assert.equal(result.failure?.kind, 'turn_did_not_succeed')
  assert.equal(result.cleanup.complete, true); assert.equal(JSON.stringify(result).includes(sentinel), false)
})
test('cleanup failure prevents a pass after a successful turn and other cleanup still runs', async () => {
  const f = setup({ deleteSession: async () => { throw new sdk.ZooworkError(500, sentinel) } })
  const result = await smoke(sdk, f.client, f.options)
  assert.equal(result.passed, false); assert.equal(result.cleanup.complete, false); assert.ok(f.calls.includes('delete'))
  assert.equal(JSON.stringify(result).includes(sentinel), false)
})
test('a delete receipt is insufficient when the agent is still readable', async () => {
  const f = setup({ getAgent: async () => ({ agent_id: 'agt_SYNTHETIC' }) })
  const result = await smoke(sdk, f.client, f.options); assert.equal(result.passed, false); assert.equal(result.cleanup.complete, false)
})
test('cancelled before creation makes no resources', async () => {
  const f = setup(); f.options.signal = AbortSignal.abort()
  const result = await smoke(sdk, f.client, f.options)
  assert.equal(result.passed, false); assert.deepEqual(f.calls, ['cleanup_mode']); assert.equal(result.cleanup.complete, true)
})
test('missing model creates no resource and leaks no server message', async () => {
  const f = setup({ listModels: async () => { throw new sdk.ZooworkError(401, sentinel) } })
  const result = await smoke(sdk, f.client, f.options)
  assert.deepEqual(result.failure, { kind: 'http_failure', http_status: 401 }); assert.equal(JSON.stringify(result).includes(sentinel), false)
  assert.equal(f.calls.includes('create'), false)
})
test('uncertain create is not retried; absent recovery stays incomplete', async () => {
  let creates = 0
  const f = setup({ createAgent: async () => { creates++; throw new Error(sentinel) } })
  const result = await smoke(sdk, f.client, f.options)
  assert.equal(creates, 1); assert.equal(result.resources.creation_uncertain, true); assert.equal(result.cleanup.complete, false)
  assert.equal(f.calls.includes('delete'), false); assert.equal(JSON.stringify(result).includes(sentinel), false)
})
test('uncertain create may recover only the exact unique run label/name', async () => {
  const f = setup({ createAgent: async () => { throw new Error('synthetic timeout') },
    listAgents: opts => {
      assert.deepEqual(opts, { labels: { sdk_e2e_run: 'test-run' } })
      return agentPage([{ agent_id: 'agt_SYNTHETIC', declared: { name: 'sdk-e2e-test-run', labels: { sdk_e2e_run: 'test-run' } } }])
    } })
  const result = await smoke(sdk, f.client, f.options)
  assert.equal(result.passed, false); assert.equal(result.cleanup.complete, true); assert.ok(f.calls.includes('delete'))
})
test('a broad/mismatched recovery response does not authorize deleting another agent', async () => {
  const f = setup({ createAgent: async () => { throw new Error('synthetic timeout') },
    listAgents: () => agentPage([{ agent_id: 'agt_OTHER', declared: { name: 'not-this-run' } }]) })
  const result = await smoke(sdk, f.client, f.options)
  assert.equal(result.cleanup.complete, false); assert.equal(f.calls.includes('delete'), false)
})
test('recovery checks total matches rather than treating a partial page as unique', async () => {
  const f = setup({ createAgent: async () => { throw new Error('synthetic timeout') },
    listAgents: () => agentPage([{ agent_id: 'agt_SYNTHETIC', declared: {
      name: 'sdk-e2e-test-run', labels: { sdk_e2e_run: 'test-run' },
    } }], 2) })
  const result = await smoke(sdk, f.client, f.options)
  assert.equal(result.cleanup.complete, false); assert.equal(f.calls.includes('delete'), false)
})
test('ledger write failure after creation cannot skip cleanup', async () => {
  const f = setup()
  f.options.save = (record: SmokeRecord) => { if (record.resources.agent_id) throw new Error(sentinel); return 0 }
  const result = await smoke(sdk, f.client, f.options)
  assert.equal(result.passed, false); assert.ok(f.calls.includes('stop')); assert.ok(f.calls.includes('delete'))
  assert.equal(result.failure?.kind, 'record_write_failed')
})
test('uncertain session creation is recovered only within the newly created agent', async () => {
  const f = setup({ createSession: async () => { throw new Error('synthetic timeout') },
    listSessions: async agent => { assert.equal(agent, 'agt_SYNTHETIC'); return [{ session_id: 'SYNTHETIC_SESSION', metadata: { run_id: 'test-run' } }] } })
  const result = await smoke(sdk, f.client, f.options)
  assert.equal(result.passed, false); assert.equal(result.cleanup.complete, true); assert.ok(f.calls.includes('delete_session'))
})
test('failure summaries discard arbitrary exception messages and bodies', () => {
  assert.deepEqual(safeFailure(new Error(sentinel)), { kind: 'request_or_runner_failure' })
  assert.deepEqual(safeFailure(new sdk.ZooworkError(403, sentinel, sentinel, { bodySnippet: sentinel })), { kind: 'http_failure', http_status: 403 })
})
test('endpoint is explicit HTTPS public prefix; production and credential-bearing URLs are refused', () => {
  assert.equal(baseURL(base + '/', sdk.DEFAULT_BASE_URL), base)
  for (const url of ['', sdk.DEFAULT_BASE_URL, 'http://staging.example.invalid/service/v1', base + '?key=synthetic',
    'https://user:password@staging.example.invalid/service/v1', 'https://staging.example.invalid/v1']) {
    assert.throws(() => baseURL(url, sdk.DEFAULT_BASE_URL))
  }
})
test('guarded fetch pins origin/prefix and refuses redirects even if caller asks to follow', async () => {
  let called = 0
  const transport: typeof fetch = async (_input, init) => { called++; assert.equal(init?.redirect, 'error'); return new Response('{}') }
  const guarded = guardedFetch(base, () => new AbortController().signal, transport)
  await guarded(base + '/models', { redirect: 'follow' })
  await assert.rejects(() => guarded('https://another.example.invalid/service/v1/models'))
  await assert.rejects(() => guarded(base + '/../admin'))
  assert.equal(called, 1)
})
test('cleanup has a separate request reserve after the main budget is exhausted', async () => {
  let cleaning = false
  let called = 0
  const guarded = guardedFetch(base, () => new AbortController().signal,
    async () => { called++; return new Response('{}') }, () => cleaning)
  for (let i = 0; i < 80; i++) await guarded(base + '/models')
  await assert.rejects(() => guarded(base + '/models'))
  cleaning = true
  for (let i = 0; i < 12; i++) await guarded(base + '/agents/agt_SYNTHETIC')
  await assert.rejects(() => guarded(base + '/agents/agt_SYNTHETIC'))
  assert.equal(called, 92)
})
