/**
 * ZooWork Managed Agents SDK — core client. Developer Preview.
 *
 * Authenticate with your organization API key (`zct_…`). It carries full tenant
 * authority, so it is SERVER-SIDE ONLY: never ship it in a browser or mobile bundle.
 *
 * IDs are opaque strings and unknown response fields must be ignored — both are
 * forward-compatibility rules, not suggestions. Errors surface an `error.type`; match on
 * that, never on the message text.
 */

import { parseSSE, isObj } from './sse.js'
import { normalizeEvent, type SessionEvent } from './events.js'

/**
 * The production API base URL — the default. You should not need to set this:
 * `ZOOWORK_BASE_URL` overrides it, and so does the `baseUrl` option, only when you
 * need to point at a different deployment.
 */
export const DEFAULT_BASE_URL = 'https://clawapi.ecap.gsmo.ai/service/v1'

/**
 * Read an environment variable without assuming a Node runtime.
 *
 * The SDK runs in Workers, Deno and browsers too, where `process` does not exist —
 * touching it unguarded is a ReferenceError, not `undefined`.
 */
function readEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  const value = proc?.env?.[name]
  return value === undefined || value === '' ? undefined : value
}

export type ZooworkAuth = { serviceToken: string } | { apiKey: string }

export interface ZooworkConfig {
  /**
   * Your API key (`zct_...`). Defaults to `ZOOWORK_API_KEY`.
   *
   * Server-side only: it authenticates as your whole organization, not as one end user.
   */
  apiKey?: string
  /**
   * API base including the version prefix. Defaults to `ZOOWORK_BASE_URL`, then to
   * {@link DEFAULT_BASE_URL} (production). Set it only to point at a deployment other
   * than the production one.
   */
  baseUrl?: string
  /**
   * Advanced. `{ apiKey }` is equivalent to the top-level `apiKey` field. `{ serviceToken }`
   * selects a privileged deployment-internal credential and is not available to API-key
   * callers.
   */
  auth?: ZooworkAuth
  /** Injected fetch for edge runtimes/tests; defaults to globalThis.fetch. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
}

export class ZooworkError extends Error {
  status: number
  /**
   * The machine-readable error code. Match on this, never on the message.
   *
   * TWO VOCABULARIES, because there are two error envelopes — staging-verified 2026-08-07. The
   * sessions/schedules/environments family answers `{ error: { type, message } }` with a bare code
   * (`agent_not_running`, `session_archived`, `environment_not_ready`); the agents family answers
   * `{ code, detail }` with a DOTTED one (`service_api.not_found`). Both land here, so a caller
   * always gets something — but do not assume one spelling covers both, and prefer `status` when
   * you only need the class of failure.
   */
  type?: string
  constructor(status: number, message: string, type?: string) {
    super(message)
    this.name = 'ZooworkError'
    this.status = status
    if (type) this.type = type
  }
}

export interface Ownership {
  owner_uid: string
  org_id: string
}

export interface ModelInfo {
  model: string
  display_name?: string
  family?: string
  api?: string
  [k: string]: unknown
}

/**
 * One remote MCP server, declared as `resource.mcp[]` on create or update.
 *
 * Staging-verified 2026-08-07, end to end, for UNAUTHENTICATED public servers: the tools appear
 * in the model's manifest as `mcp__<server>__<tool>` and really execute. Two traps:
 *
 *  - `name` must not contain an underscore. The tool-name grammar is `mcp__<server>__<tool>`,
 *    so an underscore in the server name makes the split ambiguous and the server is rejected.
 *  - `credential` is a dead end for API-key callers. The slug is accepted and stored on the
 *    agent, but the endpoint that would hold the secret it points at
 *    (`PUT /agents/{id}/credentials/{app}`) is 404 through the gateway BY DESIGN. There is no
 *    other way to store it, so an authenticated MCP server cannot be made to work today.
 *    Declare public servers only.
 *
 * Phase 1 is remote HTTP only: no stdio, no OAuth. A server that fails its catalog probe does
 * not fail the run — it pins an empty catalog and emits `agent.error` with
 * `kind: 'mcp_connection_failed'`.
 */
export interface McpServerDeclaration {
  /** Server slug. Appears in every tool name as `mcp__<name>__<tool>`. No underscores. */
  name: string
  /** Absolute URL of the MCP endpoint. Loopback, private ranges, cloud metadata and redirects are refused. */
  url: string
  /** Defaults to `streamable-http`. */
  transport?: 'streamable-http' | 'sse'
  /** Credential slug for a static bearer. Declarable, but unusable through the gateway — see above. */
  credential?: string
  /** Expose only these tool names from this server. Omit for all of them. */
  toolFilter?: string[]
  [k: string]: unknown
}

/**
 * The system-prompt pin (`resource.system_prompt`).
 *
 * Pin an immutable PLATFORM template version, or override the whole template with a CUSTOM one
 * (`base_version` records the platform version it derives from; the template must fill all 13
 * functional slots exactly once and stay under 64 KiB UTF-8). Create pins the platform version
 * active at that moment on its own — a plain create answered `{source:'platform',version:1}`,
 * staging-verified 2026-08-14 — and the pin NEVER follows a later activation on its own:
 * ordinary PUTs, skill changes and rerenders keep it. Moving it is an explicit call,
 * {@link ZooworkClient.upgradeSystemPrompt}.
 *
 * On PUT this section is REPLACE-ON-WRITE, like `tool_policy` — not merged.
 */
export type SystemPromptDeclaration =
  | { source: 'platform'; version: number }
  | { source: 'custom'; base_version: number; template: string }

/**
 * How an unattended cron fire is judged (`command`: a sandbox command whose exit 0 means
 * satisfied — ≤8 KiB, `timeoutSec` 1–600 (default 120); `rubric`: an LLM grader in a fresh
 * context — `rubric.type` must be `'text'`, ≤32 KiB). `subagent` is a reserved slot the API
 * still rejects. Validation is write-strict at EVERY level: an unknown key anywhere in the
 * outcome object is a 400 naming the field, so a typo cannot silently drop a limit.
 */
export type OutcomeEvaluator =
  | { type: 'command'; command: string; timeoutSec?: number; cwd?: string; skipIfUnchanged?: boolean }
  | { type: 'rubric'; rubric: { type: 'text'; text: string }; model?: string }

/**
 * What "done" looks like for an unattended cron fire — evaluated INSIDE the run.
 *
 * Attach it to a cron schedule (`payload.outcome`) or as an agent-level default (top-level
 * `outcome` on {@link AgentResource}); the job-level value overrides the default, and an
 * explicit `null` on the job disables the default for that job. It governs cron fires ONLY —
 * heartbeats and interactive sessions never evaluate. The runtime loops
 * evaluate → revise → finalize inside the same run, up to `maxIterations` (1–5, default 3),
 * and under the default `publish: 'after_satisfied'` nothing that failed evaluation is
 * announced or published. `description` is what the evaluator judges against, ≤4096 chars.
 *
 * Staging-verified 2026-08-14: a schedule carrying this was accepted (201) and read back
 * verbatim under `payload.outcome`, and an agent-level PUT landed in `declared.outcome`.
 */
export interface OutcomeConfig {
  description: string
  evaluator: OutcomeEvaluator
  /** 1–5; the engine defaults an omitted value to 3 at run time (nothing is stored for you). */
  maxIterations?: number
  /** Defaults to `after_satisfied` at run time: an unsatisfied result stays unpublished. */
  publish?: 'after_satisfied' | 'always' | 'never'
}

export interface AgentResource {
  name: string
  /** `max_tokens` caps output tokens per model request. Omit to use the platform default. */
  model?: { primary: string; input?: string[]; max_tokens?: number }
  persona?: { docs: { name: string; content: string; seed_policy?: string }[] }
  skills?: { skill_id: string; version?: number | 'latest' }[]
  labels?: Record<string, string>
  tool_policy?: Record<string, unknown>
  /** Remote MCP servers. Only unauthenticated ones work today — see {@link McpServerDeclaration}. */
  mcp?: McpServerDeclaration[]
  /**
   * System-prompt pin. Omitted on create means "the platform version active right now", pinned
   * from then on. REPLACE-ON-WRITE on PUT, like `tool_policy` — see {@link SystemPromptDeclaration}.
   */
  system_prompt?: SystemPromptDeclaration
  /**
   * Agent-level default outcome for unattended cron fires. A schedule's `payload.outcome`
   * overrides it per job; an explicit `null` there opts that job out. See {@link OutcomeConfig}.
   */
  outcome?: OutcomeConfig | null
  sandbox?: { scope: 'agent' | 'session' }
  environment_id?: string
  environment_version?: number
}

/**
 * Agent lifecycle state. Two fields, two very different meanings — staging-verified
 * 2026-08-06:
 *
 *  - `desired_state` is the one that gates the API. `running` is the precondition for
 *    createSession/postEvents; anything else is `409 agent_not_running`.
 *  - `actual_state` is CHANNEL health (Mattermost/Feishu route connectivity), not API
 *    readiness. An API-only agent has no channels to connect, so it sits at
 *    `activating` forever and `active` is unreachable. Never gate on it, and never
 *    poll for `running` — that is not one of its values.
 */
export interface AgentStatus {
  desired_state?: 'running' | 'stopped' | 'deleted' | string
  actual_state?: 'activating' | 'active' | 'degraded' | 'error' | 'stopped' | 'deleting' | string
  /** Authoritative config version on the READ path (GET/PUT). */
  config_version?: number
  render_state?: string
  status_message?: string | null
  channels?: { expected?: number; connected?: number; degraded_since?: string | null }
  [k: string]: unknown
}

export interface AgentSkill {
  skill_id?: string
  name?: string
  version?: number | string
  scope?: 'global' | 'org' | 'personal' | 'pack' | string
  eligible?: boolean
  files?: { path: string; size?: number; sha256?: string }[]
  [k: string]: unknown
}

/**
 * One platform account bound to an agent, as the channel service reports it.
 * `dm_policy` / `group_policy` are the reachability policies (`'open'` is the
 * server default); `health`/`status`/`status_code` are the connection's state
 * as the platform adapter sees it.
 */
export interface AgentChannel {
  platform: string
  account: string
  display_name?: string | null
  dm_policy?: string
  group_policy?: string
  enabled?: boolean
  health?: string
  status?: string
  status_code?: string | null
  [k: string]: unknown
}

/**
 * The chat platforms you can bind, staging-verified 2026-08-25.
 *
 * Only `'feishu'` has a server-driven QR flow here, and the two reasons the others lack one
 * are different. Slack structurally cannot have one — a Slack app is created by a person, and
 * its tokens only ever exist in that person's browser — so `addChannel` with `botToken` +
 * `appToken` is its permanent path. WeCom's flow exists in the product but is not exposed on
 * this API yet, so today it also binds through `addChannel`.
 *
 * WeChat (`'weixin'`/`'wechat'`) is absent because it cannot be bound here at all: it answers
 * `400 channel.weixin_setup_required`, naming a QR flow this API does not expose. Any other
 * name answers `400 channel.invalid_request`.
 */
export type ChannelPlatform = 'feishu' | 'slack' | 'wecom'

