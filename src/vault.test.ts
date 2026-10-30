/**
 * Offline contract tests for the beta Vault surface: every request is asserted as the real
 * serialized HTTP call (method, path, the exact header set, body) against a stub `fetch`, so the
 * wire shape of the claw-interface Vault façade is pinned without a deployment.
 *
 * The façade contract these follow: ecap-workspace `services/claw-interface/app/routes/service_api/
 * _vaults.py`, `_vault_sessions.py`, `_vault_offboarding.py` and `app/services/vault/errors.py`.
 * Response bodies below are synthetic, shaped after `app/schema/vault_engine.py` and
 * `app/schema/vault_offboarding.py`; no live recording exists yet.
 */
import { expect, expectTypeOf, test } from 'vitest'
import {
  createZooworkClient,
  isVaultBetaUnavailable,
  vaultCredentialHealthState,
  vaultSessionErrorCode,
  VaultBetaUnavailableError,
  ZooworkError,
  type SessionRecord,
  type VaultRevisionWriteOptions,
  type ZooworkClient,
} from './index.js'

const BASE = 'https://api.test/service/v1'
const KEY = 'zwp_live_synthetic'

interface Recorded {
  method: string
  path: string
  headers: Record<string, string>
  body: string | undefined
}

function harness(reply: { status?: number; body?: unknown } = {}) {
  const calls: Recorded[] = []
  const client = createZooworkClient({
    apiKey: KEY,
    baseUrl: BASE,
    fetch: async (url, init = {}) => {
      calls.push({
        method: init.method ?? 'GET',
        path: url.slice(BASE.length),
        headers: { ...(init.headers as Record<string, string>) },
        body: init.body === undefined ? undefined : String(init.body),
      })
      const status = reply.status ?? 200
      const text = reply.body === undefined ? null : JSON.stringify(reply.body)
      return new Response(status === 204 ? null : text, { status })
    },
  })
  return { calls, client }
}

async function rejection(p: Promise<unknown>): Promise<ZooworkError> {
  try {
    await p
  } catch (e) {
    return e as ZooworkError
  }
  throw new Error('expected a rejection')
}

const AUTH = { Authorization: `Bearer ${KEY}` }
const JSON_BODY = { ...AUTH, 'Content-Type': 'application/json' }
const key = (k: string) => ({ 'Idempotency-Key': k })
const ifMatch = (r: string) => ({ 'If-Match': r })
const W: VaultRevisionWriteOptions = { idempotencyKey: 'op-1', revision: 3 }

const AUTH_STATIC = { type: 'static_bearer', mcp_server_url: 'https://mcp.example/a', access_token: 'secret-token' } as const

