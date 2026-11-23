import {
  post,
  query,
  type AgentWebhookCreated,
  type AgentWebhookEndpoint,
  type AgentWebhookInput,
  type AgentWebhookSecretRotation,
  type ApiObject,
  type CursorOptions,
  type Request,
  type WebhookBatchRedeliveryInput,
  type WebhookBatchRedeliveryReceipt,
  type WebhookDeliveryOptions,
  type WebhookDeliveryPage,
  type WebhookRedeliveryReceipt,
  type WebhookTestReceipt,
} from './developer-api.js'
import type { NodeWebhookEventType } from './webhooks.js'

export interface NodeBootstrapInput {
  agentScope?: string[]
  ttlMs?: number
}

export interface NodeBootstrap extends ApiObject {
  bootstrapId: string
  setupCode: string
  expiresAt: string
}

export interface NodeApprovedCaps {
  commands?: string[]
  allowCommands?: string[]
}

export interface NodePairedDevice extends ApiObject {
  deviceId: string
  displayName: string | null
  platform: string | null
  status: 'active' | 'revoked'
  online: boolean
  effectiveCaps: string[]
  approvedCaps: NodeApprovedCaps
  agentScope: string[] | null
  createdAt: string
  approvedAt: string | null
  lastSeenAt: string | null
}

export interface NodePendingRequest extends ApiObject {
  requestId: string
  deviceId: string
  kind: 'initial' | 'repair' | 'capability_upgrade'
  declaredCommands: string[]
  supersedesDeviceId: string | null
  createdAt: string
  expiresAt: string
}

export interface NodeList extends ApiObject {
  devices: NodePairedDevice[]
  pending: NodePendingRequest[]
}

export interface NodeApproveInput {
  requestId: string
  approvedCaps?: NodeApprovedCaps
  supersedesDeviceId?: string
}

export type NodeApproval = ApiObject & (
  | { outcome: 'approved'; device: NodePairedDevice; supersededDeviceId?: string }
  | { outcome: 'not_pending' | 'expired' | 'invalid_supersede' | 'device_conflict' | 'device_revoked' }
)

export interface NodeTokenRotation extends ApiObject {
  tokenId: string
  token: string
  rotatedFrom: string | null
}

export interface NodeUpdateInput {
  displayName?: string | null
  agentScope?: string[] | null
}

export interface NodeInvocationOptions extends CursorOptions {
  deviceId?: string
  agentId?: string
}

export type NodeInvocationOutcome =
  | 'success'
  | 'device_error'
  | 'policy_denied'
  | 'user_denied'
  | 'confirm_timeout'
  | 'timeout'
  | 'offline'

export interface NodeInvocation extends ApiObject {
  invocationId: string
  deviceId: string
  ownerUid: string
  orgId: string | null
  agentId: string
  sessionId: string | null
  runId: string | null
  toolCallId: string | null
  command: string
  paramsPreview: string | null
  approvalMode: 'device' | 'engine'
  result: NodeInvocationOutcome
  durationMs: number
  occurredAt: string
}

export interface NodeInvocationPage extends ApiObject {
  invocations: NodeInvocation[]
  nextCursor: string | null
}

export interface NodeWebhookInput extends Omit<AgentWebhookInput, 'event_types'> {
  event_types: NodeWebhookEventType[]
}

export interface NodeWebhookUpdateInput extends Partial<Omit<NodeWebhookInput, 'event_types'>> {
  event_types: NodeWebhookEventType[]
}

export interface NodeWebhookEndpoint extends AgentWebhookEndpoint {
  scope_kind: 'owner'
  event_types: NodeWebhookEventType[]
}

export interface NodeWebhookPage extends ApiObject {
  webhooks: NodeWebhookEndpoint[]
  has_more: false
  next_cursor: null
}

export interface NodeWebhookCreated extends AgentWebhookCreated {
  endpoint: NodeWebhookEndpoint
}

type NodeWebhookDeliveryType = NodeWebhookEventType | 'webhook.test'

export interface NodeWebhookDeliveryOptions extends WebhookDeliveryOptions {
  eventType?: NodeWebhookDeliveryType
}

export interface NodeWebhookBatchRedeliveryInput extends Omit<WebhookBatchRedeliveryInput, 'event_types'> {
  event_types?: NodeWebhookDeliveryType[]
}

