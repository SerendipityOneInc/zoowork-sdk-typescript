// Offline orchestration/negative-control tests. These are not live deployment evidence.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as sdk from '../src/index.js'
import { vaultAcceptance, type VaultFixture } from './vault-smoke.ts'
import type { FixtureObservation } from './vault-observation.ts'
import { fixtureConfig } from './vault.ts'

const fixture: VaultFixture = { runId: 'a'.repeat(32), projectId: 'proj_test', agentId: 'agt_test', foreignProjectAgentId: 'agt_project', foreignOrgAgentId: 'agt_org',
  mcpServerUrl: 'https://fixture.example.invalid/mcp', accounts: {
    a: { id: 'a', marker: 'AMarkerRandom123456', fingerprint: 'hmac:' + 'a'.repeat(16) },
    b: { id: 'b', marker: 'BMarkerRandom123456', fingerprint: 'hmac:' + 'b'.repeat(16) },
  } }
const fail = (kind: string) => new Error(kind)
type Fault = 'cross_binding' | 'cross_identity' | 'wrong_fingerprint' | 'truncated_fixture' | 'foreign_read'
  | 'revoked_unauthorized_provider' | 'secret_id' | 'beta_disabled_cleanup' | 'session_route_missing_cleanup' | 'same_scope' | 'delete_noop' | 'revoke_accepted' | 'missing_audit' | 'cleanup_failure' | 'lost_create' | 'secret_echo' | 'stale_answer' | 'save_failure'
function setup(fault?: Fault) {
  const calls: string[] = []
  let cleanupDiscoveryFinished = false
  const vaults = new Map<string, sdk.VaultRecord>()
  const sessions = new Map<string, sdk.SessionRecord>()
  const revoked = new Set<string>()
  const observation: FixtureObservation = { runId: fixture.runId, pendingErrors: 0, droppedForBudget: 0,
    unauthorized: [], unauthorizedComplete: true, droppedUnattributed: 0,
    accounts: { a: { complete: true, requests: [] }, b: { complete: true, requests: [] } }, drafts: { a: [], b: [] } }
  const tokens = { a: 'TokenA'.repeat(8), b: 'TokenB'.repeat(8) }
  const client = {
    getAgent: async () => ({ declared: { name: `sdk-vault-${fixture.runId}`, labels: { sdk_vault_e2e: fixture.runId } }, ownership: { project_id: fixture.projectId, org_id: 'org_main' } }),
    listVaults: async () => { if (calls.includes('cleanup')) cleanupDiscoveryFinished = true; return { data: [...vaults.values()], has_more: false, next_cursor: null } },
    createVault: async (input: sdk.VaultCreateInput) => {
      const id = fault === 'secret_id' ? tokens.a : `vlt_${vaults.size}`
      const value = { ...input, id, revision: 1, project_id: fixture.projectId } as sdk.VaultRecord
      vaults.set(id, value); return value
    },
    getVault: async (id: string) => { if (fault === 'beta_disabled_cleanup' && cleanupDiscoveryFinished) throw new sdk.VaultBetaUnavailableError(new sdk.ZooworkError(404, '', 'service_api.not_found')); if (!vaults.has(id)) throw new sdk.ZooworkError(404, '', 'vault.not_found'); return vaults.get(id) },
    createVaultCredential: async (id: string) => ({ id: `cred_${id}`, ...(fault === 'secret_echo' ? { token: tokens.a } : {}) }),
    createSession: async (_agent: string, input: NonNullable<Parameters<sdk.ZooworkClient['createSession']>[1]>) => {
      if (fault === 'lost_create') throw fail('connection-lost')
      const id = `ses_${sessions.size}`
      const vid = input.vault_ids![0]!
      const value = { session_id: id, metadata: input.metadata, isolation: 'session', vault_ids: [vid],
        vault_binding: { status: 'unrevoked', revision: 1, credential_bindings: [{ vault_id: vid,
          credential_id: fault === 'cross_binding' ? 'other' : `cred_${vid}` }] },
      } as unknown as sdk.SessionRecord
      sessions.set(id, value); return value
    },
    listSessionPage: async () => ({ sessions: [...sessions.values()], next_cursor: null }),
    getSession: async (_agent: string, id: string) => { if (fault === 'session_route_missing_cleanup' && cleanupDiscoveryFinished) throw new sdk.ZooworkError(404, '', 'service_api.not_found'); if (!sessions.has(id)) throw new sdk.ZooworkError(404, '', 'not_found'); return sessions.get(id) },
    postEvents: async (_agent: string, id: string, events: sdk.OutboundEvent[]) => {
      if (revoked.has(id) && fault === 'revoked_unauthorized_provider') observation.unauthorized.push({ method: 'tools/call' })
      if (revoked.has(id) && fault !== 'revoke_accepted') throw new sdk.ZooworkError(409, '', 'vault_binding_revoked')
      if (revoked.has(id)) return { events: [{ accepted: true }] }
      const value = sessions.get(id)!
      const user = value.metadata!.user as 'a' | 'b'
      const actual = fault === 'cross_identity' ? (user === 'a' ? 'b' : 'a') : user
      const account = fixture.accounts[actual]
      const title = String(events[0]!.content).match(/titled "([^"]+)"/)![1]!
      observation.accounts[actual]!.requests.push(...['whoami', 'create_draft'].map(tool => ({ method: 'tools/call', tool,
        outcome: 'ok', credentialHeaders: { authorization: `Bearer ${fault === 'wrong_fingerprint' ? 'wrong' : account.fingerprint}` } })))
      observation.drafts[actual]!.push({ title, body: account.marker })
      value.run_status = 'succeeded'
      value.history = [{ seq: 1, entry_type: 'message', entry: { type: 'message', message: { role: 'assistant', content: `${fault === 'stale_answer' ? 'old' : title} ${account.marker}` } } }] as sdk.SessionRecord['history']
      return { events: [{ accepted: true }] }
    },
    revokeSessionVaultBinding: async (_agent: string, id: string) => { revoked.add(id); return { status: 'revoked', revision: 2 } },
    createVaultOffboarding: async (input: sdk.VaultOffboardingInput) => {
      for (const row of input.sessions) revoked.add(row.session_id)
      return { id: 'offboard_this_run', status: 'completed', actor_ref: 'key:test', correlation_id: 'corr',
        counts: { revoked: 2, pending: 0, failed: 0, not_found: 0 }, sessions: input.sessions.map(row => ({ ...row,
          state: 'revoked', attempts: 1, attempt_log: fault === 'missing_audit' ? [] : [{ result: 'revoked' }] })) }
    },
    deleteSession: async (_agent: string, id: string) => { calls.push(`delete:${id}`); if (fault !== 'delete_noop') sessions.delete(id) },
    deleteVault: async (id: string) => {
      calls.push(`delete:${id}`)
      if (fault === 'cleanup_failure' && id === 'vlt_0') throw fail('secret-untrusted-error')
      vaults.delete(id)
    },
  } as unknown as sdk.ZooworkClient
  const foreign = { listVaults: client.listVaults,
    getAgent: async (id: string) => ({ ownership: { project_id: fault === 'same_scope' ? fixture.projectId : 'proj_other',
      org_id: id === fixture.foreignProjectAgentId ? 'org_main' : 'org_other' } }),
    getVault: async () => { if (fault === 'foreign_read') return {}; throw new sdk.ZooworkError(404, '', 'vault.not_found') },
    getSession: async () => { throw new sdk.ZooworkError(404, '', 'service_api.agent_not_found') },
  } as unknown as sdk.ZooworkClient
  const run = () => vaultAcceptance(sdk, client, { fixture, tokens, foreignProject: foreign, foreignOrg: foreign,
    signal: new AbortController().signal, attempts: 2, delay: async () => {}, cleanupMode: () => { calls.push('cleanup') },
    save: () => { if (fault === 'save_failure') throw fail('disk') },
    observe: async () => structuredClone({ ...observation, droppedForBudget: fault === 'truncated_fixture' ? 1 : 0 }),
  })
  return { run, calls, client }
}

