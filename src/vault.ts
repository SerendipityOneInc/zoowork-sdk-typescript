/**
 * Vault: credential storage for an Agent's MCP servers, the Vault fields of Session creation,
 * revoking a Session's Vault binding, and the offboarding ledger.
 *
 * BETA. Every method and type in this module is a beta feature. It needs Vault enabled for your
 * ZooWork account or environment; until then the server answers 404 `service_api.not_found`, or
 * 400 `vault.session_fields_unavailable` when `createSession` carries Vault fields. The SDK throws
 * a {@link VaultBetaUnavailableError} for both (match with {@link isVaultBetaUnavailable}), with
 * the server's code kept verbatim in `type`. Behaviour and fields may change before general
 * availability.
 *
 * Rules that hold for every call here:
 *
 * - Platform API keys only. A project key manages its project's Vaults; the Default Project key
 *   manages the organization's Vaults. A project key cannot read or manage an org Vault
 *   (403 `vault.management_forbidden`); a Default Project key does not see project Vaults (404).
 * - One logical operation, one `idempotencyKey`. Retry a timeout or 503 `vault.unavailable` with the
 *   SAME key: the server replays the first result. Reusing a key for a different request (another
 *   Vault, another body) is 409 `vault.idempotency_conflict`.
 * - Writes on a resource with a revision send `revision` as `If-Match`; a stale one is
 *   412 `vault.revision_conflict` (read again, then retry with the current revision).
 *   `validateVaultCredential` takes neither: it is a bounded probe that changes nothing.
 * - Retrying a delete that already succeeded answers 404 `vault.not_found`: treat it as done.
 * - Responses never carry credential secrets. IDs are opaque; ignore unknown fields.
 *
 * The SDK offers no way to set the internal `X-Zooclaw-Vault-Context` header: the service builds it
 * from your key. Option objects carry exactly the headers documented on them.
 *
 * @module
 */

import type { ZooworkError } from './client.js'

/** @beta Lifecycle of a Vault or credential. */
export type VaultResourceStatus = 'active' | 'archived' | 'deleted' | string

/** @beta Purge progress after a delete. */
export type VaultPurgeState = 'none' | 'pending' | 'failed' | 'complete' | string

/** @beta An org Vault is visible to the whole organization; a project Vault to one project. */
export type VaultScope = 'org' | 'project'

/** @beta A Vault. The Default Project key manages org Vaults; a project key its project's. */
export interface VaultRecord {
  id: string
  scope: VaultScope | string
  /** The `proj_…` ID of a project Vault; `null` for an org Vault. */
  project_id: string | null
  name: string
  metadata: Record<string, unknown>
  status: VaultResourceStatus
  /** Send it back as `revision` on update, archive and delete. */
  revision: number
  purge_state: VaultPurgeState
  created_at: string
  [k: string]: unknown
}

/**
 * @beta Create a Vault. Choose the scope explicitly: an org Vault (Default Project key) or a
 * project Vault naming your key's own `proj_…` project ID (another project is 404).
 */
export type VaultCreateInput =
  | { scope: 'org'; name: string; metadata?: Record<string, unknown> }
  | { scope: 'project'; project_id: string; name: string; metadata?: Record<string, unknown> }

/** @beta Change a Vault. Give at least one field; omit, never `null`, the ones you keep. */
export type VaultUpdateInput =
  | { name: string; metadata?: Record<string, unknown> }
  | { name?: string; metadata: Record<string, unknown> }

/** @beta One page of a cursor list. Pass `next_cursor` back verbatim while `has_more`. */
export interface VaultPage {
  data: VaultRecord[]
  next_cursor: string | null
  has_more: boolean
  [k: string]: unknown
}

/** @beta Options of {@link VaultApi.listVaultCredentials}. */
export interface VaultCredentialListOptions {
  cursor?: string
  /** 1–100. */
  limit?: number
  status?: 'active' | 'archived'
}

/** @beta Options of {@link VaultApi.listVaults}. Lists return your key's own scope. */
export interface VaultListOptions extends VaultCredentialListOptions {
  scope?: VaultScope
}

/** @beta The `Idempotency-Key` of a write without a revision (create). */
export interface VaultWriteOptions {
  /** 1–256 characters. One per logical operation; reuse it, unchanged, to retry that operation. */
  idempotencyKey: string
}