export interface AddChannelInput {
  /** See {@link ChannelPlatform}. Typed loosely so a newly supported platform needs no SDK release. */
  platform: ChannelPlatform | (string & {})
  /** Server default: `'default'`. */
  account?: string
  display_name?: string
  /** Server default: `'open'`. `'pairing'` is rejected with `400 channel.pairing_unsupported`. */
  dm_policy?: string
  /** Server default: `'open'`. */
  group_policy?: string
  /** Write-once at create; updates cannot edit it. */
  allow_from?: string[]
  /**
   * Platform credentials for the direct (non-QR) path. Keys are platform-specific and
   * **camelCase**; anything else is stored and ignored:
   *
   * - `slack` — `{ botToken: 'xoxb-…', appToken: 'xapp-…' }`, both required (socket mode
   *   needs the app-level token as well as the bot token)
   * - `wecom` — `{ botId, secret }`, both required
   * - `feishu` — `{ appId, appSecret, domain }`, only when skipping the QR flow
   */
  config?: Record<string, unknown>
}

export interface UpdateChannelInput {
  /** Which platform account to touch. Server default: `'default'`. */
  account?: string
  dm_policy?: string
  group_policy?: string
  enabled?: boolean
}

export interface FeishuSetupInput {
  /** `'feishu'` (default) or `'lark'` — the international brand of the same platform. */
  brand?: 'feishu' | 'lark'
  /** Server default: `'default'`. */
  account?: string
  /** Server default: `'open'`. */
  dm_policy?: string
  /** Server default: `'open'`. */
  group_policy?: string
}

/**
 * A running Feishu QR registration. Render `verification_uri_complete` to the person
 * doing the binding (typically as a QR code), then poll with `pollFeishuSetup` /
 * `waitForFeishuSetup` until it leaves `pending`. The session expires after
 * `expires_in` seconds.
 */
export interface FeishuSetupSession {
  session_id: string
  verification_uri_complete: string
  expires_in: number
  /** Suggested seconds between polls; the server may omit it. */
  poll_interval?: number | null
  [k: string]: unknown
}

/**
 * One poll of a Feishu setup session. The gateway's own vocabulary for `status` is
 * `pending | success | expired | denied | error`; treat anything unknown as
 * still-in-flight rather than throwing.
 */
export interface FeishuPollResult {
  status: string
  channel_configured?: boolean
  message?: string | null
  poll_interval?: number | null
  [k: string]: unknown
}

export interface AgentRecord {
  agent_id: string
  computer_id?: string
  /**
   * CREATE ONLY. `POST /agents` answers with a flat create receipt carrying this
   * field; `GET`/`PUT` answer with the projection instead, where the version lives at
   * `status.config_version`. Read it as `agent.status?.config_version ?? agent.config_version`.
   */
  config_version?: number
  /** The agent's configuration (name/model/persona/labels/mcp/...). Absent from the create receipt. */
  declared?: Record<string, unknown>
  resolved_skills?: { skill_id: string; name?: string; version?: number | string; eligible?: boolean }[]
  /**
   * The Environment version this agent is actually pinned to. Audit-grade, but the
   * `environment_id` in here is NOT queryable: `getEnvironment()` on the platform default
   * answers 404, because the gateway forces an org selector and the default belongs to no org.
   * That is a selector mismatch, not a permission problem.
   */
  resolved_environment?: {
    environment_id?: string
    version?: number
    provider?: string
    template_ref?: string
    build_id?: string
    /** Defaults to `{ type: 'unrestricted' }` when the Environment declares no networking. */
    networking?: { type?: 'unrestricted' | 'limited' | string; allowed_hosts?: string[] }
    [k: string]: unknown
  }
  /**
   * `true` once the first sandbox has been created — from then on the Environment pin is
   * FROZEN and every attempt to change it is `409 environment_locked`. Stopping the agent does
   * not clear it, and there is no escape hatch through the gateway
   * (`POST /agents/{id}:replace-environment` is 404 there). Choose the Environment at create
   * time or live with it. Staging-verified 2026-08-07.
   */
  environment_locked?: boolean
  /** ISO 8601 instant the lock was written; `null` while still unlocked. */
  environment_locked_at?: string | null
  status?: AgentStatus
  ownership?: Ownership
  [k: string]: unknown
}

/**
 * A skill registry row, as returned by `uploadSkill` / `listSkills`.
 *
 * `latest_version` came back as the STRING `"1"` from the multipart create on staging
 * (2026-08-07) while other surfaces spell it as a number — compare loosely, or `Number()` it.
 */
export interface SkillRecord {
  skill_id: string
  scope?: 'org' | 'personal' | 'global' | 'pack' | string
  name?: string
  description?: string
  latest_version?: number | string | null
  /** `active`, … */
  status?: string
  pack_id?: string | null
  created_by?: string
  created_at?: string
  updated_at?: string
  /**
   * The tenant the gateway rewrote your upload to. `owner_uid` comes back `null` on an
   * `org`-scope skill — it belongs to the org, not to a person — so this is deliberately looser
   * than {@link Ownership}, which requires both.
   */
  ownership?: { owner_uid?: string | null; org_id?: string | null; [k: string]: unknown }
  [k: string]: unknown
}

/**
 * One `session_transcripts` row, as projected by `getSession(…, { history: true })`.
 *
 * This is the AT-REST transcript, not the event log: conversation text lives under
 * `entry.message` (`{ role, content }`) for `entry_type: 'message'`. Use it to recover an
 * answer whose events you missed; use `listEvents` when you want the event stream.
 */
export interface SessionHistoryEntry {
  seq: number
  entry_type: string
  entry: Record<string, unknown>
  created_at?: string
}

export interface SessionRecord {
  session_id: string
  /** `api:{session_id}` for a session you created; `agent:{agent_id}:cron:{schedule_id}:…` for a scheduled fire. */
  session_key?: string
  /** `api` for sessions you create, `cron` for ones a schedule fired. */
  channel?: string
  /**
   * `listSessions` is the surface that carries the run outcome (`succeeded`, …) — and it spells
   * it `run_status`, not `status`. Staging-verified 2026-08-07: `getSession` returns a `status`
   * of `null` for the very same session, so reading `status` off a list row gets you nothing.
   */
  run_status?: string
  /** Observed `null` on `getSession`. Prefer {@link SessionRecord.run_status} from `listSessions`. */
  status?: string | null
  metadata?: Record<string, unknown>
  archived?: boolean
  updated_at?: string
  /** Present only when the read asked for `history: true`; the most recent `limit` rows, in order. */
  history?: SessionHistoryEntry[]
  [k: string]: unknown
}

/** Write-side events: user.message / user.interrupt / user.tool_confirmation / system.message */
export interface OutboundEvent {
  type: string
  content?: unknown
  [k: string]: unknown
}

/** One `postEvents` receipt. An accepted event carries the full event object's fields too. */
export interface PostEventReceipt {
  id?: string | null
  type?: string
  accepted?: boolean
  [k: string]: unknown
}

/** One page of the unified event history, with its pagination fields when the server sends them. */
export interface SessionEventPage {
  events: SessionEvent[]
  hasMore?: boolean
  nextCursor?: string | null
}

/**
 * When a schedule fires. Three kinds, and only `cron` has its field names pinned by the engine
 * reference (`{"kind":"cron","expr":"0 9 * * *","tz":"Asia/Singapore"}`); `every` and `at` are
 * documented by prose only — "the management plane supports cron/every/at", and an `at`
 * schedule "uses the supplied ISO instant". Their extra fields are therefore left open rather
 * than guessed at, so anything the engine accepts still type-checks.
 *
 * Cron is a five-field expression. Macros and a `CRON_TZ=` prefix are rejected; overlap is
 * fixed to SKIP server-side, so a fire that lands on a still-running one is dropped, not queued.
 */
export type ScheduleSpec =
  | { kind: 'cron'; expr: string; tz?: string; [k: string]: unknown }
  | { kind: 'every'; every: string | number; tz?: string; [k: string]: unknown }
  | { kind: 'at'; at: string; tz?: string; [k: string]: unknown }

/** What a schedule does when it fires. `agentTurn` is the one the management plane accepts. */
export interface SchedulePayload {
  kind: 'agentTurn' | string
  message?: string
  /**
   * Evaluate-revise-finalize gate for THIS job — overrides the agent-level default, and an
   * explicit `null` opts this job out of that default. Cron fires only. Staging-verified
   * 2026-08-14 (201, read back verbatim). See {@link OutcomeConfig}.
   */
  outcome?: OutcomeConfig | null
  [k: string]: unknown
}

export interface ScheduleInput {
  /** Caller-chosen id, `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. Re-creating it with a DIFFERENT definition is 409. */
  schedule_id: string
  schedule: ScheduleSpec
  payload: SchedulePayload
  jobKind?: string
  /**
   * Where the turn runs. Omit for `isolated` (a fresh session per fire); `session:<id>` targets
   * an existing session of this agent. `current` is agent-only and rejected here. IMMUTABLE
   * after create — see {@link ScheduleUpdate}.
   */
  sessionTarget?: 'isolated' | string
  /** `{ mode: 'none' }` or a typed `announce`. Webhook delivery is rejected. */
  delivery?: { mode: 'none' | 'announce' | string; [k: string]: unknown }
  enabled?: boolean
  deleteAfterRun?: boolean
  [k: string]: unknown
}

/**
 * The PUT body. Same vocabulary as {@link ScheduleInput}, minus the fields the server owns.
 *
 * The six `never` fields below are the six ways a caller loses time here, and every one of
 * them is something a `getSchedule()` result contains — which is why they are compile errors
 * rather than runtime surprises. `updateSchedule` also strips them at runtime, so a JavaScript
 * caller round-tripping a read still succeeds. Staging-verified 2026-08-07.
 */
export interface ScheduleUpdate {
  /** The cadence, in the INPUT vocabulary. `{ kind: 'cron', expr, tz }` — verified to apply. */
  schedule?: ScheduleSpec
  payload?: SchedulePayload
  jobKind?: string
  /** Immutable. Sending it back — even unchanged — is `400 sessionTarget is immutable`. */
  sessionTarget?: never
  /**
   * The READ shape of the cadence. Accepted with a 200 and then SILENTLY IGNORED — a PUT
   * carrying `scheduleSpec: { cronExpressions: ['45 9 * * *'] }` leaves the old expression in
   * place while any sibling field in the same body applies. Send `schedule` instead.
   */
  scheduleSpec?: never
  /** Server-derived: `400 execution, originMetadata, creatorPrincipalRef, and contextSnapshot are server-derived`. */
  execution?: never
  /** Server-derived — same 400 as `execution`. */
  originMetadata?: never
  /** Server-derived — same 400 as `execution`. */
  contextSnapshot?: never
  /** Server-derived — same 400 as `execution`. */
  creatorPrincipalRef?: never
  delivery?: { mode: 'none' | 'announce' | string; [k: string]: unknown }
  enabled?: boolean
  deleteAfterRun?: boolean
  [k: string]: unknown
}

