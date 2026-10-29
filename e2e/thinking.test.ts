// Synthetic lifecycle and fault-injection tests, never contacts a deployment.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ZooworkClient } from '../src/index.js'
import { thinkingSmoke } from './thinking-smoke.ts'
import { guardedFetch } from './guard.ts'

const sensitive = 'synthetic-sensitive-response-do-not-persist'
function setup(options: { missingCapability?: boolean; badDefault?: boolean; missingMetadata?: boolean; wrongLevel?: boolean; cleanupFailure?: boolean; skipDispatch?: boolean; uncertainCreate?: boolean } = {}) {
  const calls: string[] = []
  const sessions = new Map<string, { level: string; cron: boolean }>()
  let level: string | null = 'high'
  let payload: { kind: string; thinking?: string | null } = { kind: 'agentTurn', thinking: 'low' }
  let deleted = false
  let scheduleId = ''
  const client = {
    listModels: async () => [{ model: 'synthetic', ...(options.missingCapability ? {} : { thinking: { default: options.badDefault ? 'unsupported' : 'medium', levels: ['off', 'low', 'medium', 'high', 'max'] } }) }],
    createAgent: async () => { calls.push('create'); if (options.uncertainCreate) throw Error(sensitive); return { agent_id: 'agt_SYNTHETIC' } },
    listAgents: async () => ({ total: 0, data: [] }),
    getAgent: async () => { if (deleted) throw { status: 404 }; return { declared: { model: { primary: 'synthetic', ...(level === null ? {} : { thinking: level }) } } } },
    updateAgent: async (_agent: string, input: { model: { thinking: string | null } }) => { level = input.model.thinking; calls.push(`set:${level}`) },
    startAgent: async () => ({}), waitUntilRunning: async () => ({}),
    createSession: async () => { const id = `SYNTHETIC_${sessions.size}`; sessions.set(id, { level: level ?? 'medium', cron: false }); return { session_id: id } },
    getSession: async (_agent: string, id: string) => ({ run_status: 'succeeded', history: [{ entry: { type: 'message', message: { role: 'assistant', content: sensitive },
      ...(options.missingMetadata ? {} : { metadata: { thinking: { level: options.wrongLevel ? 'low' : sessions.get(id)!.level } } }) } }] }),
    listSessions: async () => [...sessions].map(([id, s]) => ({ session_id: id, channel: s.cron ? 'cron' : 'api', session_key: `agent:agt_SYNTHETIC:cron:${scheduleId}:${id}` })),
    createSchedule: async (_agent: string, input: { schedule_id: string; payload: typeof payload; enabled: boolean; schedule: { at: string } }) => {
      scheduleId = input.schedule_id; payload = input.payload; calls.push('create_schedule')
      assert.equal(input.enabled, true); assert.ok(Date.parse(input.schedule.at) > Date.now() + 6 * 86_400_000)
    },
    getSchedule: async () => ({ payload }),
    updateSchedule: async (_agent: string, _schedule: string, input: { payload: { thinking: null } }) => { assert.equal(input.payload.thinking, null); payload = { kind: 'agentTurn' } },
    triggerSchedule: async () => { if (!options.skipDispatch) sessions.set(`SYNTHETIC_${sessions.size}`, { level: payload.thinking ?? level ?? 'medium', cron: true }); return { triggered: true } },
    listScheduleRuns: async () => [...sessions].filter(([, s]) => s.cron).reverse().map(([id]) => ({ session_id: id })),
    deleteSchedule: async () => { calls.push('delete_schedule'); if (options.cleanupFailure) throw { status: 503, message: sensitive } },
    deleteSession: async (_agent: string, id: string) => { calls.push('delete_session'); sessions.delete(id) },
    stopAgent: async () => { calls.push('stop'); return {} },
    deleteAgent: async () => { calls.push('delete'); deleted = true },
  } as unknown as ZooworkClient
  return { client, calls }
}
async function run(options: Parameters<typeof setup>[0] = {}) {
  const f = setup(options)
  const result = await thinkingSmoke(f.client, { runId: 'synthetic-run', signal: new AbortController().signal,
    save: () => {}, cleanupMode: () => {}, pollAttempts: 2, delay: async () => {} })
  assert.equal(JSON.stringify(result).includes(sensitive), false)
  return { ...f, result }
}
test('actual turn levels prove Agent set/clear and Schedule override/clear', async () => {
  const f = await run()
  assert.equal(f.result.passed, true)
  assert.deepEqual(f.result.observations.map(row => row.levels), [['high'], ['medium'], ['low'], ['high']])
  assert.equal(f.result.cleanup.complete, true)
  assert.ok(f.calls.indexOf('delete_schedule') < f.calls.indexOf('stop'))
  assert.ok(f.calls.indexOf('stop') < f.calls.indexOf('delete'))
  assert.equal(f.calls.filter(c => c === 'delete_session').length, 4)
})
test('missing capability fails before mutations', async () => {
  const f = await run({ missingCapability: true })
  assert.equal(f.result.passed, false); assert.equal(f.result.cleanup.complete, true)
  assert.deepEqual(f.calls, [])
})
test('malformed model default fails before mutations', async () => {
  const f = await run({ badDefault: true })
  assert.equal(f.result.passed, false); assert.deepEqual(f.calls, [])
})
for (const fault of ['missingMetadata', 'wrongLevel'] as const) test(`${fault} never passes from a successful reply`, async () => {
  const f = await run({ [fault]: true })
  assert.equal(f.result.passed, false); assert.equal(f.result.cleanup.complete, true)
  assert.equal(f.calls.includes('delete'), true)
})
test('a trigger acknowledgement without a new Session fails and cleans up', async () => {
  const f = await run({ skipDispatch: true })
  assert.equal(f.result.passed, false)
  assert.equal(f.result.failure?.kind, 'schedule_override_dispatch_timeout')
  assert.equal(f.result.cleanup.complete, true)
})
test('failed Schedule deletion preserves the Agent for recovery', async () => {
  const f = await run({ cleanupFailure: true })
  assert.equal(f.result.passed, false); assert.equal(f.result.cleanup.complete, false)
  assert.equal(f.calls.includes('delete'), false)
})
test('uncertain Agent creation is not retried or counted as cleaned up', async () => {
  const f = await run({ uncertainCreate: true })
  assert.equal(f.calls.filter(c => c === 'create').length, 1)
  assert.equal(f.result.passed, false); assert.equal(f.result.cleanup.complete, false)
  assert.equal(f.result.resources.creation_uncertain, true)
  assert.equal(f.calls.includes('delete'), false)
})
test('expanded request bounds retain an independent cleanup reserve', async () => {
  let cleaning = false
  const fetcher = guardedFetch('https://synthetic.invalid/service/v1', () => new AbortController().signal,
    (async () => Response.json({})) as typeof fetch, () => cleaning, { main: 1, cleanup: 2 })
  const url = 'https://synthetic.invalid/service/v1/models'
  await fetcher(url); await assert.rejects(fetcher(url), /request_budget_exceeded/)
  cleaning = true; await fetcher(url); await fetcher(url)
  await assert.rejects(fetcher(url), /request_budget_exceeded/)
})

