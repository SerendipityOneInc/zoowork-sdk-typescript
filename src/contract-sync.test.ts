/**
 * SYNTHETIC offline inputs for source-reviewed contract additions.
 * No live response recording, real key, or network request is used here. Historical recordings
 * remain untouched in __fixtures__; these tests prove SDK behavior, not server deployment.
 */
import { expect, expectTypeOf, test } from 'vitest'
import {
  createZooworkClient, normalizeEvent, ZooworkError,
  type ApprovalRecord, type OutboundEvent, type ScheduleRun, type ScheduleSpec,
  type SessionRecord, type SkillRecord, type SkillVersionRecord,
} from './index.js'

const BASE = 'https://sdk-contract.test/service/v1'
function harness(reply: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = []
  const client = createZooworkClient({
    apiKey: 'synthetic-unit-key',
    baseUrl: BASE,
    fetch: async (url, init = {}) => {
      calls.push({ url, init })
      return new Response(JSON.stringify(reply), {
        status, headers: { 'Content-Type': 'application/json', 'x-request-id': 'synthetic-request' },
      })
    },
  })
  return { client, calls }
}

test('actor.ref survives both createSession and postEvents without authorizing an end user', async () => {
  const event: OutboundEvent = {
    type: 'user.message', content: 'Synthetic message', actor: { ref: 'customer-42' },
    idempotency_key: 'synthetic-message-1', extension: { retained: true },
  }
  const { client, calls } = harness({ session_id: 'session-test', events: [{ accepted: true }] }, 202)
  await client.createSession('agent-test', { initial_events: [event] })
  await client.postEvents('agent-test', 'session-test', [event])
  expect(JSON.parse(String(calls[0].init.body))).toEqual({ initial_events: [event] })
  expect(JSON.parse(String(calls[1].init.body))).toEqual({ events: [event] })
  expectTypeOf(event.actor).toEqualTypeOf<{ ref: string; token?: never } | undefined>()
  // @ts-expect-error actor.token is not a supported authentication mechanism.
  const badActor: OutboundEvent = { type: 'user.message', actor: { ref: 'customer-42', token: 'synthetic' } }
  // @ts-expect-error actor.ref is required when actor is present.
  const emptyActor: OutboundEvent = { type: 'user.message', actor: {} }
  void badActor
  void emptyActor
})

test('invalid-event HTTP failures reject; accepted:false is a distinct successful receipt', async () => {
  const bad = harness({ error: { type: 'invalid_event', message: 'Synthetic invalid event' } }, 400)
  await expect(bad.client.postEvents('a', 's', [{ type: 'unsupported.event' }]))
    .rejects.toMatchObject({ status: 400, type: 'invalid_event' })
  expect(bad.calls).toHaveLength(1) // no automatic retry
  const rejected = harness({ events: [{ type: 'user.interrupt', accepted: false }] }, 202)
  expect(await rejected.client.postEvents('a', 's', [{ type: 'user.interrupt' }]))
    .toEqual({ events: [{ type: 'user.interrupt', accepted: false }] })
})

test('everyMs and anchorMs serialize unchanged for create and update', async () => {
  const schedule = { kind: 'every', everyMs: 60_000, anchorMs: 0 } satisfies ScheduleSpec
  const { client, calls } = harness({})
  await client.createSchedule('a', { schedule_id: 'interval-test', schedule, payload: { kind: 'agentTurn', message: 'Synthetic' } })
  await client.updateSchedule('a', 'interval-test', { schedule })
  for (const call of calls) {
    const sent = JSON.parse(String(call.init.body)).schedule
    expect(sent).toEqual(schedule)
    expect(sent).not.toHaveProperty('every')
  }
  // @ts-expect-error The old every field does not satisfy the actual interval contract.
  const obsolete: ScheduleSpec = { kind: 'every', every: '1m' }
  void obsolete
})

test('ScheduleRun preserves an optional linked session without manufacturing one', async () => {
  const runs = [
    { source: 'run_projection', status: 'succeeded', session_id: 'session-linked' },
    { source: 'temporal', workflow_id: 'synthetic-dispatch' },
  ]
  const { client } = harness({ runs })
  const actual = await client.listScheduleRuns('a', 'schedule-test')
  expect(actual).toEqual(runs)
  expectTypeOf(actual[0].session_id).toEqualTypeOf<string | undefined>()
  const linked: ScheduleRun = actual[0]
  expect(linked.session_id).toBe('session-linked')
  expect(actual[1]).not.toHaveProperty('session_id')
})