/** [label, call, method, path, exact headers, body or undefined]. */
const ROUTES: [string, (c: ZooworkClient) => Promise<unknown>, string, string, Record<string, string>, unknown][] = [
  ['createVault (org)', (c) => c.createVault({ scope: 'org', name: 'shared' }, { idempotencyKey: 'op-1' }), 'POST', '/vaults', { ...JSON_BODY, ...key('op-1') }, { scope: 'org', name: 'shared' }],
  ['createVault (project)', (c) => c.createVault({ scope: 'project', project_id: 'proj_x', name: 'user-a', metadata: { user: 'a' } }, { idempotencyKey: 'op-1' }), 'POST', '/vaults', { ...JSON_BODY, ...key('op-1') }, { scope: 'project', project_id: 'proj_x', name: 'user-a', metadata: { user: 'a' } }],
  ['listVaults', (c) => c.listVaults(), 'GET', '/vaults', AUTH, undefined],
  ['listVaults (filters)', (c) => c.listVaults({ cursor: 'c/1', limit: 5, status: 'archived', scope: 'project' }), 'GET', '/vaults?cursor=c%2F1&limit=5&status=archived&scope=project', AUTH, undefined],
  ['getVault', (c) => c.getVault('vlt 1'), 'GET', '/vaults/vlt%201', AUTH, undefined],
  ['updateVault', (c) => c.updateVault('vlt_1', { name: 'renamed' }, W), 'POST', '/vaults/vlt_1/update', { ...JSON_BODY, ...key('op-1'), ...ifMatch('3') }, { name: 'renamed' }],
  ['archiveVault', (c) => c.archiveVault('vlt_1', W), 'POST', '/vaults/vlt_1/archive', { ...AUTH, ...key('op-1'), ...ifMatch('3') }, undefined],
  ['deleteVault', (c) => c.deleteVault('vlt_1', W), 'POST', '/vaults/vlt_1/delete', { ...AUTH, ...key('op-1'), ...ifMatch('3') }, undefined],
  ['createVaultCredential', (c) => c.createVaultCredential('vlt_1', { name: 'gh', purpose: 'mcp', provider_account_ref: 'acct-1', auth: AUTH_STATIC }, { idempotencyKey: 'op-1' }), 'POST', '/vaults/vlt_1/credentials', { ...JSON_BODY, ...key('op-1') }, { name: 'gh', purpose: 'mcp', provider_account_ref: 'acct-1', auth: AUTH_STATIC }],
  ['listVaultCredentials', (c) => c.listVaultCredentials('vlt_1', { limit: 100, status: 'active' }), 'GET', '/vaults/vlt_1/credentials?limit=100&status=active', AUTH, undefined],
  ['getVaultCredential', (c) => c.getVaultCredential('vlt_1', 'vcr/1'), 'GET', '/vaults/vlt_1/credentials/vcr%2F1', AUTH, undefined],
  ['updateVaultCredential', (c) => c.updateVaultCredential('vlt_1', 'vcr_1', { auth: { access_token: 'new', expires_at: null } }, W), 'POST', '/vaults/vlt_1/credentials/vcr_1/update', { ...JSON_BODY, ...key('op-1'), ...ifMatch('3') }, { auth: { access_token: 'new', expires_at: null } }],
  ['archiveVaultCredential', (c) => c.archiveVaultCredential('vlt_1', 'vcr_1', W), 'POST', '/vaults/vlt_1/credentials/vcr_1/archive', { ...AUTH, ...key('op-1'), ...ifMatch('3') }, undefined],
  ['deleteVaultCredential', (c) => c.deleteVaultCredential('vlt_1', 'vcr_1', W), 'POST', '/vaults/vlt_1/credentials/vcr_1/delete', { ...AUTH, ...key('op-1'), ...ifMatch('3') }, undefined],
  // A bounded probe: no Idempotency-Key, no If-Match, no body.
  ['validateVaultCredential', (c) => c.validateVaultCredential('vlt_1', 'vcr_1'), 'POST', '/vaults/vlt_1/credentials/vcr_1/validate', AUTH, undefined],
  ['revokeSessionVaultBinding', (c) => c.revokeSessionVaultBinding('agt 1', 'ses_1', { idempotencyKey: 'rev-1', revision: 1 }), 'POST', '/agents/agt%201/sessions/ses_1/vault-binding/revoke', { ...AUTH, ...key('rev-1'), ...ifMatch('1') }, undefined],
  ['createVaultOffboarding', (c) => c.createVaultOffboarding({ sessions: [{ agent_id: 'agt_1', session_id: 'ses_1' }, { agent_id: 'agt_1', session_id: 'ses_2', revision: 2 }], external_user_ref: 'user-a' }, { idempotencyKey: 'off-1' }), 'POST', '/vault-offboardings', { ...JSON_BODY, ...key('off-1') }, { sessions: [{ agent_id: 'agt_1', session_id: 'ses_1' }, { agent_id: 'agt_1', session_id: 'ses_2', revision: 2 }], external_user_ref: 'user-a' }],
  ['getVaultOffboarding', (c) => c.getVaultOffboarding('vof_1'), 'GET', '/vault-offboardings/vof_1', AUTH, undefined],
]

test.each(ROUTES)('%s serializes to the façade route', async (_label, call, method, path, headers, body) => {
  const { calls, client } = harness({ body: { id: 'x' } })
  await call(client)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.method).toBe(method)
  expect(calls[0]!.path).toBe(path)
  // The exact header set: nothing beyond auth, content type and the two documented preconditions.
  expect(calls[0]!.headers).toEqual(headers)
  expect(calls[0]!.body === undefined ? undefined : JSON.parse(calls[0]!.body)).toEqual(body)
})