test('full public compatibility path proves identity, scope, revoke, offboarding and surviving user, then cleans up', async () => {
  const { run, calls } = setup(); const result = await run()
  assert.equal(result.passed, true, JSON.stringify(result))
  assert.deepEqual(result.checks, ['preflight', 'bindings_use_own_credentials', 'foreign_project_and_org_reads_denied',
    'a_identity', 'b_identity', 'revoke_refuses_drive', 'offboarding_completes', 'b_survives_a_offboarding'])
  assert.equal(result.cleanup.complete, true)
  assert.deepEqual(result.resources.retained_offboardings, ['offboard_this_run'])
  assert.deepEqual(calls, ['cleanup', 'delete:ses_0', 'delete:ses_1', 'delete:ses_2', 'delete:vlt_0', 'delete:vlt_1'])
})
for (const fault of ['cross_binding', 'cross_identity', 'wrong_fingerprint', 'truncated_fixture', 'foreign_read',
  'revoked_unauthorized_provider', 'secret_id', 'same_scope', 'revoke_accepted', 'missing_audit', 'secret_echo', 'stale_answer', 'save_failure'] as Fault[]) {
  test(`${fault} cannot produce a passing acceptance`, async () => {
    const result = await setup(fault).run(); assert.equal(result.passed, false)
    assert.ok(result.failure)
    assert.ok(!JSON.stringify(result).includes('TokenA'))
  })
}
test('one failed Vault cleanup does not prevent cleaning the other; reports only safe errors', async () => {
  const { run, calls } = setup('cleanup_failure'); const result = await run()
  assert.equal(result.passed, false); assert.equal(result.cleanup.complete, false)
  assert.ok(calls.includes('delete:vlt_1'))
  assert.ok(!JSON.stringify(result).includes('secret-untrusted-error'))
})
test('a missing create response never pretends cleanup is complete when discovery cannot settle it', async () => {
  const result = await setup('lost_create').run()
  assert.equal(result.resources.uncertain, true); assert.equal(result.cleanup.complete, false)
  assert.deepEqual(result.resources.intended_sessions, ['session-a'])
})
test('fixture config rejects shared identities, foreign MCP origin and incomplete deployment provenance', () => {
  const config = { ...fixture, origin: 'https://fixture.example.invalid/', facadeCommit: 'f'.repeat(40), engineCommit: 'e'.repeat(40) }
  assert.equal(fixtureConfig(config).runId, fixture.runId)
  assert.throws(() => fixtureConfig({ ...config, mcpServerUrl: 'https://foreign.example.invalid/mcp' }))
  assert.throws(() => fixtureConfig({ ...config, accounts: { a: fixture.accounts.a, b: fixture.accounts.a } }))
  assert.throws(() => fixtureConfig({ ...config, engineCommit: '' }))
})

test('successful delete responses without deletion cannot pass cleanup', async () => {
  const result = await setup('delete_noop').run(); assert.equal(result.passed, false); assert.equal(result.cleanup.complete, false)
})

for (const fault of ['beta_disabled_cleanup', 'session_route_missing_cleanup'] as Fault[]) {
  test(`${fault} after discovery cannot pretend cleanup completed`, async () => {
    const result = await setup(fault).run(); assert.equal(result.passed, false); assert.equal(result.cleanup.complete, false)
  })
}
