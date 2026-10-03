import type { ApprovalRecord, CustomToolCallRecord, Ownership } from './client.js';
import type { WebhookEventType } from './webhooks.js';
/** Response fields retain their API spelling; unknown additions are preserved. */
export type ApiObject = Record<string, unknown>;
export interface CursorOptions {
    cursor?: string;
    limit?: number;
}
export interface ActionListOptions extends CursorOptions {
    status?: 'pending';
    sessionId?: string;
}
export interface ApprovalPage extends ApiObject {
    approvals: ApprovalRecord[];
    has_more: boolean;
    next_cursor: string | null;
}
export interface CustomToolCallPage extends ApiObject {
    custom_tool_calls: CustomToolCallRecord[];
    has_more: boolean;
    next_cursor: string | null;
}
export interface WorkspaceFileEntry extends ApiObject {
    name: string;
    type: string;
    size?: number;
    updated_at?: string;
}
export type WorkspaceFile = (ApiObject & {
    path: string;
    content: string;
}) | (ApiObject & {
    path: string;
    entries: WorkspaceFileEntry[];
});
export interface AgentDatabase extends ApiObject {
    status: 'not_provisioned' | 'ready';
    tables?: {
        name: unknown;
        kind: unknown;
    }[];
}
export interface AgentDatabaseRows extends ApiObject {
    status: 'not_provisioned' | 'ready';
    table?: string;
    schema?: unknown[][];
    columns?: string[];
    rows?: unknown[][];
    limit?: number;
    offset?: number;
}
export interface UsageOptions {
    range?: '24h' | '7d' | '30d';
    timezone?: string;
    groupBy?: 'session' | 'api_key';
    view?: 'groups' | 'records' | 'both';
    sessionId?: string;
    apiKeyId?: string;
    rootSessionId?: string;
    attribution?: 'exact' | 'shared' | 'non_api' | 'unattributed';
    page?: number;
    perPage?: number;
    asOf?: string;
    snapshot?: string;
    cursor?: string;
}
export interface UsageResult extends ApiObject {
    groups?: ApiObject[];
    records?: ApiObject[];
}
export interface RunOutputArtifact extends ApiObject {
    artifact_id: string | null;
    name: string;
    content_type: string;
    size: number;
}
export interface RunOutputItem extends ApiObject {
    seq: number;
    kind: string;
    source: string;
    text?: string;
    artifacts: RunOutputArtifact[];
}
export interface RunOutput extends ApiObject {
    run: ApiObject;
    items: RunOutputItem[];
    has_more: boolean;
    next_cursor: string | null;
    output_complete: boolean;
}
export interface AgentWebhookInput {
    url: string;
    event_types: Exclude<WebhookEventType, 'webhook.test'>[];
    description?: string | null;
    session_scope?: 'api' | 'all';
    enabled?: boolean;
}
export interface AgentWebhookEndpoint extends ApiObject {
    id: string;
    url?: string;
    event_types?: string[];
    description?: string | null;
    session_scope?: string;
    enabled?: boolean;
}
export interface AgentWebhookPage extends ApiObject {
    webhooks: AgentWebhookEndpoint[];
    has_more: boolean;
    next_cursor: string | null;
}
export interface AgentWebhookCreated extends ApiObject {
    endpoint: AgentWebhookEndpoint;
    signing_secret: string | null;
    signing_secret_version: number;
    signing_secret_available: boolean;
}
export interface AgentWebhookSecretRotation extends ApiObject {
    endpoint_id: string;
    signing_secret: string | null;
    signing_secret_version: number;
    signing_secret_available: boolean;
    previous_versions?: unknown[];
}
export interface WebhookDeliveryOptions extends CursorOptions {
    status?: 'pending' | 'in_flight' | 'succeeded' | 'dead' | 'cancelled';
    eventType?: string;
    eventId?: string;
    sessionId?: string;
    runId?: string;
    scheduleId?: string;
}
export interface WebhookDeliveryPage extends ApiObject {
    deliveries: ApiObject[];
    has_more: boolean;
    next_cursor: string | null;
}
/** These receipts acknowledge queuing, not receiver or business processing. */
export interface WebhookTestReceipt extends ApiObject {
    object: 'webhook_test';
    endpoint_id: string;
    receipt_id: string;
}
export interface WebhookRedeliveryReceipt extends ApiObject {
    object: 'webhook_redelivery';
    delivery_id: string;
    round: number;
    deadline_at: string;
}
export interface WebhookBatchRedeliveryReceipt extends ApiObject {
    object: 'webhook_redelivery_batch';
    count: number;
}
export interface WebhookBatchRedeliveryInput {
    status?: 'dead';
    since?: string | null;
    event_types?: string[] | null;
    limit?: number;
}
export interface DeveloperApi {
    /**
     * @deprecated The hosted service does not enable the workspace Files routes; this call
     * fails with HTTP 501 or 502. Ask the Agent to publish an Artifact and download that.
     */
    getWorkspaceFile(agentId: string, path: string, opts?: {
        showHidden?: boolean;
    }): Promise<WorkspaceFile>;
    /**
     * @deprecated The hosted service does not enable the workspace Files routes; this call
     * fails with HTTP 501 or 502. Use `uploadFile` to send a file to an Agent.
     */
    writeWorkspaceFile(agentId: string, path: string, content: string): Promise<ApiObject>;
    /**
     * @deprecated The hosted service does not enable the workspace Files routes; this call
     * fails with HTTP 501 or 502. Ask the Agent to publish an Artifact and download that.
     */
    getWorkspaceFileContent(agentId: string, path: string, opts?: {
        download?: boolean;
    }): Promise<Uint8Array>;
    getAgentDatabase(agentId: string): Promise<AgentDatabase>;
    getAgentDatabaseRows(agentId: string, tableName: string, opts?: {
        limit?: number;
        offset?: number;
    }): Promise<AgentDatabaseRows>;
    getUsage(opts?: UsageOptions): Promise<UsageResult>;
    getRunOutput(agentId: string, sessionId: string, runId: string, opts?: CursorOptions): Promise<RunOutput>;
    getApproval(agentId: string, approvalId: string): Promise<ApprovalRecord>;
    getCustomToolCall(agentId: string, callId: string): Promise<CustomToolCallRecord>;
    listApprovalPage(agentId: string, opts?: ActionListOptions): Promise<ApprovalPage>;
    listCustomToolCallPage(agentId: string, opts?: ActionListOptions): Promise<CustomToolCallPage>;
    listAgentWebhooks(agentId: string, opts?: CursorOptions): Promise<AgentWebhookPage>;
    createAgentWebhook(agentId: string, input: AgentWebhookInput, idempotencyKey: string): Promise<AgentWebhookCreated>;
    getAgentWebhook(agentId: string, webhookId: string): Promise<AgentWebhookEndpoint>;
    updateAgentWebhook(agentId: string, webhookId: string, input: Partial<AgentWebhookInput>): Promise<AgentWebhookEndpoint>;
    deleteAgentWebhook(agentId: string, webhookId: string): Promise<void>;
    rotateAgentWebhookSecret(agentId: string, webhookId: string, input: {
        revoke_previous_after: 0 | 86400;
    }, idempotencyKey: string): Promise<AgentWebhookSecretRotation>;
    testAgentWebhook(agentId: string, webhookId: string, idempotencyKey: string): Promise<WebhookTestReceipt>;
    getAgentWebhookEvent(agentId: string, eventId: string): Promise<ApiObject>;
    listAgentWebhookDeliveries(agentId: string, webhookId: string, opts?: WebhookDeliveryOptions): Promise<WebhookDeliveryPage>;
    getAgentWebhookDelivery(agentId: string, webhookId: string, deliveryId: string): Promise<ApiObject>;
    redeliverAgentWebhookDelivery(agentId: string, webhookId: string, deliveryId: string, idempotencyKey: string): Promise<WebhookRedeliveryReceipt>;
    redeliverAgentWebhookDeliveries(agentId: string, webhookId: string, input: WebhookBatchRedeliveryInput, idempotencyKey: string): Promise<WebhookBatchRedeliveryReceipt>;
}
type Request = <T>(path: string, init?: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
}) => Promise<T>;
const segment = encodeURIComponent;
function query(params: Record<string, string | number | boolean | undefined>): string {
    const result = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
        if (value !== undefined)
            result.set(key, String(value));
    return result.size ? `?${result}` : '';
}
function post(body: unknown, idempotencyKey?: string) {
    return { method: 'POST', body: JSON.stringify(body), ...(idempotencyKey !== undefined ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}) };
}
/** Uses the same authentication/error transport as the existing client. Never retries writes. */
export function createDeveloperApi(json: Request, bytes: (path: string) => Promise<Uint8Array>, selectors: (agentId: string) => Promise<Pick<Ownership, 'owner_uid' | 'org_id'>>): DeveloperApi {
    const agent = (id: string) => `/agents/${segment(id)}`;
    const webhooks = (id: string) => `${agent(id)}/webhooks`;
    const endpoint = (id: string, webhookId: string) => `${webhooks(id)}/${segment(webhookId)}`;
    return {
        getWorkspaceFile: async (id, path, opts = {}) => json(`${agent(id)}/files${query({ ...await selectors(id), path, showHidden: opts.showHidden })}`),
        writeWorkspaceFile: (id, path, content) => json(`${agent(id)}/files`, post({ path, content })),
        getWorkspaceFileContent: async (id, path, opts = {}) => bytes(`${agent(id)}/files/content${query({ ...await selectors(id), path, download: opts.download })}`),
        getAgentDatabase: (id) => json(`${agent(id)}/database`),
        getAgentDatabaseRows: (id, table, opts = {}) => json(`${agent(id)}/database/tables/${segment(table)}/rows${query({ limit: opts.limit, offset: opts.offset })}`),
        getUsage: (opts = {}) => json(`/usage${query({ range: opts.range, timezone: opts.timezone, group_by: opts.groupBy, view: opts.view, session_id: opts.sessionId, api_key_id: opts.apiKeyId, root_session_id: opts.rootSessionId, attribution: opts.attribution, page: opts.page, per_page: opts.perPage, as_of: opts.asOf, snapshot: opts.snapshot, cursor: opts.cursor })}`),
        getRunOutput: (id, sid, rid, opts = {}) => json(`${agent(id)}/sessions/${segment(sid)}/runs/${segment(rid)}/output${query({ cursor: opts.cursor, limit: opts.limit })}`),
        getApproval: (id, aid) => json(`${agent(id)}/approvals/${segment(aid)}`),
        getCustomToolCall: (id, cid) => json(`${agent(id)}/custom_tool_calls/${segment(cid)}`),
        listApprovalPage: (id, opts = {}) => json(`${agent(id)}/approvals${query({ status: opts.status, session_id: opts.sessionId, cursor: opts.cursor, limit: opts.limit ?? 50 })}`),
        listCustomToolCallPage: (id, opts = {}) => json(`${agent(id)}/custom_tool_calls${query({ status: opts.status, session_id: opts.sessionId, cursor: opts.cursor, limit: opts.limit ?? 50 })}`),
        listAgentWebhooks: (id, opts = {}) => json(`${webhooks(id)}${query({ cursor: opts.cursor, limit: opts.limit })}`),
        createAgentWebhook: (id, input, key) => json(webhooks(id), post(input, key)),
        getAgentWebhook: (id, wid) => json(endpoint(id, wid)),
        updateAgentWebhook: (id, wid, input) => json(`${endpoint(id, wid)}/update`, post(input)),
        deleteAgentWebhook: async (id, wid) => { await json(`${endpoint(id, wid)}/delete`, post({})); },
        rotateAgentWebhookSecret: (id, wid, input, key) => json(`${endpoint(id, wid)}/rotate-secret`, post(input, key)),
        testAgentWebhook: (id, wid, key) => json(`${endpoint(id, wid)}/test`, post({}, key)),
        getAgentWebhookEvent: (id, eid) => json(`${webhooks(id)}/events/${segment(eid)}`),
        listAgentWebhookDeliveries: (id, wid, opts = {}) => json(`${endpoint(id, wid)}/deliveries${query({ cursor: opts.cursor, limit: opts.limit, status: opts.status, event_type: opts.eventType, event_id: opts.eventId, session_id: opts.sessionId, run_id: opts.runId, schedule_id: opts.scheduleId })}`),
        getAgentWebhookDelivery: (id, wid, did) => json(`${endpoint(id, wid)}/deliveries/${segment(did)}`),
        redeliverAgentWebhookDelivery: (id, wid, did, key) => json(`${endpoint(id, wid)}/deliveries/${segment(did)}/redeliver`, post({}, key)),
        redeliverAgentWebhookDeliveries: (id, wid, input, key) => json(`${endpoint(id, wid)}/deliveries/redeliver`, post(input, key)),
    };
}