test('a create never sends If-Match, even when an untyped caller passes a revision', async () => {
  const { calls, client } = harness({ body: {} })
  const opts = { idempotencyKey: 'op-1', revision: 9 } as VaultRevisionWriteOptions
  await client.createVault({ scope: 'org', name: 'v' }, opts)
  await client.createVaultCredential('vlt_1', { name: 'n', purpose: 'mcp', provider_account_ref: 'r', auth: AUTH_STATIC }, opts)
  await client.createVaultOffboarding({ sessions: [{ agent_id: 'a', session_id: 's' }] }, opts)
  for (const call of calls) expect(call.headers).not.toHaveProperty('If-Match')
})

test('there is no way to set the internal Vault context header', async () => {
  const { calls, client } = harness({ body: {} })
  // An untyped caller smuggling headers through the options object.
  const forged = {
    idempotencyKey: 'op-1',
    revision: 1,
    headers: { 'X-Zooclaw-Vault-Context': '{"org_id":"other"}' },
    'X-Zooclaw-Vault-Context': '{"org_id":"other"}',
  } as unknown as VaultRevisionWriteOptions
  await client.updateVault('vlt_1', { name: 'n' }, forged)
  await client.revokeSessionVaultBinding('a', 's', forged)
  await client.createVaultOffboarding({ sessions: [{ agent_id: 'a', session_id: 's' }] }, forged)
  for (const call of calls) {
    expect(Object.keys(call.headers).map((h) => h.toLowerCase())).not.toContain('x-zooclaw-vault-context')
    expect(call.body ?? '').not.toContain('org_id')
  }
  // Nor at the type level: the options name exactly two headers.
  expectTypeOf<keyof VaultRevisionWriteOptions>().toEqualTypeOf<'idempotencyKey' | 'revision'>()
})

test('responses come back unchanged, unknown fields included; deletes resolve to undefined', async () => {
  const credential = { id: 'vcr_1', vault_id: 'vlt_1', revision: 2, health: { state: 'ok', reason: null, retry_after: null }, future_field: { nested: true } }
  const { client } = harness({ body: credential })
  expect(await client.getVaultCredential('vlt_1', 'vcr_1')).toEqual(credential)
  const { client: deleting } = harness({ status: 204 })
  expect(await deleting.deleteVault('vlt_1', W)).toBeUndefined()
  expect(await deleting.deleteVaultCredential('vlt_1', 'vcr_1', W)).toBeUndefined()
})

// ── createSession Vault fields ──

const RECEIPT = {
  session_id: 'ses_1',
  status: 'running',
  isolation: 'session',
  project_id: 'proj_x',
  vault_ids: ['vlt_1'],
  vault_binding: {
    id: 'vbd_1', root_binding_id: 'vbd_1', parent_binding_id: null, project_id: 'proj_x', source: 'session',
    session_id: 'ses_1', schedule_id: null, status: 'unrevoked', revision: 1, expires_at: null,
    credential_bindings: [{ server_name: 'github', vault_id: 'vlt_1', credential_id: 'vcr_1' }],
    profile: 'restricted', external_user_ref: 'user-a',
  },
}

test('createSession sends the Vault fields as given, with the Idempotency-Key, and returns the binding', async () => {
  const { calls, client } = harness({ status: 201, body: RECEIPT })
  const session: SessionRecord = await client.createSession('agt_1', {
    isolation: 'session',
    vault_ids: ['vlt_1'],
    credential_bindings: [{ server_name: 'github', credential_id: 'vcr_1' }],
    external_user_ref: 'user-a',
    vault_binding_options: { expires_at: null },
    initial_events: [{ type: 'user.message', content: 'hi' }],
  }, 'create-ses-1')
  expect(calls[0]!.method).toBe('POST')
  expect(calls[0]!.path).toBe('/agents/agt_1/sessions')
  expect(calls[0]!.headers).toEqual({ ...JSON_BODY, ...key('create-ses-1') })
  expect(JSON.parse(calls[0]!.body!)).toEqual({
    isolation: 'session',
    vault_ids: ['vlt_1'],
    credential_bindings: [{ server_name: 'github', credential_id: 'vcr_1' }],
    external_user_ref: 'user-a',
    vault_binding_options: { expires_at: null },
    initial_events: [{ type: 'user.message', content: 'hi' }],
  })
  expect(session.vault_binding?.revision).toBe(1)
  expect(session.vault_ids).toEqual(['vlt_1'])
})