/**
 * A schedule as the API spells it — and it spells it three ways, staging-verified 2026-08-07.
 *
 * NOTHING YOU SENT COMES BACK UNDER THE NAME YOU SENT IT. The write shape ({@link ScheduleInput})
 * and the read shape are different documents:
 *
 *  - `schedule: { kind: 'cron', expr, tz }` is stored and read back as
 *    {@link ScheduleRecord.scheduleSpec} — `{ timezoneName, catchupWindowMs, cronExpressions[] }`.
 *    There is no `schedule` key on any read. Reach for `scheduleSpec.cronExpressions[0]`.
 *  - `sessionTarget: 'isolated'` is read back as `execution: { kind: 'isolated' }`. There is no
 *    `sessionTarget` key on any read either.
 *  - `scheduleId` is the FULLY-QUALIFIED name `cron/{computer_id}/{agent_id}/{schedule_id}`, not
 *    the id you chose. Your id is `name`.
 *
 * The three responses also disagree with each other: `POST` answers with only snake_case
 * `schedule_name`; `GET /schedules/{id}` answers the camelCase projection below; `GET /schedules`
 * answers the raw Temporal describe (`spec` / `state` / `memo` / `next_action_times`) with the
 * camelCase projection merged on top. Read defensively and match on what you find.
 */
export interface ScheduleRecord {
  /** FULLY-QUALIFIED: `cron/{computer_id}/{agent_id}/{schedule_id}`. Not the id you passed in. */
  scheduleId?: string
  /** The `schedule_id` you chose. This is the one you pass back to get/update/delete. */
  name?: string
  computerId?: string
  agentId?: string
  apiAgentId?: string
  /** snake_case, from the create/trigger receipts: `cron/{computer_id}/{agent_id}/{schedule_id}`. */
  schedule_name?: string
  /**
   * The NORMALIZED cadence — what `ScheduleInput.schedule` became. Read-only: sending it back on
   * a PUT is silently ignored (see {@link ScheduleUpdate.scheduleSpec}).
   */
  scheduleSpec?: {
    timezoneName?: string
    catchupWindowMs?: number
    cronExpressions?: string[]
    [k: string]: unknown
  }
  /** Where the turn runs — what `ScheduleInput.sessionTarget` became. `{ kind: 'isolated' }`, etc. */
  execution?: { kind?: string; sessionId?: string; [k: string]: unknown }
  payload?: SchedulePayload
  jobKind?: string
  delivery?: Record<string, unknown>
  enabled?: boolean
  deleteAfterRun?: boolean
  /** Server-derived, and rejected on the way back in — see {@link ZooworkClient.updateSchedule}. */
  originMetadata?: Record<string, unknown>
  /** Server-derived, and rejected on the way back in. */
  contextSnapshot?: unknown[]
  origin?: string
  consecutiveErrors?: number
  createdAt?: string
  updatedAt?: string
  /** `GET /schedules` (list) only: the raw Temporal describe, in a different vocabulary again. */
  spec?: Record<string, unknown>
  /** List only. `{ paused, note }` — NOT the lifecycle state, and unrelated to `enabled`. */
  state?: { paused?: boolean; note?: string; [k: string]: unknown }
  /** List only. Carries the un-qualified `schedule_id` at `memo.schedule_id`. */
  memo?: Record<string, unknown>
  /** List only. The next few fire instants, ISO 8601, in UTC. */
  next_action_times?: string[]
  [k: string]: unknown
}

/**
 * One past fire. `runs[]` mixes TWO ROW SHAPES and you have to switch on `source` to read one —
 * staging-verified 2026-08-07, where a single `listScheduleRuns` returned both:
 *
 *  - `source: 'temporal'` — a DISPATCH record: `scheduled_at` / `taken_at` / `workflow_id` /
 *    `temporal_run_id`. It says a workflow was handed the fire, and nothing about the outcome.
 *  - `source: 'run_projection'` — an OUTCOME record: `fired_at` / `status` / `consecutive_errors`.
 *    This is the only row that carries `status` (e.g. `skipped` for a fire against a disabled
 *    schedule).
 *
 * NEITHER carries `session_id`, which is the field people expect most: you cannot walk from a
 * fire to the session it created. To find that session, list the agent's sessions and match
 * `channel: 'cron'` with the `session_key` prefix `agent:{agent_id}:cron:{schedule_id}:`.
 */
export interface ScheduleRun {
  /** Which projection this row came from. Decides which of the field groups below is populated. */
  source?: 'temporal' | 'run_projection' | string

  // ── source: 'run_projection' ──
  /** Un-qualified `schedule_id`. */
  schedule_id?: string
  fired_at?: string
  /** e.g. `skipped`. Present on `run_projection` rows only — a `temporal` row has no status. */
  status?: string
  consecutive_errors?: number

  // ── source: 'temporal' ──
  /** When the fire was due. */
  scheduled_at?: string
  /** When the worker picked it up. */
  taken_at?: string
  /** `{schedule_name}-workflow-{ISO instant}`. */
  workflow_id?: string
  temporal_run_id?: string

  [k: string]: unknown
}

/** The exact resolution vocabulary. Anything else is a 400. */
export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny'

/**
 * A tool call parked on a human decision.
 *
 * Field names are unverified: the only staging observation (2026-08-07) is a 200 with an EMPTY
 * `approvals` array, because producing a real pending approval requires a tool policy that asks.
 * Read defensively.
 */
export interface ApprovalRecord {
  approval_id?: string
  session_id?: string
  tool_name?: string
  status?: string
  created_at?: string
  [k: string]: unknown
}

/** Artifact lifecycle. Only a `ready` row carries a resolvable `url`. */
export type ArtifactStatus = 'pending' | 'ready' | 'failed' | 'deleted' | string

/**
 * One published artifact — an immutable snapshot of a `/workspace` file, created by the
 * agent's OWN in-loop `artifact_publish` tool during a turn. There is no API for publishing
 * from outside the loop; this surface lists, reads, re-resolves and deletes what the agent
 * published. Publishing is a COPY: the source file stays in the workspace.
 *
 * `url` is a revocable bearer capability — treat it like a secret, and expect its lifetime to
 * be deployment policy (staging hands out 24-hour presigned GETs).
 */
export interface ArtifactRecord {
  artifact_id: string
  agent_id?: string
  session_id?: string
  run_id?: string
  turn?: number
  /** Where in `/workspace` it was published from. */
  source_path?: string
  file_name?: string
  content_type?: string
  size?: number
  sha256?: string
  status?: ArtifactStatus
  /** Absent until the upload finalizes — a row without it answers `409 artifact_not_ready` to download. */
  url?: string
  created_at?: string
  finalized_at?: string | null
  deleted_at?: string | null
  [k: string]: unknown
}

/** One page of artifacts. `has_more` is real — this list DOES tell you when it truncated. */
export interface ArtifactPage {
  artifacts: ArtifactRecord[]
  page?: number
  has_more?: boolean
  [k: string]: unknown
}

/**
 * `getSystemPrompt` result: the pin as declared, and what is actually in effect.
 *
 * `declaration: null` together with `effective.source: 'legacy'` marks a pre-templates agent
 * still on virtual legacy behavior — only an explicit engine-side upgrade migrates those.
 * Agents created after templates landed carry a real declaration from birth.
 */
export interface SystemPromptInfo {
  agent_id?: string
  config_version?: number
  declaration?: SystemPromptDeclaration | null
  /** Rendered-template metadata (source/profile/version/hashes…), or the virtual-legacy marker. */
  effective?: Record<string, unknown>
  [k: string]: unknown
}

/**
 * The runtime facts `previewSystemPrompt` assembles from. The required ones are required by
 * the engine — omitting any is a 400 naming it.
 */
export interface SystemPromptPreviewInput {
  /** Must equal the agent's CURRENT `status.config_version`, or the answer is `409 config_version_changed`. */
  config_version: number
  now_ms: number
  session_id: string
  model_display: string
  workspace_dir: string
  tool_names: string[]
  channel?: string
  chat_type?: string
  session_key?: string
  subagent?: { role?: string; taskName?: string }
  [k: string]: unknown
}

export interface SystemPromptPreview {
  agent_id?: string
  config_version?: number
  /** The assembled prompt, verbatim. */
  system_prompt?: string
  char_count?: number
  /** One hash per functional slot on a templated agent; `null` when legacy assembly produced no slots. */
  slot_hashes?: Record<string, string> | null
  /** Always `[]` — the preview never reads the transcript. */
  transcript?: unknown[]
  [k: string]: unknown
}

/** `upgradeSystemPrompt` receipt: the new pin and the version bump it cost. */
export interface SystemPromptUpgrade {
  agent_id?: string
  /** The NEW config version — the upgrade writes a config change like any other. */
  config_version?: number
  declaration?: SystemPromptDeclaration
  template_hash?: string
  [k: string]: unknown
}

/**
 * An Environment build spec. The top level accepts EXACTLY these four keys — any other key is
 * `400 invalid_environment_config`, which is why this type has no index signature.
 *
 * Package install order is fixed apt → npm → pip. Files land under
 * `/opt/zooclaw/environment/`, and a top-level `bin/*` marked executable is linked into
 * `/usr/local/bin`. No user-defined secrets, env vars, or start hooks — the platform injects
 * its own runtime credentials for built-in skills, but that layer is internal and not
 * extensible.
 */
export interface EnvironmentConfig {
  packages?: { apt?: string[]; npm?: string[]; pip?: string[] }
  files?: { path?: string; contentBase64?: string; upload_id?: string; executable?: boolean }[]
  build?: { script?: string; verify_script?: string }
  /**
   * Omitted means `{ type: 'unrestricted' }` — the sandbox reaches the whole internet by
   * default. `allowed_hosts` is accepted only with `type: 'limited'`.
   */
  networking?: { type: 'unrestricted' | 'limited'; allowed_hosts?: string[] }
}

export interface EnvironmentResource {
  name: string
  description?: string
  /** Supply to create a new version lineage under an existing id; omit to mint one. */
  environment_id?: string
  config: EnvironmentConfig
  [k: string]: unknown
}

/**
 * An Environment row. Staging-verified 2026-08-07.
 *
 * THE TWO VERSION NUMBERS ARE NOT THE SAME NUMBER, and picking the wrong one pins an agent to a
 * build that does not exist yet: `latest_version` is the newest version that has been CREATED
 * (it is `1` the instant you create an Environment, while that version is still `queued`), and
 * `latest_ready_version` is the newest one that finished building — `null` until a build lands.
 * Pin `latest_ready_version`, or `createAgent` answers `409 environment_not_ready`.
 *
 * There is no `state` here and no nested `ownership`: lifecycle is `status`
 * (`active` / `archived`) and the tenant is flat, as `scope` + `org_id`.
 */
export interface EnvironmentRecord {
  environment_id: string
  name?: string
  description?: string
  scope?: 'org' | string
  org_id?: string
  /** `active` | `archived`. */
  status?: string
  /** Newest version CREATED — may still be building. Not safe to pin. */
  latest_version?: number | null
  /** Newest version that reached `ready`. `null` until a build finishes. Pin THIS. */
  latest_ready_version?: number | null
  created_by?: string
  created_at?: string
  updated_at?: string
  /** Set once archived; `null` while active. */
  archived_at?: string | null
  /** CREATE ONLY: the first version, inline — no follow-up `getEnvironmentVersion` needed to see it. */
  version?: EnvironmentVersionRecord
  [k: string]: unknown
}

/**
 * One immutable Environment version. Builds walk
 * `queued → submitting → building → verifying → ready`, and any phase can land in `failed`.
 * Poll THIS, not the Environment's top-level row: a `ready` version is the only thing an agent
 * can pin, and it always carries both `e2b_build_id` and a matching `template_ref`.
 *
 * THE FIELD IS `status`, NOT `state` — staging-verified 2026-08-07. A poll loop written against
 * `state` compares `undefined` to `'ready'` forever and never terminates, which is precisely the
 * hang this note exists to prevent.
 */