/** @beta A write on a resource that has a revision: sends `Idempotency-Key` and `If-Match`. */
export interface VaultRevisionWriteOptions extends VaultWriteOptions {
  /** The current `revision` of the resource, sent as the decimal `If-Match` header. */
  revision: number
}

/** @beta Engine-managed OAuth refresh material. The server keeps it off until it opens managed refresh
 * (400 `vault.unsupported_refresh_owner` meanwhile). */
export type VaultManagedRefreshInput = {
  token_endpoint: string
  client_id: string
  refresh_token: string
  resource?: string
  scope?: string
  /** Omitted: `true` on create, the stored value on a later re-authorization. Never `null`. */
  rotates_refresh_token?: boolean
} & (
  | { token_endpoint_auth: 'none'; client_secret?: never }
  | { token_endpoint_auth: 'client_secret_basic' | 'client_secret_post'; client_secret: string }
)

/** @beta How a credential authenticates to its MCP server. Every URL is `https://`. */
export type VaultCredentialAuth =
  | { type: 'static_bearer'; mcp_server_url: string; access_token: string }
  | { type: 'static_headers'; mcp_server_url: string; headers: Record<string, string> }
  | {
      type: 'mcp_oauth'
      mcp_server_url: string
      access_token: string
      /** Required; `null` when the expiry is unknown. */
      expires_at: string | null
      /** Your application refreshes the token and rotates it with `updateVaultCredential`. */
      refresh_owner: 'external'
    }
  | {
      type: 'mcp_oauth'
      mcp_server_url: string
      access_token: string
      expires_at: string | null
      /** ZooWork refreshes the token with `refresh`. */
      refresh_owner: 'engine'
      refresh: VaultManagedRefreshInput
    }

/** @beta Create a credential in a Vault. */
export interface VaultCredentialCreateInput {
  name: string
  purpose: 'mcp'
  /** Your opaque reference for the provider account (1–256 characters). */
  provider_account_ref: string
  auth: VaultCredentialAuth
}

/**
 * @beta A secret rotation: new headers, or a new access token (optionally with its expiry, owner and
 * refresh material). An omitted `refresh_owner` keeps the stored one.
 */
export type VaultCredentialAuthRotation =
  | { headers: Record<string, string>; access_token?: never; expires_at?: never; refresh_owner?: never; refresh?: never }
  | {
      headers?: never
      access_token: string
      expires_at?: string | null
      refresh_owner?: 'external' | 'engine'
      refresh?: VaultManagedRefreshInput
    }

/** @beta Rename a credential, rotate its secret, or both. Omit, never `null`, what you keep. */
export type VaultCredentialUpdateInput =
  | { name: string; auth?: VaultCredentialAuthRotation }
  | { name?: string; auth: VaultCredentialAuthRotation }

/** @beta Known credential health states. Anything else is reported as `unknown`. */
export type VaultCredentialHealthState = 'ok' | 'degraded' | 'expired' | 'reauthorization_required' | 'unknown'

/**
 * @beta Credential health. `null` while the credential is not active.
 *
 * - `ok`: usable.
 * - `degraded`: ZooWork's refresh is backing off; `retry_after` says until when.
 * - `expired`: an application-refreshed or static credential is past its expiry. Rotate it.
 * - `reauthorization_required`: ZooWork's refresh is blocked (`reason`). Ask the user to
 *   re-authorize, then submit new material with `updateVaultCredential`.
 *
 * Read it through {@link vaultCredentialHealthState}: a state this SDK does not know reads as
 * `unknown`, which is never healthy.
 */
export interface VaultCredentialHealth {
  state: VaultCredentialHealthState | string
  reason: 'authorization_required' | 'outcome_unknown' | 'unknown' | string | null
  retry_after: string | null
  [k: string]: unknown
}

/** @beta A credential. Never carries its secret. */
export interface VaultCredentialRecord {
  id: string
  vault_id: string
  name: string
  purpose: 'mcp' | string
  auth_type: 'static_bearer' | 'static_headers' | 'mcp_oauth' | string
  mcp_server_url: string
  provider_account_ref: string
  refresh_owner: 'external' | 'engine' | string | null
  expires_at: string | null
  status: VaultResourceStatus
  /** Send it back as `revision` on update, archive and delete. */
  revision: number
  secret_version: number
  purge_state: VaultPurgeState
  /** May be absent on an older deployment; absent reads like `null`. */
  health?: VaultCredentialHealth | null
  [k: string]: unknown
}