/** Device management and owner-scoped device webhooks (beta). Requires a Platform Project key. */
export interface NodesApi {
  listNodes(opts?: { agentId?: string }): Promise<NodeList>
  createNodeBootstrap(input?: NodeBootstrapInput): Promise<NodeBootstrap>
  approveNode(deviceId: string, input: NodeApproveInput): Promise<NodeApproval>
  rejectNode(deviceId: string, input: { requestId: string }): Promise<ApiObject & { outcome: 'rejected' | 'not_pending' }>
  revokeNode(deviceId: string, input?: { reason?: string }): Promise<ApiObject & { revoked: boolean }>
  rotateNodeToken(deviceId: string, input?: { scopes?: string[] }): Promise<NodeTokenRotation>
  updateNode(deviceId: string, input: NodeUpdateInput): Promise<ApiObject & { device: NodePairedDevice }>
  listNodeInvocations(opts?: NodeInvocationOptions): Promise<NodeInvocationPage>
  listNodeWebhooks(): Promise<NodeWebhookPage>
  createNodeWebhook(input: NodeWebhookInput, idempotencyKey?: string): Promise<NodeWebhookCreated>
  getNodeWebhook(webhookId: string): Promise<NodeWebhookEndpoint>
  updateNodeWebhook(webhookId: string, input: NodeWebhookUpdateInput): Promise<NodeWebhookEndpoint>
  deleteNodeWebhook(webhookId: string): Promise<void>
  rotateNodeWebhookSecret(webhookId: string, input: { revoke_previous_after?: 0 | 86400 | null }, idempotencyKey: string): Promise<AgentWebhookSecretRotation>
  testNodeWebhook(webhookId: string, idempotencyKey?: string): Promise<WebhookTestReceipt>
  getNodeWebhookEvent(eventId: string): Promise<ApiObject>
  listNodeWebhookDeliveries(webhookId: string, opts?: NodeWebhookDeliveryOptions): Promise<WebhookDeliveryPage>
  getNodeWebhookDelivery(webhookId: string, deliveryId: string): Promise<ApiObject>
  redeliverNodeWebhookDelivery(webhookId: string, deliveryId: string, idempotencyKey: string): Promise<WebhookRedeliveryReceipt>
  redeliverNodeWebhookDeliveries(webhookId: string, input: NodeWebhookBatchRedeliveryInput, idempotencyKey: string): Promise<WebhookBatchRedeliveryReceipt>
}

export function createNodesApi(json: Request): NodesApi {
  const nodes = '/nodes'
  const webhooks = `${nodes}/webhooks`
  const device = (id: string) => `${nodes}/${encodeURIComponent(id)}`
  const endpoint = (id: string) => `${webhooks}/${encodeURIComponent(id)}`
  const delivery = (id: string, deliveryId: string) => `${endpoint(id)}/deliveries/${encodeURIComponent(deliveryId)}`

  return {
    listNodes: (opts = {}) => json(`${nodes}${query({ agent_id: opts.agentId })}`),
    createNodeBootstrap: (input = {}) => json(`${nodes}/bootstrap`, post(input)),
    approveNode: (id, input) => json(`${device(id)}/approve`, post(input)),
    rejectNode: (id, input) => json(`${device(id)}/reject`, post(input)),
    revokeNode: (id, input = {}) => json(`${device(id)}/revoke`, post(input)),
    rotateNodeToken: (id, input = {}) => json(`${device(id)}/tokens/rotate`, post(input)),
    updateNode: (id, input) => json(`${device(id)}/update`, post(input)),
    listNodeInvocations: (opts = {}) => json(`${nodes}/invocations${query({
      device_id: opts.deviceId,
      agent_id: opts.agentId,
      cursor: opts.cursor,
      limit: opts.limit,
    })}`),
    listNodeWebhooks: () => json(webhooks),
    createNodeWebhook: (input, key) => json(webhooks, post(input, key)),
    getNodeWebhook: (id) => json(endpoint(id)),
    updateNodeWebhook: (id, input) => json(`${endpoint(id)}/update`, post(input)),
    deleteNodeWebhook: async (id) => { await json(`${endpoint(id)}/delete`, post({})) },
    rotateNodeWebhookSecret: (id, input, key) => json(`${endpoint(id)}/rotate-secret`, post(input, key)),
    testNodeWebhook: (id, key) => json(`${endpoint(id)}/test`, post({}, key)),
    getNodeWebhookEvent: (id) => json(`${webhooks}/events/${encodeURIComponent(id)}`),
    listNodeWebhookDeliveries: (id, opts = {}) => json(`${endpoint(id)}/deliveries${query({
      cursor: opts.cursor,
      limit: opts.limit,
      status: opts.status,
      event_type: opts.eventType,
      event_id: opts.eventId,
      receipt_id: opts.receiptId,
      session_id: opts.sessionId,
      run_id: opts.runId,
      schedule_id: opts.scheduleId,
    })}`),
    getNodeWebhookDelivery: (id, deliveryId) => json(delivery(id, deliveryId)),
    redeliverNodeWebhookDelivery: (id, deliveryId, key) => json(`${delivery(id, deliveryId)}/redeliver`, post({}, key)),
    redeliverNodeWebhookDeliveries: (id, input, key) => json(`${endpoint(id)}/deliveries/redeliver`, post(input, key)),
  }
}