export interface EnvironmentVersionRecord {
  environment_id?: string
  version?: number
  /** `queued` → `submitting` → `building` → `verifying` → `ready`, or `failed`. */
  status?: 'queued' | 'submitting' | 'building' | 'verifying' | 'ready' | 'failed' | string
  /** The normalized config this version was built from — not the one you posted verbatim. */
  config?: EnvironmentConfig
  base_environment_id?: string
  base_version?: number
  source_hash?: string
  spec_hash?: string
  e2b_template_name?: string | null
  e2b_template_id?: string | null
  /** `null` until the build reaches `ready`. */
  e2b_build_id?: string | null
  /** `null` until the build reaches `ready`. */
  template_ref?: string | null
  /** The exact base-image build this version layers on — recorded 2026-08-14, new on the wire. */
  base_template_ref?: string | null
  /** Which phase failed, on `status: 'failed'`. */
  failure_stage?: string | null
  failure_message?: string | null
  created_by?: string
  created_at?: string
  ready_at?: string | null
  [k: string]: unknown
}

/** `POST /agents/{id}/exec` result. A failed command still arrives here, not as a rejection. */
export interface ExecResult {
  /** Non-zero means the COMMAND failed. The HTTP call succeeded regardless. */
  exit_code: number
  stdout: string
  stderr: string
}

export interface WakeResult {
  mode: 'now' | 'next-heartbeat' | string
  /** The reminder was written to the pending queue. */
  queued: boolean
  /** `mode: 'now'` only — whether the heartbeat schedule was actually kicked. */
  triggered: boolean
}

export type { SessionEvent } from './events.js'

export interface ZooworkClient {
  listModels(): Promise<ModelInfo[]>