/** @beta One page of credentials. */
export interface VaultCredentialPage {
  data: VaultCredentialRecord[]
  next_cursor: string | null
  has_more: boolean
  [k: string]: unknown
}

/** @beta Result of a credential probe. Never a provider body or URL. */
export interface VaultCredentialValidation {
  status: 'valid' | 'invalid' | 'unknown' | string
  stage: 'resolve' | 'connect' | 'initialize' | 'refresh' | string
  http_status: number | null
  error_code: string | null
  retryable: boolean
  validated_at: string
  request_id: string
  [k: string]: unknown
}

/** @beta One MCP server bound to one credential. */
export interface VaultBindingCredential {
  server_name: string
  vault_id: string
  credential_id: string
  [k: string]: unknown
}

/**
 * @beta A Session's Vault binding, as Session creation (`vault_binding`) and revoke return it.
 * Store `revision` with the Session: revoke and offboarding send it back.
 */
export interface VaultBinding {
  id: string
  root_binding_id: string
  parent_binding_id: string | null
  project_id: string | null
  source: 'session' | 'schedule' | string
  session_id: string | null
  schedule_id: string | null
  status: 'unrevoked' | 'revoked' | string
  revision: number
  expires_at: string | null
  credential_bindings: VaultBindingCredential[]
  /** Tool scope fixed at creation: `restricted`, `session_isolated` or `shared`. */
  profile: 'restricted' | 'session_isolated' | 'shared' | string
  external_user_ref: string | null
  [k: string]: unknown
}

/** @beta A Session's isolation mode, fixed at creation. */
export type SessionIsolation = 'shared' | 'session'

/** @beta Names the credential for one Vault MCP server when several match. */
export interface SessionCredentialSelection {
  server_name: string
  credential_id: string
}

/** @beta Binding options. Both flags must stay `false` for now (400 `vault.unsupported_binding_option`). */
export interface SessionVaultBindingOptions {
  expires_at?: string | null
  allow_delegate?: false
  allow_unattended?: false
}

/**
 * @beta The Vault fields of `createSession`. Any of them makes the request a Vault request, so
 * omit the ones you do not use; never send `null` or `[]`. With them, `createSession` requires an
 * `idempotencyKey`.
 */
export interface SessionVaultFields {
  /**
   * Required with Vaults. An Agent that serves several end users must use `session`; `shared`
   * (one workspace and Agent Memory across the Agent's Sessions) is only for a single-user Agent.
   * Which tools a credentialed Session may use depends on what the deployment has enabled; do not
   * assume full tool access.
   */
  isolation: SessionIsolation
  /** 1–8 unique Vault IDs visible to the Agent's org and project. */
  vault_ids: [string, ...string[]]
  /** Up to 16, one per `server_name`. Needed when several credentials match one server
   * (409 `vault.credential_ambiguous`); none matching is 409 `vault.credential_missing`. */
  credential_bindings?: SessionCredentialSelection[]
  /** Your label for the Session (≤256 characters, immutable). A label only: it grants nothing. */
  external_user_ref?: string
  vault_binding_options?: SessionVaultBindingOptions
}

/** @beta One Session for the offboarding ledger. */
export interface VaultOffboardingSessionInput {
  agent_id: string
  session_id: string
  /** The `vault_binding.revision` Session creation returned. Omitted: 1. */
  revision?: number
}

/**
 * @beta The Sessions of a leaving user, as YOUR application records them: ZooWork does not model end
 * users, so it cannot find them for you.
 */
export interface VaultOffboardingInput {
  /** 1–100 Sessions. */
  sessions: VaultOffboardingSessionInput[]
  /** Your label for the user. It grants nothing. */
  external_user_ref?: string
}

/** @beta Per-Session state. `not_found` is NOT a revocation. */
export type VaultOffboardingSessionState = 'pending' | 'revoked' | 'not_found' | 'failed' | string

/** @beta One revoke attempt. */
export interface VaultOffboardingAttempt {
  attempt: number
  at: string
  result: 'revoked' | 'not_found' | 'retry' | 'failed' | string
  code: string | null
  [k: string]: unknown
}

/** @beta One Session of the ledger. */
export interface VaultOffboardingSession {
  agent_id: string
  session_id: string
  revision: number
  state: VaultOffboardingSessionState
  attempts: number
  last_code: string | null
  next_attempt_at: string | null
  vault_ids: string[]
  revoked_revision: number | null
  attempt_log: VaultOffboardingAttempt[]
  [k: string]: unknown
}

