/**
 * ZooClaw Managed Agents SDK — core client. Developer Preview.
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
 * The default API base URL. You should not need to set this — `ZOOCLAW_BASE_URL`
 * overrides it, and so does the `baseUrl` option, when you need a different deployment.
 */
export const DEFAULT_BASE_URL = 'https://claw-interface.ecap.yesy.live/service/v1'

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

export type ZooclawAuth = { serviceToken: string } | { apiKey: string }

export interface ZooclawConfig {
  /**
   * Your API key (`zct_...`). Defaults to `ZOOCLAW_API_KEY`.
   *
   * Server-side only: it authenticates as your whole organization, not as one end user.
   */
  apiKey?: string
  /**
   * API base including the version prefix. Defaults to `ZOOCLAW_BASE_URL`, then to
   * {@link DEFAULT_BASE_URL}. Set it to pin an environment, or to point at a deployment
   * other than the public one.
   */
  baseUrl?: string
  /**
   * Advanced. `{ apiKey }` is equivalent to the top-level `apiKey` field. `{ serviceToken }`
   * selects a privileged deployment-internal credential and is not available to API-key
   * callers.
   */
  auth?: ZooclawAuth
  /** Injected fetch for edge runtimes/tests; defaults to globalThis.fetch. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
}

export class ZooclawError extends Error {
  status: number
  /** The API's error envelope `error.type`, e.g. `agent_not_running`, `idempotency_conflict`. */
  type?: string
  constructor(status: number, message: string, type?: string) {
    super(message)
    this.name = 'ZooclawError'
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

export interface AgentResource {
  name: string
  model?: { primary: string; input?: string[] }
  persona?: { docs: { name: string; content: string; seed_policy?: string }[] }
  skills?: { skill_id: string; version?: number | 'latest' }[]
  labels?: Record<string, string>
  tool_policy?: Record<string, unknown>
  sandbox?: { scope: 'agent' | 'session' }
  environment_id?: string
  environment_version?: number
  warm?: boolean
  [k: string]: unknown
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
  status?: AgentStatus
  ownership?: Ownership
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
  session_key?: string
  channel?: string
  status?: string
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

export type { SessionEvent } from './events.js'

export interface ZooclawClient {
  listModels(): Promise<ModelInfo[]>

  // ── agents ──
  createAgent(input: { resource: AgentResource; ownership: Ownership }, idempotencyKey?: string): Promise<AgentRecord>
  getAgent(agentId: string): Promise<AgentRecord>
  /** PUT declared sections; bumps config_version on EVERY call — gate on drift, don't blind-retry. */
  updateAgent(agentId: string, sections: Record<string, unknown>): Promise<AgentRecord>
  deleteAgent(agentId: string): Promise<void>
  /** Not reachable with an API key — the gateway manages these credentials for you and
   *  answers 404 here. Present for deployment-internal callers only. */
  putCredential(agentId: string, app: string, body: Record<string, unknown>): Promise<void>
  listCredentials(agentId: string): Promise<{ app: string; ref: string }[]>
  /**
   * Flip `desired_state` to `running` — the precondition for every session call.
   * Fast (sub-second on staging). The returned warnings are informational: an
   * API-only agent reports `channel_routes_reload_failed` on every start/stop
   * because it has no chat-channel routes to reload. Do not treat it as failure.
   */
  startAgent(agentId: string): Promise<{ warnings: string[] }>
  stopAgent(agentId: string): Promise<{ warnings: string[] }>
  /** Skills already attached to the agent, resolved and merged. `verbose` includes ineligible/excluded entries. */
  listAgentSkills(agentId: string, opts?: { verbose?: boolean }): Promise<AgentSkill[]>
  /**
   * Attach a skill by id. Only skills the caller's tenant owns are installable
   * through the `/service/v1` gateway (`org` / `personal` scope); `global`
   * catalog entries are listable but answer 404 here.
   */
  putAgentSkill(agentId: string, skillId: string, opts?: { enabled?: boolean; versionPin?: number | null }): Promise<{ config_version?: number; warnings?: string[] }>
  deleteAgentSkill(agentId: string, skillId: string): Promise<void>

  // ── sessions ──
  createSession(
    agentId: string,
    input: { initial_events?: OutboundEvent[]; metadata?: Record<string, unknown> },
    idempotencyKey?: string,
  ): Promise<SessionRecord>
  getSession(agentId: string, sessionId: string, opts?: { history?: boolean; limit?: number }): Promise<SessionRecord>
  /** 202; `user.interrupt` with no in-flight run returns `accepted:false` — not an error. */
  postEvents(agentId: string, sessionId: string, events: OutboundEvent[]): Promise<{ events: { id?: string; type?: string; accepted?: boolean }[] }>
  listEvents(agentId: string, sessionId: string, opts?: { after?: number; types?: string[]; limit?: number }): Promise<SessionEvent[]>
  /**
   * Durable event stream with server-side resume (`?after=<seq>`).
   *
   * The stream is SESSION-scoped and unbounded: it does NOT close when a turn ends, and the
   * server closes it on idle. Detect turn end with `isRunFinished`, and resume the next
   * window from the last seq you saw. `chat.delta` preview frames are skipped — they are
   * snapshot-replace frames on a separate Redis-only lane, not durable events.
   */
  streamEvents(agentId: string, sessionId: string, opts?: { after?: number; signal?: AbortSignal }): AsyncGenerator<SessionEvent>
}

/**
 * Create a client.
 *
 * ```ts
 * const zc = createZooclawClient({ apiKey: 'zct_...' })
 * const zc = createZooclawClient()            // reads ZOOCLAW_API_KEY
 * ```
 *
 * Resolution order for both settings is the same: explicit argument, then environment
 * variable, then (for `baseUrl` only) the built-in default.
 *
 * @throws if no API key can be resolved — a missing key is a setup mistake worth failing
 *         loudly at construction rather than as a 401 on the first call.
 */
export function createZooclawClient(cfg: ZooclawConfig = {}): ZooclawClient {
  const doFetch = cfg.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init))
  const base = (cfg.baseUrl ?? readEnv('ZOOCLAW_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '')

  const auth: ZooclawAuth | undefined =
    cfg.auth ??
    (cfg.apiKey !== undefined
      ? { apiKey: cfg.apiKey }
      : (() => {
          const fromEnv = readEnv('ZOOCLAW_API_KEY')
          return fromEnv ? { apiKey: fromEnv } : undefined
        })())

  if (!auth) {
    throw new Error(
      'No ZooClaw API key. Pass createZooclawClient({ apiKey }) or set ZOOCLAW_API_KEY. ' +
        'Keys look like zct_… and are issued by an organization administrator.',
    )
  }
  const bearer = 'serviceToken' in auth ? auth.serviceToken : auth.apiKey

  const json = async <T>(path: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<T> => {
    const headers: Record<string, string> = { ...init.headers, Authorization: `Bearer ${bearer}` }
    if (init.body && !('Content-Type' in headers)) headers['Content-Type'] = 'application/json'
    const res = await doFetch(`${base}${path}`, { method: init.method, body: init.body, headers })
    const text = await res.text()
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      let type: string | undefined
      try {
        const j = JSON.parse(text) as { error?: { type?: string; message?: string }; message?: string }
        msg = j?.error?.message || j?.message || msg
        type = j?.error?.type
      } catch {
        /* non-JSON error body → keep clean status */
      }
      throw new ZooclawError(res.status, msg, type)
    }
    if (!text) return {} as T
    try {
      return JSON.parse(text) as T
    } catch {
      throw new ZooclawError(res.status, `non-JSON response: ${path}`)
    }
  }

  const agents = (id: string): string => `/agents/${encodeURIComponent(id)}`
  const sessions = (id: string): string => `${agents(id)}/sessions`

  return {
    listModels: async () => {
      const data = await json<ModelInfo[] | { models?: ModelInfo[] }>('/models')
      return Array.isArray(data) ? data : (data.models ?? [])
    },

    createAgent: (input, idempotencyKey) =>
      json('/agents', {
        method: 'POST',
        body: JSON.stringify(input),
        ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
      }),
    getAgent: (agentId) => json(agents(agentId)),
    updateAgent: (agentId, sections) => json(agents(agentId), { method: 'PUT', body: JSON.stringify(sections) }),
    deleteAgent: async (agentId) => {
      await json(agents(agentId), { method: 'DELETE' })
    },
    putCredential: async (agentId, app, body) => {
      await json(`${agents(agentId)}/credentials/${encodeURIComponent(app)}`, { method: 'PUT', body: JSON.stringify(body) })
    },
    listCredentials: async (agentId) => {
      const data = await json<{ credentials?: { app: string; ref: string }[] }>(`${agents(agentId)}/credentials`)
      return data.credentials ?? []
    },
    startAgent: async (agentId) => {
      const data = await json<{ warnings?: string[] }>(`${agents(agentId)}/start`, { method: 'POST' })
      return { warnings: data.warnings ?? [] }
    },
    stopAgent: async (agentId) => {
      const data = await json<{ warnings?: string[] }>(`${agents(agentId)}/stop`, { method: 'POST' })
      return { warnings: data.warnings ?? [] }
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
    postEvents: async (agentId, sessionId, events) => {
      const data = await json<{ events?: { id?: string; type?: string; accepted?: boolean }[] }>(
        `${sessions(agentId)}/${encodeURIComponent(sessionId)}/events`,
        { method: 'POST', body: JSON.stringify({ events }) },
      )
      return { events: data.events ?? [] }
    },
    listEvents: async (agentId, sessionId, opts = {}) => {
      const q = new URLSearchParams()
      if (opts.after !== undefined) q.set('after', String(opts.after))
      if (opts.types !== undefined) q.set('types', opts.types.join(','))
      if (opts.limit !== undefined) q.set('limit', String(opts.limit))
      const qs = q.toString()
      const data = await json<{ events?: unknown[] }>(
        `${sessions(agentId)}/${encodeURIComponent(sessionId)}/events${qs ? `?${qs}` : ''}`,
      )
      return (data.events ?? []).map((e) => normalizeEvent(e))
    },

    async *streamEvents(agentId, sessionId, opts = {}) {
      const after = opts.after ?? 0
      let lastSeq = after
      const path = `${sessions(agentId)}/${encodeURIComponent(sessionId)}/events/stream${after > 0 ? `?after=${after}` : ''}`
      try {
        const res = await doFetch(`${base}${path}`, {
          headers: { Authorization: `Bearer ${bearer}`, Accept: 'text/event-stream' },
          ...(opts.signal ? { signal: opts.signal } : {}),
        })
        if (!res.ok) throw new ZooclawError(res.status, `events stream HTTP ${res.status}`)
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
  }
}