  // ── agents ──
  /**
   * Create an agent. The gateway derives ownership from your API key and always skips the
   * interactive onboarding interview — the agent answers your first message directly.
   * `ownership` is accepted for callers that talk to the engine without the gateway;
   * through the gateway it is overwritten and can be omitted.
   */
  createAgent(input: { resource: AgentResource; ownership?: Ownership }, idempotencyKey?: string): Promise<AgentRecord>
  /**
   * List the agents owned by your key's bound user (engine query: `owner_uid AND org_id`,
   * both injected by the gateway). `labels` filters on declared labels — e.g.
   * `{ labels: { workspace_id: '…' } }` resolves an app workspace id (the first path
   * segment of a ZooWork chat URL) to its agent. Page size is fixed at 100 by the engine.
   *
   * Note the scope is `owner_uid AND org_id`: an agent a colleague created in your org is
   * fetchable by `getAgent` but will not appear here.
   */
  listAgents(opts?: { labels?: Record<string, string>; page?: number }): Promise<AgentRecord[]>
  getAgent(agentId: string): Promise<AgentRecord>
  /** PUT declared sections; bumps config_version on EVERY call — gate on drift, don't blind-retry. */
  updateAgent(agentId: string, sections: Record<string, unknown>): Promise<AgentRecord>
  /**
   * Soft delete: the agent stops resolving on the API, but this is not a resource purge.
   * On gateway releases that carry the channels surface, a successful delete also
   * best-effort disables the agent's bound channels — a failure there never turns the
   * delete into an error, so a chat binding can in rare cases outlive its agent.
   */
  deleteAgent(agentId: string): Promise<void>
  /**
   * Flip `desired_state` to `running` — the precondition for every session call.
   * Fast (sub-second on staging). The returned warnings are informational: an
   * API-only agent reports `channel_routes_reload_failed` on every start/stop
   * because it has no chat-channel routes to reload. Do not treat it as failure.
   */
  startAgent(agentId: string): Promise<{ warnings: string[] }>
  stopAgent(agentId: string): Promise<{ warnings: string[] }>
  /**
   * Poll until `status.desired_state === 'running'`, then hand back that projection.
   *
   * READ THIS BEFORE WRITING YOUR OWN LOOP. `desired_state` is the only readiness signal.
   * Polling `status.actual_state` for `'running'` is the documented way to hang forever:
   * `actual_state` reports CHAT-CHANNEL health, `running` is not one of its values, and an
   * API-only agent parks at `activating` for the rest of its life. Every hand-rolled readiness
   * loop we have seen gets this wrong.
   *
   * Defaults: 30s budget, 500ms between polls — start is sub-second on staging, so the budget
   * is for a bad day, not the normal one. On timeout it throws a {@link ZooworkError} with
   * `status: 408` / `type: 'timeout'`; on abort, `status: 0` / `type: 'aborted'`. Both are
   * synthesized locally — the server never sends either.
   *
   * Both bounds cover an IN-FLIGHT poll, not just the gap between polls: each request carries a
   * signal that fires on the caller's `signal` or on whatever is left of the budget. A gateway
   * that accepts the connection and then never answers therefore ends this wait on schedule
   * instead of hanging it (`fetch` imposes no timeout of its own).
   */
  waitUntilRunning(agentId: string, opts?: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal }): Promise<AgentRecord>
  /** Skills already attached to the agent, resolved and merged. `verbose` includes ineligible/excluded entries. */
  listAgentSkills(agentId: string, opts?: { verbose?: boolean }): Promise<AgentSkill[]>
  /**
   * Attach a skill by id. Only skills the caller's tenant owns are installable
   * through the `/service/v1` gateway (`org` / `personal` scope); `global`
   * catalog entries are listable but answer 404 here.
   */
  putAgentSkill(agentId: string, skillId: string, opts?: { enabled?: boolean; versionPin?: number | null }): Promise<{ config_version?: number; warnings?: string[] }>
  deleteAgentSkill(agentId: string, skillId: string): Promise<void>

  // ── channels ──
  //
  // Bind chat platforms (Feishu/Lark today) to an API-created agent, so the same agent that
  // answers your `/sessions` calls also answers people in a chat app. Two paths in: the Feishu
  // QR device flow (`startFeishuSetup` → show the URI → poll), and `addChannel` with explicit
  // platform credentials in `config`. One caveat worth designing for: a chat conversation and
  // an API session are SEPARATE sessions with separate context — binding a channel does not
  // let your API calls see what the agent said in the chat app, or vice versa.
  //
  // Staging-verified 2026-08-25, the day the gateway release carrying these routes reached it.
  // A deployment WITHOUT that release answers the engine passthrough 404
  // (`{error:{type:'not_found'}}`) rather than this family's own `{code, detail}` — that
  // envelope difference is how you tell "not deployed here" from "not found".
  //
  // Three distinct 404 codes, and they send you to different fixes:
  //   `channel.feishu_session_not_found` — the QR session is gone or was cancelled; start a new one
  //   `channel.not_found`               — the agent has no binding on that platform
  //   `service_api.not_found`           — unknown agent, or unknown action on the path

  /**
   * Channels currently bound to the agent. Empty for a pure API agent.
   *
   * Lists the platforms in {@link ChannelPlatform}. The deployment's own internal channels are
   * filtered out server-side and never appear here.
   */
  listChannels(agentId: string): Promise<AgentChannel[]>
  /**
   * Bind a channel from explicit platform config (the non-QR path) — `config` carries the
   * platform's own credential keys. Answers the created channel (HTTP 201). This is the ONLY
   * path for Slack and WeCom; Feishu also has the QR flow. See {@link ChannelPlatform} for what
   * binds and what does not.
   *
   * **It is an upsert, not a create.** Binding the same `platform` + `account` twice answers
   * `201` again and overwrites the first binding rather than conflicting.
   *
   * ⚠️ **201 means STORED, not WORKING.** Credentials are not validated at bind time: a channel
   * created from deliberately bogus credentials still answered 201 with `health: 'unknown'`,
   * `status: 'configured'`, and only turned `health: 'unhealthy'` / `status: 'error'` moments
   * later (staging-verified 2026-08-25). Read the verdict from `health`/`status` on a follow-up
   * {@link listChannels}; treating the 201 as success ships a silently broken binding.
   */
  addChannel(agentId: string, input: AddChannelInput): Promise<AgentChannel>
  /**
   * Change `dm_policy` / `group_policy` / `enabled` on one bound platform account, and get the
   * channel back in its NEW state. `allow_from` is deliberately not editable — write-once at
   * create.
   *
   * `enabled: false` is not just a flag: it was observed moving `status` to `'disabled'` and
   * resetting `health` to `'unknown'`. Updating a platform with no binding answers
   * `404 channel.not_found`.
   */
  updateChannel(agentId: string, platform: string, input?: UpdateChannelInput): Promise<AgentChannel>
  /**
   * Unbind one platform account (server default account: `'default'`).
   *
   * Idempotent, unlike {@link updateChannel}: removing a binding that is not there answers
   * `200 { ok: true }` rather than `404 channel.not_found`.
   */
  removeChannel(agentId: string, platform: string, opts?: { account?: string }): Promise<void>
  /**
   * Start the Feishu/Lark QR registration. YOU own the UI: render
   * `verification_uri_complete` (usually as a QR code) and drive the poll loop —
   * `waitForFeishuSetup` does the loop part for you.
   *
   * Observed defaults: `expires_in: 600`, `poll_interval: 5`. `brand` picks the real host —
   * `'feishu'` answers an `open.feishu.cn` URI, `'lark'` an `open.larksuite.com` one, so the
   * brand has to match the workspace the person will approve it in.
   */
  startFeishuSetup(agentId: string, input?: FeishuSetupInput): Promise<FeishuSetupSession>
  /**
   * One poll of a setup session. `status: 'pending'` means keep going; a cancelled or expired
   * session answers `404 channel.feishu_session_not_found` rather than a terminal status, so
   * a hand-rolled loop must treat that 404 as an end condition, not as a transport error.
   */
  pollFeishuSetup(agentId: string, sessionId: string): Promise<FeishuPollResult>
  /** Abandon a setup session. Afterwards polling it answers `404 channel.feishu_session_not_found`. */
  cancelFeishuSetup(agentId: string, sessionId: string): Promise<void>
  /**
   * Poll a Feishu setup session until it leaves `pending`, then hand back that terminal poll.
   * A status the server reports in the body — `success` / `expired` / `denied` / `error` — is
   * RETURNED, not thrown: "the person rejected it" is an outcome, not an exception.
   *
   * But a session can also stop existing, and then polling answers
   * `404 channel.feishu_session_not_found`, which surfaces here as a thrown
   * {@link ZooworkError} carrying that `type`. Confirmed for a cancelled session
   * (staging 2026-08-25); whether a session that simply runs past `expires_in` reports
   * `status: 'expired'` in a 200 or disappears into this 404 was NOT observed — handle both.
   *
   * Pacing follows the server's `poll_interval` when present (observed default 5s; the local
   * fallback matches). The default budget is 600s, which is also the observed `expires_in` —
   * pass the session's own value when you have it. On timeout it throws `status: 408` /
   * `type: 'timeout'`; on abort, `status: 0` / `type: 'aborted'` — both synthesized locally,
   * and every in-flight poll is bounded the way {@link waitUntilRunning} bounds its polls.
   * `onPoll` fires after every poll, terminal one included, for progress UI.
   */
  waitForFeishuSetup(
    agentId: string,
    sessionId: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal; onPoll?: (poll: FeishuPollResult) => void },
  ): Promise<FeishuPollResult>

  // ── system prompt ──
  /**
   * The agent's system-prompt pin and the rendered template in effect. Staging-verified
   * 2026-08-14 — a fresh agent answers a real `declaration` (`{source:'platform',version:1}`),
   * a pre-templates agent answers `declaration: null` with a virtual-legacy `effective`.
   */
  getSystemPrompt(agentId: string): Promise<SystemPromptInfo>
  /**
   * Assemble the EXACT prompt for a given set of runtime facts, without touching any session.
   * Deterministic for fixed inputs (`transcript` is always `[]`), and `slot_hashes` names each
   * template slot for diffing. `config_version` must be the agent's CURRENT one.
   * Staging-verified 2026-08-14; the raw `:` in `system-prompt:preview` passes the gateway.
   */
  previewSystemPrompt(agentId: string, input: SystemPromptPreviewInput): Promise<SystemPromptPreview>
  /**
   * Move the system-prompt pin — the ONE write that does, since nothing else ever follows a
   * later platform activation. Omit `template_version` to upgrade to the currently ACTIVE
   * platform version; pass one to pin a specific immutable version.
   *
   * `expected_config_version` is REQUIRED and it is a real CAS: it must equal the agent's
   * current `status.config_version` or the answer is `409 config_version_changed` — read
   * fresh, then upgrade. The 200 receipt carries the NEW `config_version` (the upgrade is a
   * config write like any other) plus the pinned `declaration` and `template_hash`.
   *
   * Staging-verified 2026-08-14, the day gateway fix #3387 opened the `{id}:verb` route
   * grammar (this route was 404 through the gateway until then — do not expect it on older
   * gateway deployments).
   */
  upgradeSystemPrompt(
    agentId: string,
    input: { expected_config_version: number; template_version?: number },
  ): Promise<SystemPromptUpgrade>

  // ── skill registry (bring your own skill) ──
  /**
   * Upload a skill package as a zip. One call creates the skill row AND version 1.
   *
   * THE RULE THAT COSTS EVERYONE THEIR FIRST ATTEMPT: the zip's single top-level directory name
   * must equal the `name` in `SKILL.md`'s frontmatter (compared case- and underscore-
   * insensitively), or the whole thing is a 400 —
   * `top-level directory 'my-test-skill' must match SKILL.md name 'fulong-probe-skill'`.
   * So `zip -r skill.zip market-research/` where `market-research/SKILL.md` declares
   * `name: market-research`. A zip whose ROOT is the skill (SKILL.md at the top) is also
   * accepted. `SKILL.md` must be non-empty and declare both `name` and `description`.
   * 50 MB expanded, zip only (store/deflate), encrypted zips rejected.
   *
   * `scope` may only be `org` or `personal`; `global` and `pack` are 403 and are published
   * through an admin surface the gateway does not proxy. The gateway rewrites ownership to your
   * key's tenant either way. Staging-verified 2026-08-07 — this is the ONLY path by which an
   * API-key caller can add a skill the agent will actually load.
   */
  uploadSkill(
    zip: Blob | ArrayBuffer | Uint8Array,
    opts: { scope: 'org' | 'personal'; fileName?: string; description?: string; idempotencyKey?: string },
  ): Promise<SkillRecord>
  /**
   * Publish a new version of an existing skill from a zip. Same zip rules as
   * {@link ZooworkClient.uploadSkill}, plus: the frontmatter `name` must match the target
   * skill's name. `description` overrides the one in the frontmatter.
   *
   * Agents that installed the skill unpinned follow the new version on their own — the registry
   * bumps their `config_version`; you do not re-`putAgentSkill`.
   */
  uploadSkillVersion(
    skillId: string,
    zip: Blob | ArrayBuffer | Uint8Array,
    opts?: { fileName?: string; description?: string; idempotencyKey?: string },
  ): Promise<SkillRecord>
  /**
   * The catalog visible to your key: global skills plus your org/personal ones. `q` matches on
   * name; `page` is 1-based with a fixed page size of 100. Only the `org`/`personal` rows are
   * installable — `global` entries list but answer 404 from `putAgentSkill`.
   */
  listSkills(opts?: { scope?: 'org' | 'personal' | 'global' | string; q?: string; page?: number }): Promise<SkillRecord[]>
  /** 204. No in-use guard for org/personal skills: agents holding it just lose it. */
  deleteSkill(skillId: string): Promise<void>

  // ── sessions ──
  //
  // There is no `patchSession`, deliberately. `PATCH /agents/{id}/sessions/{sid}` (shallow
  // metadata replace) returns 405 `{"detail":"Method Not Allowed"}` through the gateway,
  // staging-verified 2026-08-07: the gateway's catch-all registers GET/POST/PUT/DELETE only, so
  // PATCH is not proxied at all. Session metadata is therefore write-once, at createSession.
  createSession(
    agentId: string,
    input: { initial_events?: OutboundEvent[]; metadata?: Record<string, unknown> },
    idempotencyKey?: string,
  ): Promise<SessionRecord>
  getSession(agentId: string, sessionId: string, opts?: { history?: boolean; limit?: number }): Promise<SessionRecord>
  /** Newest first by `updated_at`, 50 per page, `page` is 1-based. Single page per call — there is no cursor. */
  listSessions(agentId: string, opts?: { page?: number }): Promise<SessionRecord[]>
  /**
   * Stamp `archived_at`. Afterwards writes are `409 session_archived` while reads keep working.
   * Interrupt an in-flight run first, or the archive races it.
   */
  archiveSession(agentId: string, sessionId: string): Promise<{ session_id?: string; archived: boolean }>
  /** Soft delete (204). An in-flight run is cancelled first; transcripts and events survive for audit. */
  deleteSession(agentId: string, sessionId: string): Promise<void>
  /**
   * 202; `user.interrupt` with no in-flight run returns `accepted:false` — not an error.
   * Accepted events come back as full event objects (with `seq`) where the server supports the
   * unified history; give each event an `idempotency_key` to make timeout retries safe.
   */
  postEvents(agentId: string, sessionId: string, events: OutboundEvent[]): Promise<{ events: PostEventReceipt[] }>
  /**
   * ONE page of durable events — the unified history, which includes your own inputs
   * (`user.message`, …) alongside engine events. `limit` defaults to 100 and is capped at 500;
   * the page's pagination fields are dropped, so use {@link ZooworkClient.listAllEvents}, or
   * {@link ZooworkClient.listEventsPage} to page by hand.
   * Passing `after` selects the deprecated engine-only lane — old cursors only.
   */
  listEvents(agentId: string, sessionId: string, opts?: { after?: number; cursor?: string; types?: string[]; limit?: number }): Promise<SessionEvent[]>
  /**
   * The page-returning primitive under `listEvents`: same options, plus the page's `hasMore`
   * and `nextCursor` (absent on servers without cursor pagination). Feed `nextCursor` back as
   * `cursor` to page by hand.
   */
  listEventsPage(agentId: string, sessionId: string, opts?: { after?: number; cursor?: string; types?: string[]; limit?: number }): Promise<SessionEventPage>
  /**
   * Every durable event: follows the server's `next_cursor` until `has_more` is false, and
   * falls back to walking `after` against servers without cursor pagination (that walk stops
   * when a page fails to advance, so a server that ignored `after` cannot spin it forever).
   *
   * `pageSize` is the per-request `limit` (default and maximum 500). Events come back in
   * ascending `seq`, deduplicated across page boundaries. Passing `after` forces the
   * deprecated engine-only lane.
   */
  listAllEvents(
    agentId: string,
    sessionId: string,
    opts?: { after?: number; types?: string[]; pageSize?: number },
  ): Promise<SessionEvent[]>
  /**
   * Durable event stream with server-side resume.
   *
   * The stream is SESSION-scoped and unbounded: it does NOT close when a turn ends, and the
   * server closes it on idle. Detect turn end with `isRunFinished`, and resume by passing the
   * last event's `cursor` (its `after` fallback selects the deprecated engine-only lane).
   * `chat.delta` preview frames are skipped — they are snapshot-replace frames on a separate
   * Redis-only lane, not durable events.
   */
  streamEvents(agentId: string, sessionId: string, opts?: { after?: number; cursor?: string; signal?: AbortSignal }): AsyncGenerator<SessionEvent>

  // ── approvals ──
  /**
   * Tool calls parked on a human decision. `status` may ONLY be omitted or `'pending'` —
   * staging-verified 2026-08-07; any other value is rejected, so there is no way to list
   * resolved ones.
   *
   * Approvals are a REST resource here, NOT the `user.tool_confirmation` event loop; the two
   * shapes describe the same act and do not line up. Without a Temporal signaler the route
   * answers `501 not_configured`. We have never produced a real pending approval, so the
   * round trip is unproven: treat human-in-the-loop as unavailable, and note that a run parked
   * on an approval burns its whole turn budget waiting.
   */
  listApprovals(agentId: string, opts?: { status?: 'pending' }): Promise<ApprovalRecord[]>
  /** Resolve one approval. `decision` is exactly one of allow-once / allow-always / deny. */
  resolveApproval(
    agentId: string,
    approvalId: string,
    input: { decision: ApprovalDecision; resolvedBy?: string },
  ): Promise<Record<string, unknown>>

  // ── artifacts ──
  //
  // Every artifact route DEMANDS `owner_uid` + `org_id` query selectors — the engine answers
  // `400 ownership_required` without them, and the gateway does NOT inject them here (it does
  // only on `GET /agents`). The SDK derives both from the agent's own projection
  // (`getAgent().ownership`) and caches them per agent for the client's lifetime, so the first
  // artifact call on an agent costs one extra GET. Staging-verified 2026-08-14.
  /**
   * Artifacts this agent published, one page per call — but unlike `listEvents`, the page SAYS
   * when it truncated: read `has_more`. `limit` defaults to 50, capped at 100; filter by
   * `sessionId`, `sourcePath`, or `createdBefore` (ISO timestamp). Empty list staging-verified
   * 2026-08-14; a populated one needs a turn that called `artifact_publish`.
   */
  listArtifacts(
    agentId: string,
    opts?: { page?: number; limit?: number; sessionId?: string; sourcePath?: string; createdBefore?: string },
  ): Promise<ArtifactPage>
  /** One artifact row. A foreign or unknown id is 404 (hidden, not 403). */
  getArtifact(agentId: string, artifactId: string): Promise<ArtifactRecord>
  /**
   * Mint a fresh access URL for a `ready` artifact: `{artifact_id, url}`. A row that never
   * finalized is `409 artifact_not_ready`. The colon in `:download` goes RAW on the wire —
   * this family matches the literal colon, unlike the environments family's `%3A`.
   */
  downloadArtifact(agentId: string, artifactId: string): Promise<{ artifact_id?: string; url?: string }>
  /**
   * Delete one artifact; the 200 body is the row as the engine leaves it. Not yet exercised
   * against staging — doing so needs an artifact a real turn published first.
   */
  deleteArtifact(agentId: string, artifactId: string): Promise<ArtifactRecord>

  // ── automation: schedules, wake ──
  listSchedules(agentId: string): Promise<ScheduleRecord[]>
  /**
   * 201 with a create receipt carrying only `schedule_name`
   * (`cron/{computer_id}/{agent_id}/{schedule_id}`) — not the definition. Read it back with
   * `getSchedule` if you need the stored shape.
   *
   * Schedules outlive their agent: `stopAgent`/`deleteAgent` do not remove them. List and
   * delete them yourself before deleting an agent. Re-creating an existing `schedule_id` with a
   * different definition is a 409; an identical retry is accepted.
   */
  createSchedule(agentId: string, input: ScheduleInput, idempotencyKey?: string): Promise<ScheduleRecord>
  /** Note the camelCase body (`scheduleId`/`computerId`/`agentId`) — create answered in snake_case. */
  getSchedule(agentId: string, scheduleId: string): Promise<ScheduleRecord>
  /**
   * Update the definition.
   *
   * A `getSchedule()` result is NOT a legal PUT body, and this is the method where that costs
   * you. Six of its fields are refused or ignored on the way back in:
   * `execution` / `originMetadata` / `contextSnapshot` / `creatorPrincipalRef` are
   * `400 execution, originMetadata, creatorPrincipalRef, and contextSnapshot are server-derived`,
   * `sessionTarget` is `400 sessionTarget is immutable`, and `scheduleSpec` — the only place a
   * read puts the cadence — is accepted and then SILENTLY IGNORED. The type refuses all six at
   * compile time and the SDK strips them before sending, so the obvious JavaScript round trip
   * (read, tweak, write) both succeeds and preserves the schedule. Staging-verified 2026-08-07.
   *
   * TO CHANGE THE CADENCE, send `schedule: { kind: 'cron', expr, tz }` — the INPUT vocabulary.
   * Echoing back the `scheduleSpec` you just read leaves the old expression in place while every
   * other field in the same body applies. That is the nastiest failure on this route, because it
   * answers 200.
   *
   * PUT and DELETE carry no cross-timeout idempotency guarantee; after a timeout, reconcile by
   * listing and reading runs rather than blind-retrying.
   */
  updateSchedule(agentId: string, scheduleId: string, update: ScheduleUpdate): Promise<ScheduleRecord>
  deleteSchedule(agentId: string, scheduleId: string): Promise<void>
  /** Fire it once, now, out of band. Does not disturb the cadence. */
  triggerSchedule(agentId: string, scheduleId: string): Promise<{ schedule_name?: string; triggered: boolean }>
  /** Past fires, newest first. `limit` defaults to 20 and is capped at 100. */
  listScheduleRuns(agentId: string, scheduleId: string, opts?: { limit?: number }): Promise<ScheduleRun[]>
  /**
   * Push a reminder into the agent's heartbeat queue.
   *
   * `next-heartbeat` (the default) only writes the pending row — it needs no Temporal client,
   * but nothing consumes it unless the agent has a heartbeat configured. `now` writes the row
   * AND kicks the heartbeat schedule, and is `409` when no heartbeat is enabled; if the
   * heartbeat is already busy the kick is skipped (overlap SKIP) and the row waits for the next
   * one. `deliverToUser: false` keeps the reminder internal to the agent's own reasoning.
   */
  wake(agentId: string, input: { text: string; mode?: 'now' | 'next-heartbeat'; deliverToUser?: boolean }): Promise<WakeResult>

  // ── exec ──
  /**
   * Run a command in the agent's sandbox. `args` is argv, not a shell string — use
   * `['bash', '-lc', 'pwd']` for shell semantics.
   *
   * A NON-ZERO EXIT IS STILL HTTP 200. This promise resolves; check `exit_code`. It does not
   * reject on a failed command, only on a failed call.
   *
   * cwd is fixed to `/workspace`. Requires an agent-scope sandbox and a rendered config:
   * a session-scope agent is `409 exec_requires_agent_scope`, an unrendered one is
   * `409 exec_config_not_ready`, and a deployment with no sandbox backend is
   * `501 not_configured`. Default timeout 300s; stdout and stderr are each capped at 200,000
   * characters. This is an operations side door — it bypasses nothing, because it is not the
   * agent's tool path.
   */
  exec(agentId: string, args: string[]): Promise<ExecResult>

  // ── environments ──
  /**
   * Environments visible to your org, 1-based `page`. Note that the platform DEFAULT
   * Environment — the one a fresh agent is pinned to — is not in here and is not fetchable: the
   * gateway forces an org selector and the default belongs to no org.
   */
  listEnvironments(opts?: { page?: number }): Promise<EnvironmentRecord[]>
  /** 404 for any Environment outside your org, including the platform default. */
  getEnvironment(environmentId: string): Promise<EnvironmentRecord>
  /**
   * Create an Environment (and its first version). Give it a stable `idempotencyKey`.
   *
   * `resource.config` takes exactly four keys — packages / files / build / networking — and
   * anything else is `400 invalid_environment_config`. Building is asynchronous: poll
   * `getEnvironmentVersion` until `status === 'ready'` before pinning it on an agent, or the
   * create answers `409 environment_not_ready`. The field is `status` — there is no `state` on a
   * version, and a loop written against one never terminates.
   */
  createEnvironment(
    input: { resource: EnvironmentResource; ownership: Ownership },
    idempotencyKey?: string,
  ): Promise<EnvironmentRecord>
  /**
   * Archive an Environment.
   *
   * THE COLON MUST BE PERCENT-ENCODED. The route is `POST /environments/{id}:archive`, and a
   * raw `:` makes the engine miss the route and answer 404 — verified twice on 2026-08-07. The
   * SDK sends `%3A` for you; this is the whole reason this method exists rather than you
   * building the path.
   */
  archiveEnvironment(environmentId: string): Promise<EnvironmentRecord>
  /**
   * Add an immutable version to an existing Environment. Versions never mutate: a retry after a
   * failed build retries THAT version and keeps its attempt log.
   *
   * The route is reachable, but the request body was not exercised against staging on
   * 2026-08-07 — the SDK sends `{ resource: { config } }`, mirroring create.
   */
  createEnvironmentVersion(
    environmentId: string,
    config: EnvironmentConfig,
    idempotencyKey?: string,
  ): Promise<EnvironmentVersionRecord>
  /** Poll this — not the Environment's top-level state — to decide whether a version is usable. */
  getEnvironmentVersion(environmentId: string, version: number): Promise<EnvironmentVersionRecord>
}