/**
 * @beta The offboarding ledger. `completed` means every Session was revoked; `incomplete` means at
 * least one ended `not_found` or `failed`. Poll while `in_progress`.
 */
export interface VaultOffboarding {
  id: string
  status: 'in_progress' | 'completed' | 'incomplete' | string
  external_user_ref: string | null
  actor_ref: string
  correlation_id: string
  created_at: string
  updated_at: string
  completed_at: string | null
  counts: Record<'pending' | 'revoked' | 'not_found' | 'failed', number> & Record<string, number>
  sessions: VaultOffboardingSession[]
  [k: string]: unknown
}

/**
 * @beta Vault methods of the client. See the module notes above for the shared rules (idempotency,
 * revisions, scopes, delete retries).
 *
 * Beta: needs Vault enabled for your ZooWork account or environment. Until then each method rejects
 * with a {@link VaultBetaUnavailableError} (server code 404 `service_api.not_found`, kept in `type`).
 * Behaviour and fields may change before general availability.
 */
export interface VaultApi {
  /** @beta Create an org or project Vault (201). Needs Vault enabled; see {@link VaultApi}. */
  createVault(input: VaultCreateInput, opts: VaultWriteOptions): Promise<VaultRecord>
  /** @beta List the Vaults of your key's scope. Needs Vault enabled; see {@link VaultApi}. */
  listVaults(opts?: VaultListOptions): Promise<VaultPage>
  /** @beta Read one Vault. Needs Vault enabled; see {@link VaultApi}. */
  getVault(vaultId: string): Promise<VaultRecord>
  /** @beta Rename a Vault or replace its metadata. Needs Vault enabled; see {@link VaultApi}. */
  updateVault(vaultId: string, input: VaultUpdateInput, opts: VaultRevisionWriteOptions): Promise<VaultRecord>
  /**
   * @beta Archive a Vault. Every Session using it is refused at its next call, so archiving a user's
   * dedicated Vault is one way to offboard that user. Needs Vault enabled; see {@link VaultApi}.
   */
  archiveVault(vaultId: string, opts: VaultRevisionWriteOptions): Promise<VaultRecord>
  /** @beta Delete a Vault (204). A retry answering 404 means it is already gone. Needs Vault enabled; see {@link VaultApi}. */
  deleteVault(vaultId: string, opts: VaultRevisionWriteOptions): Promise<void>
  /** @beta Store a credential (201). Needs Vault enabled; see {@link VaultApi}. */
  createVaultCredential(vaultId: string, input: VaultCredentialCreateInput, opts: VaultWriteOptions): Promise<VaultCredentialRecord>
  /** @beta List a Vault's credentials. Needs Vault enabled; see {@link VaultApi}. */
  listVaultCredentials(vaultId: string, opts?: VaultCredentialListOptions): Promise<VaultCredentialPage>
  /** @beta Read one credential, including its `health`. Needs Vault enabled; see {@link VaultApi}. */
  getVaultCredential(vaultId: string, credentialId: string): Promise<VaultCredentialRecord>
  /** @beta Rename a credential or rotate its secret. Needs Vault enabled; see {@link VaultApi}. */
  updateVaultCredential(
    vaultId: string,
    credentialId: string,
    input: VaultCredentialUpdateInput,
    opts: VaultRevisionWriteOptions,
  ): Promise<VaultCredentialRecord>
  /** @beta Archive a credential; Sessions using it are refused at their next call. Needs Vault enabled; see {@link VaultApi}. */
  archiveVaultCredential(vaultId: string, credentialId: string, opts: VaultRevisionWriteOptions): Promise<VaultCredentialRecord>
  /** @beta Delete a credential (204). A retry answering 404 means it is already gone. Needs Vault enabled; see {@link VaultApi}. */
  deleteVaultCredential(vaultId: string, credentialId: string, opts: VaultRevisionWriteOptions): Promise<void>
  /**
   * @beta Probe a credential against its MCP server. Sends no `Idempotency-Key` and no `If-Match`:
   * the probe stores nothing. Needs Vault enabled; see {@link VaultApi}.
   */
  validateVaultCredential(vaultId: string, credentialId: string): Promise<VaultCredentialValidation>
  /**
   * @beta Revoke one Session's Vault binding. `revision` is the `vault_binding.revision` from Session
   * creation. Afterwards a write that drives the Session is 409 (`vault_binding_revoked`; see
   * {@link vaultSessionErrorCode}). A 404 `service_api.not_found` here means either the Agent or
   * Session is not found for your key, or Vault is not enabled; it is not a
   * {@link VaultBetaUnavailableError}. Needs Vault enabled; see {@link VaultApi}.
   */
  revokeSessionVaultBinding(agentId: string, sessionId: string, opts: VaultRevisionWriteOptions): Promise<VaultBinding>
  /**
   * @beta Revoke a leaving user's Sessions one by one, durably (202). Returns at once; the service
   * keeps retrying. Poll {@link VaultApi.getVaultOffboarding} until `status` is not `in_progress`,
   * and treat a Session in `not_found` as NOT revoked. Use one `idempotencyKey` per offboarding.
   * Needs Vault enabled; see {@link VaultApi}.
   */
  createVaultOffboarding(input: VaultOffboardingInput, opts: VaultWriteOptions): Promise<VaultOffboarding>
  /** @beta Read an offboarding ledger. Needs Vault enabled; see {@link VaultApi}. */
  getVaultOffboarding(offboardingId: string): Promise<VaultOffboarding>
}

