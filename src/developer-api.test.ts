import { expect, test } from 'vitest'
import { createZooworkClient, ZooworkError, type ZooworkClient, type AgentResource, type AgentRecord, type SessionRecord, type ScheduleRecord, type ScheduleRun } from './index.js'

const routes: [string, string, (c: ZooworkClient) => Promise<unknown>][] = [
  ['GET', '/agents/a/database', c => c.getAgentDatabase('a')],
  ['GET', '/agents/a/database/tables/a%20b/rows?limit=1&offset=0', c => c.getAgentDatabaseRows('a', 'a b', { limit: 1, offset: 0 })],
  ['POST', '/agents/a/files', c => c.writeWorkspaceFile('a', '/workspace/a.txt', 'text')],
  ['GET', '/usage?group_by=api_key&per_page=2&snapshot=opaque&cursor=x%2By', c => c.getUsage({ groupBy: 'api_key', perPage: 2, snapshot: 'opaque', cursor: 'x+y' })],
  ['GET', '/agents/a/sessions/s/runs/r/output?cursor=pro1%3A7&limit=2', c => c.getRunOutput('a', 's', 'r', { cursor: 'pro1:7', limit: 2 })],
  ['GET', '/agents/a/approvals/ap%20id', c => c.getApproval('a', 'ap id')],
  ['GET', '/agents/a/custom_tool_calls/c%20id', c => c.getCustomToolCall('a', 'c id')],
  ['GET', '/agents/a/approvals?session_id=s&limit=50', c => c.listApprovalPage('a', { sessionId: 's' })],
  ['GET', '/agents/a/custom_tool_calls?status=pending&cursor=pal1%3Aopaque&limit=1', c => c.listCustomToolCallPage('a', { status: 'pending', cursor: 'pal1:opaque', limit: 1 })],
  ['GET', '/agents/a/webhooks?cursor=opaque&limit=2', c => c.listAgentWebhooks('a', { cursor: 'opaque', limit: 2 })],
  ['GET', '/agents/a/webhooks/w', c => c.getAgentWebhook('a', 'w')],
  ['POST', '/agents/a/webhooks/w/update', c => c.updateAgentWebhook('a', 'w', { description: null, enabled: false })],
  ['POST', '/agents/a/webhooks/w/delete', c => c.deleteAgentWebhook('a', 'w')],
  ['GET', '/agents/a/webhooks/events/e', c => c.getAgentWebhookEvent('a', 'e')],
  ['GET', '/agents/a/webhooks/w/deliveries?status=dead&event_type=run.finished&session_id=s', c => c.listAgentWebhookDeliveries('a', 'w', { status: 'dead', eventType: 'run.finished', sessionId: 's' })],
  ['GET', '/agents/a/webhooks/w/deliveries/d', c => c.getAgentWebhookDelivery('a', 'w', 'd')],
]
for (const key of ['zct_synthetic_key', 'zwp_live_synthetic_key']) {
  test.each(routes)(`${key.split('_')[0]} forwards %s %s with the same transport`, async (method, path, call) => {
    const requests: { url: string; init: RequestInit }[] = []
    const response = { future_field: { nested: true }, signing_secret: null, signing_secret_available: false, next_cursor: 'opaque', has_more: true }
    const c = createZooworkClient({ apiKey: key, baseUrl: 'https://api.test', fetch: async (url, init = {}) => {
      requests.push({ url, init }); return new Response(JSON.stringify(response))
    } })
    const result = await call(c)
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe(`https://api.test${path}`)
    expect(requests[0].init.method ?? 'GET').toBe(method)
    expect(new Headers(requests[0].init.headers).get('Authorization')).toBe(`Bearer ${key}`)
    if (!path.endsWith('/delete')) expect(result).toEqual(response)
    if (path.endsWith('/update')) expect(JSON.parse(String(requests[0].init.body))).toEqual({ description: null, enabled: false })
  })
}

test('webhook mutations preserve stable idempotency keys, receipts and nullable replay secrets', async () => {
  const bodies: unknown[] = []
  const paths: string[] = []
  const c = createZooworkClient({ apiKey: 'zwp_live_synthetic', baseUrl: 'https://api.test', fetch: async (url, init = {}) => {
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe('same-operation')
    expect(init.method).toBe('POST')
    paths.push(new URL(url).pathname)
    bodies.push(JSON.parse(String(init.body)))
    return new Response(JSON.stringify({ signing_secret: null, signing_secret_available: false, object: 'webhook_test', receipt_id: 'receipt' }), { status: 202 })
  } })
  const created = await c.createAgentWebhook('a', { url: 'https://receiver.example/hook', event_types: ['run.finished'] }, 'same-operation')
  expect(created.signing_secret).toBeNull()
  expect(created.signing_secret_available).toBe(false)
  await c.rotateAgentWebhookSecret('a', 'w', { revoke_previous_after: 0 }, 'same-operation')
  expect((await c.testAgentWebhook('a', 'w', 'same-operation')).receipt_id).toBe('receipt')
  await c.redeliverAgentWebhookDelivery('a', 'w', 'd', 'same-operation')
  await c.redeliverAgentWebhookDeliveries('a', 'w', { status: 'dead', since: null, limit: 1 }, 'same-operation')
  expect(paths).toEqual(['/agents/a/webhooks', '/agents/a/webhooks/w/rotate-secret', '/agents/a/webhooks/w/test', '/agents/a/webhooks/w/deliveries/d/redeliver', '/agents/a/webhooks/w/deliveries/redeliver'])
  expect(bodies).toEqual([{ url: 'https://receiver.example/hook', event_types: ['run.finished'] }, { revoke_previous_after: 0 }, {}, {}, { status: 'dead', since: null, limit: 1 }])
})