/**
 * Create a client.
 *
 * ```ts
 * const zc = createZooworkClient({ apiKey: 'zct_...' })
 * const zc = createZooworkClient()            // reads ZOOWORK_API_KEY
 * ```
 *
 * Resolution order for both settings is the same: explicit argument, then environment
 * variable, then (for `baseUrl` only) the built-in default.
 *
 * @throws if no API key can be resolved — a missing key is a setup mistake worth failing
 *         loudly at construction rather than as a 401 on the first call.
 */
export function createZooworkClient(cfg: ZooworkConfig = {}): ZooworkClient {
  const doFetch = cfg.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init))
  const base = (cfg.baseUrl ?? readEnv('ZOOWORK_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '')

  const auth: ZooworkAuth | undefined =
    cfg.auth ??
    (cfg.apiKey !== undefined
      ? { apiKey: cfg.apiKey }
      : (() => {
          const fromEnv = readEnv('ZOOWORK_API_KEY')
          return fromEnv ? { apiKey: fromEnv } : undefined
        })())

  if (!auth) {
    throw new Error(
      'No ZooWork API key. Pass createZooworkClient({ apiKey }) or set ZOOWORK_API_KEY. ' +
        'Keys look like zct_… and are issued by an organization administrator.',
    )
  }
  const bearer = 'serviceToken' in auth ? auth.serviceToken : auth.apiKey

  /**
   * TWO error envelopes, one ZooworkError shape, for every helper below.
   *
   * The API does not answer failures the same way everywhere — staging-verified 2026-08-07. Most
   * families send `{ error: { type, message } }`; the agents family sends `{ code, detail }`.
   * Reading only the first left every agent 404 with `type: undefined` and the message `HTTP 404`,
   * so both are unpacked here. The codes stay verbatim (`not_found` vs `service_api.not_found`) —
   * inventing a shared vocabulary would be this SDK guessing, which is what it exists not to do.
   */
  const readResponse = async <T>(res: Response, path: string): Promise<T> => {
    const text = await res.text()
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      let type: string | undefined
      try {
        const j = JSON.parse(text) as {
          error?: { type?: string; message?: string }
          message?: string
          code?: string
          detail?: string
        }
        msg = j?.error?.message || j?.message || j?.detail || msg
        type = j?.error?.type ?? j?.code
      } catch {
        /* non-JSON error body → keep clean status */
      }
      throw new ZooworkError(res.status, msg, type)
    }
    if (!text) return {} as T
    try {
      return JSON.parse(text) as T
    } catch {
      throw new ZooworkError(res.status, `non-JSON response: ${path}`)
    }
  }

  /**
   * `signal` is forwarded to `fetch`, so a request can be cancelled WHILE IT IS IN FLIGHT.
   * That matters because neither Node's `fetch` nor the Workers one has a default timeout:
   * a gateway that accepts the connection and then stalls hangs the promise forever unless
   * somebody hands it a signal. See `waitUntilRunning`, which bounds every poll with one.
   */
  const json = async <T>(
    path: string,
    init: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<T> => {
    const headers: Record<string, string> = { ...init.headers, Authorization: `Bearer ${bearer}` }
    if (init.body && !('Content-Type' in headers)) headers['Content-Type'] = 'application/json'
    const res = await doFetch(`${base}${path}`, {
      method: init.method,
      body: init.body,
      headers,
      ...(init.signal ? { signal: init.signal } : {}),
    })
    return readResponse<T>(res, path)
  }

  /**
   * Multipart sibling of `json()`: same auth, same error envelope, but the body is a `FormData`
   * and the SDK deliberately does NOT set `Content-Type`. The runtime has to set it, because
   * only the runtime knows the boundary it generated — hand-writing
   * `multipart/form-data` yourself produces a body the server cannot parse.
   */
  const multipart = async <T>(path: string, form: FormData, init: { method?: string; headers?: Record<string, string> } = {}): Promise<T> => {
    const headers: Record<string, string> = { ...init.headers, Authorization: `Bearer ${bearer}` }
    const res = await doFetch(`${base}${path}`, { method: init.method ?? 'POST', body: form, headers })
    return readResponse<T>(res, path)
  }

  const agents = (id: string): string => `/agents/${encodeURIComponent(id)}`
  const sessions = (id: string): string => `${agents(id)}/sessions`
  const schedules = (id: string): string => `${agents(id)}/schedules`
  const environments = (id: string): string => `/environments/${encodeURIComponent(id)}`
  const query = (params: Record<string, string | number | undefined>): string => {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v))
    const qs = q.toString()
    return qs ? `?${qs}` : ''
  }

  /**
   * A zip from any of the three shapes callers actually hold. `Blob` exists in every runtime we
   * target, so it is the one currency `FormData` always accepts.
   *
   * The cast is a typings artefact, not a runtime risk: lib.dom narrows `BlobPart`'s view branch
   * to `ArrayBufferView<ArrayBuffer>`, which excludes a plain `Uint8Array` (whose buffer is
   * `ArrayBufferLike`) — i.e. exactly what `fs.readFile` hands you.
   */
  const zipBlob = (zip: Blob | ArrayBuffer | Uint8Array): Blob =>
    zip instanceof Blob ? zip : new Blob([zip as BlobPart], { type: 'application/zip' })

  const skillForm = (zip: Blob | ArrayBuffer | Uint8Array, opts: { fileName?: string; description?: string }): FormData => {
    const form = new FormData()
    // `files[]` is the field name the Skills API expects — it is isomorphic to the Claude
    // Skills API, and exactly one zip goes in it.
    form.append('files[]', zipBlob(zip), opts.fileName ?? 'skill.zip')
    if (opts.description !== undefined) form.append('description', opts.description)
    return form
  }

  /** Interruptible sleep, so an aborted wait does not linger for the rest of its interval. */
  const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      // Check first: `addEventListener('abort')` never fires on an ALREADY-aborted signal, so
      // without this an abort that landed during the preceding request would sleep the whole
      // interval before anyone noticed it.
      if (signal?.aborted) {
        resolve()
        return
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      timer = setTimeout(done, ms)
      signal?.addEventListener('abort', done, { once: true })
    })

  /**
   * `owner_uid` + `org_id` for the artifacts family, derived once per agent from its own
   * projection. The engine requires both selectors on every artifact route and re-checks them
   * against the agent's ownership; the gateway forwards the caller's query verbatim there
   * (it injects selectors only on `GET /agents`), so the SDK has to supply them — and the
   * projection's `ownership` is the one source a key-holder always has. Ownership is
   * immutable for the life of an agent, so the cache never needs invalidating.
   */
  const ownershipByAgent = new Map<string, Ownership>()
  const artifactSelectors = async (agentId: string): Promise<Ownership> => {
    const hit = ownershipByAgent.get(agentId)
    if (hit) return hit
    const projection = await json<AgentRecord>(agents(agentId))
    const own = projection.ownership
    if (!own?.owner_uid || !own.org_id) {
      throw new ZooworkError(
        500,
        `agent ${agentId} projection carries no ownership — cannot derive the owner_uid/org_id ` +
          'selectors the artifact routes require',
        'ownership_unavailable',
      )
    }
    const sel = { owner_uid: own.owner_uid, org_id: own.org_id }
    ownershipByAgent.set(agentId, sel)
    return sel
  }

  const client: ZooworkClient = {
    listModels: async () => {
      const data = await json<ModelInfo[] | { models?: ModelInfo[] }>('/models')
      return Array.isArray(data) ? data : (data.models ?? [])
    },

    createAgent: (input, idempotencyKey) => {
      // Runtime strip, not just type-level: `warm` races the platform credential seeding
      // (sandbox born without creds, never heals — zooclaw-engine#791), and the BOOTSTRAP
      // interview is never what an API caller wants. JS callers bypass the types, so both
      // are enforced here.
      const { warm: _warm, onboarding: _onboarding, ...resource } =
        input.resource as AgentResource & { warm?: unknown; onboarding?: unknown }
      return json('/agents', {
        method: 'POST',
        body: JSON.stringify({
          resource: { ...resource, onboarding: false },
          ...(input.ownership ? { ownership: input.ownership } : {}),
        }),
        ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
      })
    },
    listAgents: async (opts = {}) => {
      const params: Record<string, string | number | undefined> = { page: opts.page }
      for (const [k, v] of Object.entries(opts.labels ?? {})) params[`label.${k}`] = v
      const data = await json<{ agents?: AgentRecord[] }>(`/agents${query(params)}`)
      return data.agents ?? []
    },
    getAgent: (agentId) => json(agents(agentId)),
    updateAgent: (agentId, sections) => json(agents(agentId), { method: 'PUT', body: JSON.stringify(sections) }),
    deleteAgent: async (agentId) => {
      await json(agents(agentId), { method: 'DELETE' })
    },
    startAgent: async (agentId) => {
      const data = await json<{ warnings?: string[] }>(`${agents(agentId)}/start`, { method: 'POST' })
      return { warnings: data.warnings ?? [] }
    },
    stopAgent: async (agentId) => {
      const data = await json<{ warnings?: string[] }>(`${agents(agentId)}/stop`, { method: 'POST' })
      return { warnings: data.warnings ?? [] }
    },
    waitUntilRunning: async (agentId, opts = {}) => {
      const timeoutMs = opts.timeoutMs ?? 30_000
      const intervalMs = opts.intervalMs ?? 500
      const deadline = Date.now() + timeoutMs
      let lastSeen = 'unknown'
      const abortedError = (): ZooworkError => new ZooworkError(0, `waitUntilRunning(${agentId}) aborted`, 'aborted')
      const timeoutError = (): ZooworkError =>
        new ZooworkError(
          408,
          `agent ${agentId} did not reach status.desired_state=running within ${timeoutMs}ms ` +
            `(last seen: ${lastSeen})`,
          'timeout',
        )
      for (;;) {
        if (opts.signal?.aborted) throw abortedError()
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw timeoutError()

        // THE POLL ITSELF IS BOUNDED, not just the gap between polls. `fetch` has no default
        // timeout anywhere we run, so a gateway that accepts the connection and then stalls
        // would otherwise park this promise forever — outliving both `timeoutMs` and the
        // caller's `signal`, which is the exact never-returning readiness loop this helper
        // exists to prevent. The per-request signal fires on whichever comes first.
        const poll = new AbortController()
        const cancelPoll = (): void => poll.abort()
        opts.signal?.addEventListener('abort', cancelPoll, { once: true })
        const budget = setTimeout(cancelPoll, remaining)
        let agent: AgentRecord
        try {
          agent = await json<AgentRecord>(agents(agentId), { signal: poll.signal })
        } catch (e) {
          // Our own cancellation surfaces as a fetch AbortError; translate it into the two
          // outcomes this method documents instead of leaking a DOMException.
          if (poll.signal.aborted) throw opts.signal?.aborted ? abortedError() : timeoutError()
          throw e
        } finally {
          clearTimeout(budget)
          opts.signal?.removeEventListener('abort', cancelPoll)
        }

        // desired_state, never actual_state — see the doc comment on this method.
        lastSeen = agent.status?.desired_state ?? 'unknown'
        if (lastSeen === 'running') return agent
        if (Date.now() + intervalMs > deadline) throw timeoutError()
        await sleep(intervalMs, opts.signal)
      }
    },
    listAgentSkills: async (agentId, opts = {}) => {
      const data = await json<{ skills?: AgentSkill[] }>(
        `${agents(agentId)}/skills${opts.verbose ? '?verbose=true' : ''}`,
      )
      return data.skills ?? []
    },
    putAgentSkill: (agentId, skillId, opts = {}) =>
      json(`${agents(agentId)}/skills/${encodeURIComponent(skillId)}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: opts.enabled ?? true, version_pin: opts.versionPin ?? null }),
      }),
    deleteAgentSkill: async (agentId, skillId) => {
      await json(`${agents(agentId)}/skills/${encodeURIComponent(skillId)}`, { method: 'DELETE' })
    },

    listChannels: async (agentId) => {
      const data = await json<{ channels?: AgentChannel[] }>(`${agents(agentId)}/channels`)
      return data.channels ?? []
    },
    addChannel: (agentId, input) =>
      json(`${agents(agentId)}/channels`, { method: 'POST', body: JSON.stringify(input) }),
    updateChannel: (agentId, platform, input = {}) =>
      json(`${agents(agentId)}/channels/${encodeURIComponent(platform)}/update`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    removeChannel: async (agentId, platform, opts = {}) => {
      await json(`${agents(agentId)}/channels/${encodeURIComponent(platform)}/remove`, {
        method: 'POST',
        body: JSON.stringify({ account: opts.account ?? 'default' }),
      })
    },
    startFeishuSetup: (agentId, input = {}) =>
      json(`${agents(agentId)}/channels/feishu/setup`, { method: 'POST', body: JSON.stringify(input) }),
    pollFeishuSetup: (agentId, sessionId) =>
      json(`${agents(agentId)}/channels/feishu/poll${query({ session_id: sessionId })}`),
    cancelFeishuSetup: async (agentId, sessionId) => {
      await json(`${agents(agentId)}/channels/feishu/setup/cancel${query({ session_id: sessionId })}`, {
        method: 'POST',
      })
    },
    waitForFeishuSetup: async (agentId, sessionId, opts = {}) => {
      const timeoutMs = opts.timeoutMs ?? 600_000
      const deadline = Date.now() + timeoutMs
      let lastStatus = 'unknown'
      const abortedError = (): ZooworkError =>
        new ZooworkError(0, `waitForFeishuSetup(${agentId}, ${sessionId}) aborted`, 'aborted')
      const timeoutError = (): ZooworkError =>
        new ZooworkError(
          408,
          `Feishu setup session ${sessionId} still '${lastStatus}' after ${timeoutMs}ms — ` +
            'the QR may simply not have been scanned yet; the session itself expires server-side',
          'timeout',
        )
      for (;;) {
        if (opts.signal?.aborted) throw abortedError()
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw timeoutError()

        // Same in-flight bound as waitUntilRunning: without it, a stalled gateway would park
        // this promise past both the budget and the caller's signal.
        const poll = new AbortController()
        const cancelPoll = (): void => poll.abort()
        opts.signal?.addEventListener('abort', cancelPoll, { once: true })
        const budget = setTimeout(cancelPoll, remaining)
        let result: FeishuPollResult
        try {
          result = await json<FeishuPollResult>(
            `${agents(agentId)}/channels/feishu/poll${query({ session_id: sessionId })}`,
            { signal: poll.signal },
          )
        } catch (e) {
          if (poll.signal.aborted) throw opts.signal?.aborted ? abortedError() : timeoutError()
          throw e
        } finally {
          clearTimeout(budget)
          opts.signal?.removeEventListener('abort', cancelPoll)
        }

        opts.onPoll?.(result)
        lastStatus = result.status ?? 'unknown'
        // Only a literal 'pending' keeps the loop alive… except that an UNKNOWN status is
        // treated as still-in-flight too (see FeishuPollResult): a new intermediate state on
        // the server should stretch the wait, not end it with a fake terminal result.
        const terminal = ['success', 'expired', 'denied', 'error'].includes(lastStatus)
        if (terminal) return result
        // Server semantics: poll_interval is in SECONDS. The floor only guards a 0/negative
        // value from ever busy-looping the gateway.
        const intervalMs = Math.max(250, (result.poll_interval ?? 5) * 1000)
        if (Date.now() + intervalMs > deadline) throw timeoutError()
        await sleep(intervalMs, opts.signal)
      }
    },

    uploadSkill: (zip, opts) => {
      const form = skillForm(zip, opts)
      form.append('scope', opts.scope)
      return multipart<SkillRecord>('/skills', form, {
        ...(opts.idempotencyKey ? { headers: { 'Idempotency-Key': opts.idempotencyKey } } : {}),
      })
    },
    uploadSkillVersion: (skillId, zip, opts = {}) =>
      multipart<SkillRecord>(`/skills/${encodeURIComponent(skillId)}/versions`, skillForm(zip, opts), {
        ...(opts.idempotencyKey ? { headers: { 'Idempotency-Key': opts.idempotencyKey } } : {}),
      }),
    listSkills: async (opts = {}) => {
      const data = await json<{ skills?: SkillRecord[] }>(
        `/skills${query({ scope: opts.scope, q: opts.q, page: opts.page })}`,
      )
      return data.skills ?? []
    },
    deleteSkill: async (skillId) => {
      await json(`/skills/${encodeURIComponent(skillId)}`, { method: 'DELETE' })
    },

    createSession: (agentId, input, idempotencyKey) =>
      json(sessions(agentId), {
        method: 'POST',
        body: JSON.stringify(input),
        ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
      }),
    getSession: (agentId, sessionId, opts = {}) => {
      const q = new URLSearchParams()
      if (opts.history) q.set('history', 'true')
      if (opts.limit !== undefined) q.set('limit', String(opts.limit))
      const qs = q.toString()
      return json(`${sessions(agentId)}/${encodeURIComponent(sessionId)}${qs ? `?${qs}` : ''}`)
    },
    listSessions: async (agentId, opts = {}) => {
      const data = await json<{ sessions?: SessionRecord[] }>(`${sessions(agentId)}${query({ page: opts.page })}`)
      return data.sessions ?? []
    },
    archiveSession: async (agentId, sessionId) => {
      const data = await json<{ session_id?: string; archived?: boolean }>(
        `${sessions(agentId)}/${encodeURIComponent(sessionId)}/archive`,
        { method: 'POST' },
      )
      return { ...data, archived: data.archived ?? false }
    },
    deleteSession: async (agentId, sessionId) => {
      await json(`${sessions(agentId)}/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
    },
    postEvents: async (agentId, sessionId, events) => {
      const data = await json<{ events?: { id?: string; type?: string; accepted?: boolean }[] }>(
        `${sessions(agentId)}/${encodeURIComponent(sessionId)}/events`,
        { method: 'POST', body: JSON.stringify({ events }) },
      )
      return { events: data.events ?? [] }
    },
    listEvents: async (agentId, sessionId, opts = {}) => (await client.listEventsPage(agentId, sessionId, opts)).events,
    listEventsPage: async (agentId, sessionId, opts = {}) => {
      const data = await json<{ events?: unknown[]; has_more?: boolean; next_cursor?: string | null }>(
        `${sessions(agentId)}/${encodeURIComponent(sessionId)}/events${query({
          after: opts.after,
          cursor: opts.cursor,
          types: opts.types?.join(','),
          limit: opts.limit,
        })}`,
      )
      return {
        events: (data.events ?? []).map((e) => normalizeEvent(e)),
        ...(data.has_more !== undefined ? { hasMore: data.has_more } : {}),
        ...(data.next_cursor !== undefined ? { nextCursor: data.next_cursor } : {}),
      }
    },
    listAllEvents: async (agentId, sessionId, opts = {}) => {
      const pageSize = Math.min(Math.max(opts.pageSize ?? 500, 1), 500)
      const out: SessionEvent[] = []
      // Unified lane (default): follow the server's cursor until has_more is false.
      if (opts.after === undefined) {
        let pageCursor: string | undefined
        for (;;) {
          const page = await client.listEventsPage(agentId, sessionId, {
            ...(pageCursor !== undefined ? { cursor: pageCursor } : {}),
            ...(opts.types ? { types: opts.types } : {}),
            limit: pageSize,
          })
          // A cursor that fails to advance means the same page again — stop before
          // re-appending it rather than refetching it forever.
          if (page.hasMore !== undefined && page.nextCursor === pageCursor) return out
          out.push(...page.events)
          if (page.hasMore === undefined) {
            // Before the first cursor this is a server without cursor pagination: a short
            // page already ends the history, a full one continues on the `after` walk below.
            // Mid-walk it is a protocol violation — return what we have rather than silently
            // switching to the engine-only lane and dropping input events.
            if (pageCursor !== undefined || page.events.length < pageSize) return out
            break
          }
          if (!page.hasMore || !page.nextCursor || page.events.length === 0) return out
          pageCursor = page.nextCursor
        }
      }
      let cursor = opts.after ?? out.reduce((max, e) => (e.seq > max ? e.seq : max), 0)
      for (;;) {
        const page = await client.listEvents(agentId, sessionId, {
          after: cursor,
          ...(opts.types ? { types: opts.types } : {}),
          limit: pageSize,
        })
        // Anything at or below the cursor is a boundary replay — or a server that ignored
        // `after`. Dropping it keeps the result deduplicated AND the walk finite.
        const fresh = cursor > 0 ? page.filter((e) => e.seq > cursor) : page
        out.push(...fresh)
        const highest = fresh.reduce((max, e) => (e.seq > max ? e.seq : max), cursor)
        if (page.length < pageSize || highest <= cursor) return out
        cursor = highest
      }
    },

    async *streamEvents(agentId, sessionId, opts = {}) {
      const after = opts.after ?? 0
      let lastSeq = after
      const qs = query(opts.cursor !== undefined ? { cursor: opts.cursor } : { after: after > 0 ? after : undefined })
      const path = `${sessions(agentId)}/${encodeURIComponent(sessionId)}/events/stream${qs}`
      try {
        const res = await doFetch(`${base}${path}`, {
          headers: { Authorization: `Bearer ${bearer}`, Accept: 'text/event-stream' },
          ...(opts.signal ? { signal: opts.signal } : {}),
        })
        if (!res.ok) throw new ZooworkError(res.status, `events stream HTTP ${res.status}`)
        if (!res.body) return

        for await (const msg of parseSSE(res.body)) {
          if (msg.event === 'event_delta') continue
          if (!isObj(msg.data)) continue
          const ev = normalizeEvent(msg.data, msg.id)
          // The server already resumes from `after`; this guards the boundary event being
          // replayed when a dropped connection is re-established.
          if (ev.seq >= 0 && ev.seq <= lastSeq) continue
          if (ev.seq > lastSeq) lastSeq = ev.seq
          yield ev
        }
      } catch (e) {
        if (opts.signal?.aborted) return
        throw e
      }
    },

    listApprovals: async (agentId, opts = {}) => {
      const data = await json<{ approvals?: ApprovalRecord[] }>(
        `${agents(agentId)}/approvals${query({ status: opts.status })}`,
      )
      return data.approvals ?? []
    },
    resolveApproval: (agentId, approvalId, input) =>
      json(`${agents(agentId)}/approvals/${encodeURIComponent(approvalId)}/resolve`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    getSystemPrompt: (agentId) => json(`${agents(agentId)}/system-prompt`),
    // The colon goes RAW here: this family matches the literal `system-prompt:preview` segment,
    // and both spellings pass the gateway (verified 2026-08-14) — so raw also serves the
    // deployment-internal direct mode, whose HTTP server never percent-decodes the path.
    previewSystemPrompt: (agentId, input) =>
      json(`${agents(agentId)}/system-prompt:preview`, { method: 'POST', body: JSON.stringify(input) }),
    upgradeSystemPrompt: (agentId, input) =>
      json(`${agents(agentId)}:upgrade-system-prompt`, { method: 'POST', body: JSON.stringify(input) }),

    listArtifacts: async (agentId, opts = {}) => {
      const sel = await artifactSelectors(agentId)
      const data = await json<ArtifactPage>(
        `${agents(agentId)}/artifacts${query({
          ...sel,
          page: opts.page,
          limit: opts.limit,
          session_id: opts.sessionId,
          source_path: opts.sourcePath,
          created_before: opts.createdBefore,
        })}`,
      )
      return { ...data, artifacts: data.artifacts ?? [] }
    },
    getArtifact: async (agentId, artifactId) => {
      const sel = await artifactSelectors(agentId)
      return json(`${agents(agentId)}/artifacts/${encodeURIComponent(artifactId)}${query({ ...sel })}`)
    },
    downloadArtifact: async (agentId, artifactId) => {
      const sel = await artifactSelectors(agentId)
      return json(`${agents(agentId)}/artifacts/${encodeURIComponent(artifactId)}:download${query({ ...sel })}`, {
        method: 'POST',
      })
    },
    deleteArtifact: async (agentId, artifactId) => {
      const sel = await artifactSelectors(agentId)
      return json(`${agents(agentId)}/artifacts/${encodeURIComponent(artifactId)}${query({ ...sel })}`, {
        method: 'DELETE',
      })
    },

    listSchedules: async (agentId) => {
      const data = await json<{ schedules?: ScheduleRecord[] }>(schedules(agentId))
      return data.schedules ?? []
    },
    createSchedule: (agentId, input, idempotencyKey) =>
      json(schedules(agentId), {
        method: 'POST',
        body: JSON.stringify(input),
        ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
      }),
    getSchedule: (agentId, scheduleId) => json(`${schedules(agentId)}/${encodeURIComponent(scheduleId)}`),
    updateSchedule: (agentId, scheduleId, update) => {
      // Stripped rather than forwarded. Every one of these is a field `getSchedule()` hands you
      // and the PUT refuses: four are `server-derived` 400s, `sessionTarget` is an `immutable`
      // 400, and `scheduleSpec` is worse than a 400 — it is accepted and ignored, so echoing a
      // read back would answer 200 while quietly dropping the cadence change. The types already
      // refuse all six; this is what makes the same round trip work from JavaScript.
      const {
        sessionTarget: _immutable,
        scheduleSpec: _readShape,
        execution: _derived1,
        originMetadata: _derived2,
        contextSnapshot: _derived3,
        creatorPrincipalRef: _derived4,
        ...body
      } = update
      return json(`${schedules(agentId)}/${encodeURIComponent(scheduleId)}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      })
    },
    deleteSchedule: async (agentId, scheduleId) => {
      await json(`${schedules(agentId)}/${encodeURIComponent(scheduleId)}`, { method: 'DELETE' })
    },
    triggerSchedule: async (agentId, scheduleId) => {
      const data = await json<{ schedule_name?: string; triggered?: boolean }>(
        `${schedules(agentId)}/${encodeURIComponent(scheduleId)}/trigger`,
        { method: 'POST' },
      )
      return { ...data, triggered: data.triggered ?? false }
    },
    listScheduleRuns: async (agentId, scheduleId, opts = {}) => {
      const data = await json<{ runs?: ScheduleRun[] }>(
        `${schedules(agentId)}/${encodeURIComponent(scheduleId)}/runs${query({ limit: opts.limit })}`,
      )
      return data.runs ?? []
    },
    wake: (agentId, input) => json(`${agents(agentId)}/wake`, { method: 'POST', body: JSON.stringify(input) }),

    exec: (agentId, args) => json(`${agents(agentId)}/exec`, { method: 'POST', body: JSON.stringify({ args }) }),

    listEnvironments: async (opts = {}) => {
      const data = await json<{ environments?: EnvironmentRecord[] }>(`/environments${query({ page: opts.page })}`)
      return data.environments ?? []
    },
    getEnvironment: (environmentId) => json(environments(environmentId)),
    createEnvironment: (input, idempotencyKey) =>
      json('/environments', {
        method: 'POST',
        body: JSON.stringify(input),
        ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
      }),
    // `%3A`, never a literal ':' — the engine misses the route on a raw colon and answers 404.
    archiveEnvironment: (environmentId) =>
      json(`/environments/${encodeURIComponent(environmentId)}%3Aarchive`, { method: 'POST' }),
    createEnvironmentVersion: (environmentId, config, idempotencyKey) =>
      json(`${environments(environmentId)}/versions`, {
        method: 'POST',
        body: JSON.stringify({ resource: { config } }),
        ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
      }),
    getEnvironmentVersion: (environmentId, version) =>
      json(`${environments(environmentId)}/versions/${encodeURIComponent(String(version))}`),
  }

  return client
}