type Request = <T>(
  path: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> },
) => Promise<T>

/** How a Vault call's failure reaches the caller; supplied by the client (see `vaultFailure`). */
export type VaultFailure = (error: unknown, route: 'management' | 'revoke') => unknown

/** The client's own path and query builders, so both families encode the same way. */
export interface VaultPaths {
  query: (params: Record<string, string | number | undefined>) => string
  /** `/agents/{agentId}/sessions`, the agent ID encoded. */
  sessions: (agentId: string) => string
}

const segment = encodeURIComponent

/**
 * Exactly the two documented headers, read field by field. Nothing else on `opts` reaches the wire,
 * so an extra property (a forged context header, say) from an untyped caller is dropped.
 */
function writeHeaders(opts: Partial<VaultRevisionWriteOptions> | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  if (opts?.idempotencyKey !== undefined) headers['Idempotency-Key'] = opts.idempotencyKey
  if (opts?.revision !== undefined) headers['If-Match'] = String(opts.revision)
  return headers
}

/** Uses the client's authentication and error transport. Never retries. */
export function createVaultApi(json: Request, failure: VaultFailure, { query, sessions }: VaultPaths): VaultApi {
  const call = async <T>(
    route: 'management' | 'revoke',
    path: string,
    init?: { method?: string; body?: unknown; opts?: Partial<VaultRevisionWriteOptions> },
  ): Promise<T> => {
    try {
      return await json<T>(path, {
        ...(init?.method ? { method: init.method } : {}),
        ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        headers: writeHeaders(init?.opts),
      })
    } catch (error) {
      throw failure(error, route)
    }
  }
  const vault = (id: string): string => `/vaults/${segment(id)}`
  const credential = (id: string, cid: string): string => `${vault(id)}/credentials/${segment(cid)}`
  return {
    createVault: (input, opts) => call('management', '/vaults', { method: 'POST', body: input, opts: { idempotencyKey: opts?.idempotencyKey } }),
    listVaults: (opts = {}) =>
      call('management', `/vaults${query({ cursor: opts.cursor, limit: opts.limit, status: opts.status, scope: opts.scope })}`),
    getVault: (id) => call('management', vault(id)),
    updateVault: (id, input, opts) => call('management', `${vault(id)}/update`, { method: 'POST', body: input, opts }),
    archiveVault: (id, opts) => call('management', `${vault(id)}/archive`, { method: 'POST', opts }),
    deleteVault: async (id, opts) => {
      await call('management', `${vault(id)}/delete`, { method: 'POST', opts })
    },
    createVaultCredential: (id, input, opts) =>
      call('management', `${vault(id)}/credentials`, { method: 'POST', body: input, opts: { idempotencyKey: opts?.idempotencyKey } }),
    listVaultCredentials: (id, opts = {}) =>
      call('management', `${vault(id)}/credentials${query({ cursor: opts.cursor, limit: opts.limit, status: opts.status })}`),
    getVaultCredential: (id, cid) => call('management', credential(id, cid)),
    updateVaultCredential: (id, cid, input, opts) =>
      call('management', `${credential(id, cid)}/update`, { method: 'POST', body: input, opts }),
    archiveVaultCredential: (id, cid, opts) => call('management', `${credential(id, cid)}/archive`, { method: 'POST', opts }),
    deleteVaultCredential: async (id, cid, opts) => {
      await call('management', `${credential(id, cid)}/delete`, { method: 'POST', opts })
    },
    validateVaultCredential: (id, cid) => call('management', `${credential(id, cid)}/validate`, { method: 'POST' }),
    revokeSessionVaultBinding: (agentId, sessionId, opts) =>
      call('revoke', `${sessions(agentId)}/${segment(sessionId)}/vault-binding/revoke`, { method: 'POST', opts }),
    createVaultOffboarding: (input, opts) =>
      call('management', '/vault-offboardings', { method: 'POST', body: input, opts: { idempotencyKey: opts?.idempotencyKey } }),
    getVaultOffboarding: (id) => call('management', `/vault-offboardings/${segment(id)}`),
  }
}

