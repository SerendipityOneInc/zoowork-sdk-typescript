import { expect, expectTypeOf, test } from 'vitest'
import {
  createZooworkClient,
  type AgentWebhookInput,
  type NodeInvocationOutcome,
  type NodeWebhookEventType,
  type NodeWebhookInput,
  type NodeWebhookUpdateInput,
  type ZooworkClient,
} from './index.js'

type Route = [
  path: string,
  call: (client: ZooworkClient) => Promise<unknown>,
  body?: object,
  idempotencyKey?: string,
]

const subscription: NodeWebhookInput = {
  url: 'https://receiver.example/hook',
  event_types: ['node.online'],
}
const approval = { requestId: 'request_1', approvedCaps: { commands: ['system.run'], allowCommands: [] } }
const endpoint = '/nodes/webhooks/wh%2F1'
const routes: Route[] = [
  ['/nodes?agent_id=agent%2F1', c => c.listNodes({ agentId: 'agent/1' })],
  ['/nodes/bootstrap', c => c.createNodeBootstrap({ agentScope: ['agent_1'], ttlMs: 9000 }), { agentScope: ['agent_1'], ttlMs: 9000 }],
  ['/nodes/device_1/approve', c => c.approveNode('device_1', approval), approval],
  ['/nodes/device_1/reject', c => c.rejectNode('device_1', { requestId: 'request_1' }), { requestId: 'request_1' }],
  ['/nodes/device_1/revoke', c => c.revokeNode('device_1'), {}],
  ['/nodes/device_1/tokens/rotate', c => c.rotateNodeToken('device_1', { scopes: ['scope'] }), { scopes: ['scope'] }],
  ['/nodes/device_1/update', c => c.updateNode('device_1', { displayName: null }), { displayName: null }],
  ['/nodes/webhooks', c => c.listNodeWebhooks()],
  ['/nodes/webhooks', c => c.createNodeWebhook(subscription, 'create-1'), subscription, 'create-1'],
  [endpoint, c => c.getNodeWebhook('wh/1')],
  [`${endpoint}/update`, c => c.updateNodeWebhook('wh/1', { event_types: ['node.revoked'], enabled: false }), { event_types: ['node.revoked'], enabled: false }],
  [`${endpoint}/delete`, c => c.deleteNodeWebhook('wh/1'), {}],
  [`${endpoint}/rotate-secret`, c => c.rotateNodeWebhookSecret('wh/1', { revoke_previous_after: 0 }, 'rotate-1'), { revoke_previous_after: 0 }, 'rotate-1'],
  [`${endpoint}/test`, c => c.testNodeWebhook('wh/1'), {}],
  ['/nodes/webhooks/events/event%2F1', c => c.getNodeWebhookEvent('event/1')],
  [`${endpoint}/deliveries?cursor=opaque%2B%2F&limit=1&status=dead&event_type=webhook.test&receipt_id=r%2F1`, c => c.listNodeWebhookDeliveries('wh/1', {
    cursor: 'opaque+/', limit: 1, status: 'dead', eventType: 'webhook.test', receiptId: 'r/1',
  })],
  [`${endpoint}/deliveries/d%2F1`, c => c.getNodeWebhookDelivery('wh/1', 'd/1')],
  [`${endpoint}/deliveries/d%2F1/redeliver`, c => c.redeliverNodeWebhookDelivery('wh/1', 'd/1', 'retry-1'), {}, 'retry-1'],
  [`${endpoint}/deliveries/redeliver`, c => c.redeliverNodeWebhookDeliveries('wh/1', { event_types: ['node.offline'], limit: 1 }, 'batch-1'), { event_types: ['node.offline'], limit: 1 }, 'batch-1'],
]

test.each(routes)('uses the public wire contract at %s', async (path, call, body, key) => {
  const deleting = path.endsWith('/delete')
  const response = { future_field: true, deliveries: [], has_more: true, next_cursor: 'opaque' }
  let requests = 0
  const client = createZooworkClient({ apiKey: 'zwp_live_synthetic', baseUrl: 'https://api.test/service/v1', fetch: async (url, init = {}) => {
    requests += 1
    expect(url).toBe(`https://api.test/service/v1${path}`)
    expect(init.method ?? 'GET').toBe(body === undefined ? 'GET' : 'POST')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer zwp_live_synthetic')
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe(key ?? null)
    if (body === undefined) expect(init.body).toBeUndefined()
    else expect(JSON.parse(String(init.body))).toEqual(body)
    return deleting ? new Response(null, { status: 204 }) : Response.json(response)
  } })

  expect(await call(client)).toEqual(deleting ? undefined : response)
  expect(requests).toBe(1)
})

test('invocation history keeps the Engine result and cursor, and uses public query names', async () => {
  const response = {
    invocations: [{ invocationId: 'inv_1', result: 'confirm_timeout', paramsPreview: null, future_field: 'kept' }],
    nextCursor: 'next+/',
  }
  const client = createZooworkClient({ apiKey: 'zwp_live_synthetic', baseUrl: 'https://api.test/service/v1', fetch: async url => {
    expect(url).toBe('https://api.test/service/v1/nodes/invocations?device_id=d&agent_id=a&cursor=last%2B%2F&limit=25')
    return Response.json(response)
  } })
  const page = await client.listNodeInvocations({ deviceId: 'd', agentId: 'a', cursor: 'last+/', limit: 25 })
  expectTypeOf(page.invocations[0].result).toEqualTypeOf<NodeInvocationOutcome>()
  expect(page).toEqual(response)
})

test('subscription types keep the agent and device APIs distinct', () => {
  expectTypeOf<Extract<AgentWebhookInput['event_types'][number], NodeWebhookEventType>>().toBeNever()
  expectTypeOf<NodeWebhookUpdateInput['event_types'][number]>().toEqualTypeOf<NodeWebhookEventType>()
})