for (const phase of ['exercise', 'cleanup'] as const) test(`record write failure during ${phase} cannot skip cleanup`, async () => {
  const f = setup()
  const result = await thinkingSmoke(f.client, { runId: 'synthetic-run', signal: new AbortController().signal,
    save: record => {
      if (record.resources.agent_id && (phase === 'exercise' || record.cleanup.steps.length > 0)) throw Error(sensitive)
    }, cleanupMode: () => {}, pollAttempts: 2, delay: async () => {} })
  assert.equal(result.passed, false)
  assert.equal(result.failure?.kind, 'record_write_failed')
  assert.equal(result.cleanup.complete, true)
  assert.equal(f.calls.includes('delete'), true)
  assert.equal(JSON.stringify(result).includes(sensitive), false)
})
test('without --model the platform default model is chosen when it qualifies', async () => {
  const capable = { default: 'medium', levels: ['off', 'low', 'medium', 'high', 'max'] }
  const pick = async (rows: unknown[]) => {
    const f = setup()
    f.client.listModels = async () => rows as Awaited<ReturnType<ZooworkClient['listModels']>>
    return (await thinkingSmoke(f.client, { runId: 'synthetic-run', signal: new AbortController().signal,
      save: () => {}, cleanupMode: () => {}, pollAttempts: 2, delay: async () => {} })).model
  }
  assert.equal(await pick([{ model: 'first', thinking: capable }, { model: 'platform-default', default_for: ['model'], thinking: capable }]), 'platform-default')
  assert.equal(await pick([{ model: 'first', thinking: capable }, { model: 'platform-default', default_for: ['model'], thinking: { default: 'off', levels: ['off'] } }]), 'first')
})