test('skill create and version upload keep distinct response records and multipart fields', async () => {
  const version: SkillVersionRecord = { skill_id: 'skill-test', version: '2', state: 'ready', extra: 'retained' }
  const upload = harness(version, 201)
  const result = await upload.client.uploadSkillVersion('skill-test', new Uint8Array([1, 2]), { description: 'Synthetic version description' })
  expectTypeOf(result).toEqualTypeOf<SkillVersionRecord>()
  expect(result).toEqual(version)
  expect(result).not.toHaveProperty('latest_version')
  expect((upload.calls[0].init.body as FormData).get('description')).toBe('Synthetic version description')
  const record: SkillRecord = { skill_id: 'skill-test', latest_version: '1', status: 'active' }
  const create = harness(record, 201)
  expectTypeOf(await create.client.uploadSkill(new Uint8Array([1]), { scope: 'org' })).toEqualTypeOf<SkillRecord>()
  expect((create.calls[0].init.body as FormData).get('scope')).toBe('org')
})

test('getEnvironmentVersion preserves the old URL and optionally sends resource_class', async () => {
  const { client, calls } = harness({ environment_id: 'env-test', version: 1, status: 'partial_ready' })
  expect((await client.getEnvironmentVersion('env-test', 1)).status).toBe('partial_ready')
  await client.getEnvironmentVersion('env/test', 1, { resourceClass: 'pro' })
  expect(calls[0].url).toBe(BASE + '/environments/env-test/versions/1')
  expect(calls[1].url).toBe(BASE + '/environments/env%2Ftest/versions/1?resource_class=pro')
  expect(calls[1].init.method ?? 'GET').toBe('GET')
})

test('SessionRecord can represent no latest run and the pending approval count', async () => {
  const row: SessionRecord = { session_id: 'session-test', run_status: null, pending_approvals: 1 }
  const { client } = harness(row)
  const result = await client.getSession('a', 'session-test')
  expect(result).toEqual(row)
  expectTypeOf(result.run_status).toEqualTypeOf<string | null | undefined>()
  expectTypeOf(result.pending_approvals).toEqualTypeOf<number | undefined>()
})

test('approval fields and a 202 pending receipt remain distinct from completed execution', async () => {
  const approval: ApprovalRecord = {
    approval_id: 'approval-test', session_id: 'session-test', tool_name: 'synthetic_tool',
    status: 'pending', arguments_preview: '{}', requested_at: '2026-01-01T00:00:00Z',
    timeout_at: '2026-01-01T00:05:00Z', allowed_decisions: ['allow-once', 'deny'],
  }
  const list = harness({ approvals: [approval] })
  expect(await list.client.listApprovals('a')).toEqual([approval])
  const resolve = harness({ ...approval, signaled: true, decision: 'allow-once' }, 202)
  const receipt = await resolve.client.resolveApproval('a', 'approval-test', { decision: 'allow-once' })
  expectTypeOf(receipt).toEqualTypeOf<ApprovalRecord>()
  expect(receipt.status).toBe('pending')
  expect(receipt.signaled).toBe(true)
  expect(receipt).not.toHaveProperty('created_at')
  expect(receipt).not.toHaveProperty('resolved_at')
})

test('MCP reasons and future payload fields survive normalization', () => {
  const payload = { kind: 'mcp_authentication_failed', server: 'synthetic', errorMessage: 'Denied', reason: 'future_reason', extra: true }
  expect(normalizeEvent({ seq: 8, event_type: 'agent.error', payload }).payload).toEqual(payload)
})

test('SSE resume keeps an opaque cursor in the query and preserves the next cursor', async () => {
  let sentUrl = ''
  let headers: HeadersInit | undefined
  const client = createZooworkClient({
    apiKey: 'synthetic-unit-key', baseUrl: BASE,
    fetch: async (url, init = {}) => {
      sentUrl = url
      headers = init.headers
      return new Response('id: opaque:next\ndata: {"seq":9,"event_type":"user.message","payload":{"content":"synthetic"}}\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    },
  })
  const events = []
  for await (const event of client.streamEvents('a', 's', { cursor: 'opaque:prior/+=' })) events.push(event)
  expect(new URL(sentUrl).searchParams.get('cursor')).toBe('opaque:prior/+=')
  expect(new URL(sentUrl).searchParams.has('after')).toBe(false)
  expect(new Headers(headers).has('Last-Event-ID')).toBe(false)
  expect(events[0].cursor).toBe('opaque:next')
  expect(events[0].eventType).toBe('user.message')
})

test('stream-open and stop HTTP failures preserve errors instead of resolving as warnings', async () => {
  const { client, calls } = harness({ code: 'service_api.upstream_error', message: 'Synthetic upstream failure', request_id: 'synthetic-request' }, 502)
  await expect(client.streamEvents('a', 's').next()).rejects.toMatchObject({
    status: 502, type: 'service_api.upstream_error', requestId: 'synthetic-request', retryable: true,
  })
  await expect(client.stopAgent('a')).rejects.toBeInstanceOf(ZooworkError)
  expect(calls).toHaveLength(2) // neither method silently retries or treats HTTP failure as success
})