test('file reads derive ownership once and preserve raw bytes, paths and false options', async () => {
  const calls: string[] = []
  const raw = new Uint8Array([0, 255, 128])
  const c = createZooworkClient({ apiKey: 'zct_synthetic', baseUrl: 'https://api.test', fetch: async url => {
    calls.push(url)
    if (url.endsWith('/agents/a')) return new Response(JSON.stringify({ ownership: { owner_uid: 'u', org_id: 'o', project_id: null } }))
    if (url.includes('/content?')) return new Response(raw)
    return new Response(JSON.stringify({ path: '/workspace', entries: [] }))
  } })
  await c.getWorkspaceFile('a', '/workspace', { showHidden: false })
  expect(await c.getWorkspaceFileContent('a', '/workspace/a b.bin', { download: false })).toEqual(raw)
  expect(calls).toEqual(['https://api.test/agents/a', 'https://api.test/agents/a/files?owner_uid=u&org_id=o&path=%2Fworkspace&showHidden=false', 'https://api.test/agents/a/files/content?owner_uid=u&org_id=o&path=%2Fworkspace%2Fa+b.bin&download=false'])
})

test.each([{ code: 'service_api.not_found', detail: 'hidden' }, { error: { type: 'invalid_pagination', message: 'bad' } }])('binary and JSON errors retain codes without retrying writes', async body => {
  let count = 0
  const c = createZooworkClient({ apiKey: 'zwp_live_synthetic', fetch: async () => {
    count++; return new Response(JSON.stringify(body), { status: 409 })
  } })
  await expect(c.testAgentWebhook('a', 'w', 'stable')).rejects.toMatchObject({ status: 409, type: 'code' in body ? body.code : body.error.type })
  expect(count).toBe(1)
  expect(ZooworkError).toBeDefined()
})

test('typed confirmation and active session options preserve true, false and omission', async () => {
  const resources: AgentResource[] = [true, false, undefined].map(requireConfirmation => ({
    name: 'test', skills: [{ name: 'catalog-skill' }], mcp: [{ name: 'tools', url: 'https://tools.example/mcp', tools: { operation: { permission: 'always_ask', ...(requireConfirmation === undefined ? {} : { requireConfirmation }) } } }],
  }))
  const bodies: Record<string, unknown>[] = []
  const c = createZooworkClient({ apiKey: 'zct_synthetic', fetch: async (_, init) => {
    bodies.push(JSON.parse(String(init?.body))); return new Response('{}')
  } })
  for (const resource of resources) await c.createAgent({ resource })
  for (const resource of resources) await c.updateAgent('a', { mcp: resource.mcp, expected_config_version: 2 })
  await c.createSession('a', { runtime_mode: 'active', idle_compaction: false })
  await c.createSession('a', {})
  expect(bodies.slice(3, 6)).toEqual(resources.map(resource => ({ mcp: resource.mcp, expected_config_version: 2 })))
  expect(bodies.slice(6)).toEqual([{ runtime_mode: 'active', idle_compaction: false }, {}])
  expect((bodies[0].resource as AgentResource).mcp?.[0].tools?.operation.requireConfirmation).toBe(true)
  expect((bodies[1].resource as AgentResource).mcp?.[0].tools?.operation.requireConfirmation).toBe(false)
  expect((bodies[2].resource as AgentResource).mcp?.[0].tools?.operation).not.toHaveProperty('requireConfirmation')
})

// These synthetic payloads exercise source-reviewed additions; recorded live fixtures stay unchanged.
test('new projection metadata survives reads without dropping unknown fields', async () => {
  const agent: AgentRecord = { agent_id: 'a', sandbox_resource_class: 'pro', ownership: { owner_uid: 'u', org_id: 'o', project_id: null, visibility: 'private' } }
  const session: SessionRecord = { session_id: 's', idle_compaction: false, pinned_config_version: 3, pending_approval_ids: ['ap'], pending_approval_ids_complete: false, pending_custom_tool_call_ids: ['ct'], pending_custom_tool_call_ids_complete: true }
  const schedule: ScheduleRecord = { schedule_id: 'daily' }
  const run: ScheduleRun = { schedule_id: 'daily', session_id: 's', run_id: 'r', linked_by: 'session', trigger: 'schedule' }
  const responses = [agent, session, schedule, { runs: [run] }]
  const c = createZooworkClient({ apiKey: 'zwp_live_synthetic', fetch: async () => new Response(JSON.stringify(responses.shift())) })
  expect(await c.getAgent('a')).toEqual(agent)
  expect(await c.getSession('a', 's')).toEqual(session)
  expect(await c.getSchedule('a', 'daily')).toEqual(schedule)
  expect(await c.listScheduleRuns('a', 'daily')).toEqual([run])
})

test('binary response failures use the shared error envelopes', async () => {
  let count = 0
  const c = createZooworkClient({ apiKey: 'zwp_live_synthetic', fetch: async () => {
    count++
    if (count === 1) return new Response(JSON.stringify({ ownership: { owner_uid: 'u', org_id: 'o' } }))
    return new Response(JSON.stringify({ code: 'service_api.not_found', detail: 'hidden' }), { status: 404 })
  } })
  await expect(c.getWorkspaceFileContent('a', '/workspace/missing')).rejects.toMatchObject({ status: 404, type: 'service_api.not_found' })
  expect(count).toBe(2)
})