/**
 * @beta Session errors caused by a Vault binding, under both spellings the service uses.
 *
 * TRANSITION: on Session sub-routes (post events, change configuration, …) the service currently
 * passes Engine's body through: `{ "error": { "type": "vault_binding_revoked", … } }`. A later
 * release maps it and answers both codes: `{ "code": "vault.binding_revoked", "detail": …,
 * "error": { "type": "vault_binding_revoked", … } }`, the dotted code at the top level and Engine's
 * code kept in `error.type` (and `vault_profile_restricted` always as 403). `ZooworkError.type`
 * reads `error.type` first, so on these routes it stays the bare Engine code in both phases.
 * Session creation answers the dotted code alone. Match through {@link vaultSessionErrorCode},
 * which reads the top-level dotted code when the body carries one and accepts either spelling
 * otherwise, rather than on `type`.
 */
export const VAULT_SESSION_ERROR_CODES = {
  vault_binding_revoked: 'vault.binding_revoked',
  vault_binding_expired: 'vault.binding_expired',
  vault_profile_restricted: 'vault.profile_restricted',
} as const

/** @beta The dotted form of a Vault binding error. */
export type VaultSessionErrorCode = (typeof VAULT_SESSION_ERROR_CODES)[keyof typeof VAULT_SESSION_ERROR_CODES]

const DOTTED_SESSION_CODES = new Set<string>(Object.values(VAULT_SESSION_ERROR_CODES))

/**
 * @beta The Vault binding error behind a failed Session call, normalized to the dotted spelling, or
 * `undefined` for any other failure. Accepts both the bare Engine code and the `vault.*` code.
 *
 * - `vault.binding_revoked` (409): the binding was revoked; the Session can no longer run.
 * - `vault.binding_expired` (409): the binding expired.
 * - `vault.profile_restricted` (403): this configuration cannot change on a Session with Vault
 *   credentials (model, `config_version`, `idle_compaction`).
 */
export function vaultSessionErrorCode(error: unknown): VaultSessionErrorCode | undefined {
  const fields = error as Partial<Pick<ZooworkError, 'type' | 'bodySnippet'>> | null | undefined
  const code = topLevelCode(fields?.bodySnippet)
  const candidate = code?.startsWith('vault.') ? code : fields?.type
  if (typeof candidate !== 'string') return undefined
  if (Object.hasOwn(VAULT_SESSION_ERROR_CODES, candidate)) {
    return VAULT_SESSION_ERROR_CODES[candidate as keyof typeof VAULT_SESSION_ERROR_CODES]
  }
  return DOTTED_SESSION_CODES.has(candidate) ? (candidate as VaultSessionErrorCode) : undefined
}

/** The top-level `code` of a JSON error body, when the body is intact and has one. */
function topLevelCode(body: string | undefined): string | undefined {
  if (body === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(body)
    const code = (parsed as { code?: unknown } | null)?.code
    return typeof code === 'string' ? code : undefined
  } catch {
    return undefined
  }
}

const KNOWN_HEALTH_STATES = new Set<string>(['ok', 'degraded', 'expired', 'reauthorization_required'])

/**
 * @beta A credential's health state, or `null` when it reports none (the credential is not active, or
 * the deployment predates health). A state this SDK does not know reads as `unknown`. Only `ok` is
 * healthy.
 */
export function vaultCredentialHealthState(
  credential: Pick<VaultCredentialRecord, 'health'>,
): VaultCredentialHealthState | null {
  const health = credential.health
  if (health === undefined || health === null) return null
  return KNOWN_HEALTH_STATES.has(health.state) ? (health.state as VaultCredentialHealthState) : 'unknown'
}