test('a createSession without Vault fields carries none of their keys, not even as null', async () => {
  const { calls, client } = harness({ status: 201, body: { session_id: 's' } })
  await client.createSession('agt_1', { metadata: { k: 'v' } })
  // An undefined property is dropped by serialization, not sent as null.
  await client.createSession('agt_1', { metadata: { k: 'v' }, isolation: undefined })
  for (const call of calls) {
    const sent = Object.keys(JSON.parse(call.body!) as object)
    expect(sent).toEqual(['metadata'])
    expect(call.headers).not.toHaveProperty('Idempotency-Key')
  }
})

test('the Vault fields are only accepted together with isolation and an Idempotency-Key (types)', () => {
  const c = harness().client
  // Compiled, never called: `tsc --noEmit` (part of `pnpm test`) is the assertion.
  const typeOnly = (): void => {
    // @ts-expect-error vault_ids without isolation
    void c.createSession('a', { vault_ids: ['v'] }, 'k')
    // @ts-expect-error Vault fields without an idempotency key
    void c.createSession('a', { isolation: 'session', vault_ids: ['v'] })
    // @ts-expect-error an empty vault_ids is not "no Vault": omit it
    void c.createSession('a', { isolation: 'session', vault_ids: [] }, 'k')
    // @ts-expect-error null is not "no Vault": omit it
    void c.createSession('a', { isolation: 'session', vault_ids: ['v'], external_user_ref: null }, 'k')
    // @ts-expect-error credential_bindings without vault_ids
    void c.createSession('a', { credential_bindings: [{ server_name: 's', credential_id: 'c' }] }, 'k')
    // isolation alone is an ordinary Session field.
    void c.createSession('a', { isolation: 'shared' })
  }
  expect(typeof typeOnly).toBe('function')
})

// ── errors ──

const envelope = (code: string, detail: unknown = 'x') => ({ code, detail })

test.each([
  [409, 'vault.idempotency_conflict', false],
  [412, 'vault.revision_conflict', false],
  [403, 'vault.management_forbidden', false],
  [404, 'vault.not_found', false],
  [503, 'vault.unavailable', true],
  [429, 'vault.rate_limited', true],
])('a %i %s keeps its code verbatim and is not a beta error', async (status, code, retryable) => {
  const { client } = harness({ status, body: envelope(code) })
  const err = await rejection(client.updateVault('vlt_1', { name: 'n' }, W))
  expect(err).toBeInstanceOf(ZooworkError)
  expect(err).not.toBeInstanceOf(VaultBetaUnavailableError)
  expect(err.status).toBe(status)
  expect(err.type).toBe(code)
  expect(err.retryable).toBe(retryable)
  expect(isVaultBetaUnavailable(err)).toBe(false)
})

test('a structured validation detail stays in bodySnippet, the code in type', async () => {
  const detail = { message: 'The Vault request is invalid', errors: [{ loc: ['auth', '*'], msg: 'Invalid value (missing)', type: 'missing' }] }
  const { client } = harness({ status: 400, body: envelope('vault.invalid_request', detail) })
  const err = await rejection(client.createVault({ scope: 'org', name: 'v' }, { idempotencyKey: 'k' }))
  expect(err.type).toBe('vault.invalid_request')
  expect(JSON.parse(err.bodySnippet!)).toEqual({ code: 'vault.invalid_request', detail })
})

test('with Vault off, every Vault route rejects with VaultBetaUnavailableError carrying the server code', async () => {
  for (const [label, call] of ROUTES.filter(([label]) => !label.startsWith('revoke')).map(([l, c]) => [l, c] as const)) {
    const { client } = harness({ status: 404, body: envelope('service_api.not_found', 'Not found') })
    const err = await rejection(call(client))
    expect(err, label).toBeInstanceOf(VaultBetaUnavailableError)
    expect(err, label).toBeInstanceOf(ZooworkError)
    expect(err.status).toBe(404)
    expect(err.type).toBe('service_api.not_found')
    expect(err.message).toContain('Not found')
    expect(err.message).toContain('Vault beta is not enabled')
    expect(err.bodySnippet).toBe(JSON.stringify(envelope('service_api.not_found', 'Not found')))
    expect(isVaultBetaUnavailable(err)).toBe(true)
  }
})

test('with Vault off, createSession with Vault fields rejects with VaultBetaUnavailableError', async () => {
  const { client } = harness({ status: 400, body: envelope('vault.session_fields_unavailable', 'Vault fields are not available for this API key') })
  const err = await rejection(client.createSession('agt_1', { isolation: 'session', vault_ids: ['vlt_1'] }, 'k'))
  expect(err).toBeInstanceOf(VaultBetaUnavailableError)
  expect(err.status).toBe(400)
  expect(err.type).toBe('vault.session_fields_unavailable')
  expect(err.message).toContain('Vault beta is not enabled')
  expect(isVaultBetaUnavailable(err)).toBe(true)
  // The code alone is enough, however the error was built.
  expect(isVaultBetaUnavailable(new ZooworkError(400, 'x', 'vault.session_fields_unavailable'))).toBe(true)
})

test('createSession keeps every other failure as it was', async () => {
  const { client } = harness({ status: 404, body: envelope('service_api.not_found', 'Not found') })
  const err = await rejection(client.createSession('agt_1', {}))
  expect(err).not.toBeInstanceOf(VaultBetaUnavailableError)
  expect(err.message).toBe('Not found')
  expect(isVaultBetaUnavailable(err)).toBe(false)
})

test('revoke 404 service_api.not_found stays a plain ZooworkError: it can also mean an unknown Agent or Session', async () => {
  const { client } = harness({ status: 404, body: envelope('service_api.not_found', 'Not found') })
  const err = await rejection(client.revokeSessionVaultBinding('agt_1', 'ses_1', { idempotencyKey: 'k', revision: 1 }))
  expect(err).toBeInstanceOf(ZooworkError)
  expect(err).not.toBeInstanceOf(VaultBetaUnavailableError)
  expect(err.type).toBe('service_api.not_found')
  expect(err.message).toContain('Agent or Session was not found')
  expect(err.message).toContain('Vault beta is not enabled')
  expect(isVaultBetaUnavailable(err)).toBe(false)
})

test('vaultSessionErrorCode recognizes both the Engine and the vault.* spelling', () => {
  const cases: [string, string | undefined][] = [
    ['vault_binding_revoked', 'vault.binding_revoked'],
    ['vault.binding_revoked', 'vault.binding_revoked'],
    ['vault_binding_expired', 'vault.binding_expired'],
    ['vault.binding_expired', 'vault.binding_expired'],
    ['vault_profile_restricted', 'vault.profile_restricted'],
    ['vault.profile_restricted', 'vault.profile_restricted'],
    ['session_archived', undefined],
    ['vault.not_found', undefined],
    ['toString', undefined],
  ]
  for (const [type, expected] of cases) expect(vaultSessionErrorCode(new ZooworkError(409, 'x', type)), type).toBe(expected)
  expect(vaultSessionErrorCode(new Error('x'))).toBeUndefined()
  expect(vaultSessionErrorCode(undefined)).toBeUndefined()
})

test('a revoked binding surfaces through postEvents under either spelling', async () => {
  const answers: [unknown, string][] = [
    // Today: Engine's envelope, passed through.
    [{ error: { type: 'vault_binding_revoked', message: 'revoked' } }, 'vault_binding_revoked'],
    // After the façade maps it.
    [envelope('vault.binding_revoked'), 'vault.binding_revoked'],
  ]
  for (const [body, verbatim] of answers) {
    const { client } = harness({ status: 409, body })
    const err = await rejection(client.postEvents('agt_1', 'ses_1', [{ type: 'user.message', content: 'hi' }]))
    expect(err.type).toBe(verbatim)
    expect(vaultSessionErrorCode(err)).toBe('vault.binding_revoked')
  }
})

test('vaultCredentialHealthState: known states pass, anything else is unknown, no health is null', () => {
  for (const state of ['ok', 'degraded', 'expired', 'reauthorization_required']) {
    expect(vaultCredentialHealthState({ health: { state, reason: null, retry_after: null } })).toBe(state)
  }
  expect(vaultCredentialHealthState({ health: { state: 'quarantined', reason: null, retry_after: null } })).toBe('unknown')
  expect(vaultCredentialHealthState({ health: { state: 'unknown', reason: 'unknown', retry_after: null } })).toBe('unknown')
  expect(vaultCredentialHealthState({ health: null })).toBeNull()
  expect(vaultCredentialHealthState({})).toBeNull()
})
