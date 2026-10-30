// Synthetic control-flow cases for the Vault smoke skeleton. No network; not recorded responses.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as sdk from '../src/index.js'
import { vaultSmoke } from './vault-smoke.ts'
import type { VaultSmokeFixture } from './vault-smoke.ts'

const fixture: VaultSmokeFixture = {
  projectId: 'proj_synthetic', agentId: 'agt_SYNTHETIC', mcpServerUrl: 'https://mcp.example.invalid', tokens: { a: 'ta', b: 'tb' },
}

/** A stub client. `crossBind` makes user b's Session bind user a's credential. */
function setup(opts: { crossBind?: boolean; failVaultDelete?: string } = {}) {
  const calls: string[] = []
  let n = 0
  const vaults: string[] = []
  const credentials: string[] = []
  const client = {
    listVaults: async () => ({ data: [], next_cursor: null, has_more: false }),
    createVault: async () => { const id = `vlt_${++n}`; vaults.push(id); calls.push(`create_vault ${id}`); return { id, revision: 1 } },
    createVaultCredential: async (vaultId: string) => { const id = `vcr_${vaultId}`; credentials.push(id); return { id } },
    createSession: async (_agent: string, input: { vault_ids: string[] }) => {
      const index = vaults.indexOf(input.vault_ids[0]!)
      const bound = opts.crossBind && index === 1 ? 0 : index
      const sessionId = `ses_${index}`
      calls.push(`create_session ${sessionId}`)
      return {
        session_id: sessionId, vault_ids: input.vault_ids,
        vault_binding: { status: 'unrevoked', revision: 1, credential_bindings: [{ server_name: 'fx', vault_id: vaults[bound], credential_id: credentials[bound] }] },
      }
    },
    revokeSessionVaultBinding: async (_a: string, sessionId: string) => { calls.push(`revoke ${sessionId}`); return {} },
    deleteSession: async (_a: string, sessionId: string) => { calls.push(`delete_session ${sessionId}`) },
    getVault: async (id: string) => ({ id, revision: 2 }),
    deleteVault: async (id: string) => {
      calls.push(`delete_vault ${id}`)
      if (id === opts.failVaultDelete) throw new sdk.ZooworkError(503, 'x', 'vault.unavailable')
    },
  } as unknown as sdk.ZooworkClient
  return { client, calls }
}

const status = (steps: { id: string; status: string }[], id: string) => steps.find((s) => s.id === id)?.status

test('without a fixture every step is not_covered, never passed', async () => {
  const { client } = setup()
  const steps = await vaultSmoke(sdk, client, { runId: 'r' })
  assert.deepEqual(steps.filter((s) => s.status === 'passed').map((s) => s.id), ['vault_list'])
})

test('upstream isolation is not_covered: creating resources is not an assertion', async () => {
  const { client } = setup()
  const steps = await vaultSmoke(sdk, client, { runId: 'r', fixture })
  assert.equal(status(steps, 'two_users_setup'), 'passed')
  assert.equal(status(steps, 'binding_uses_own_credential'), 'passed')
  assert.equal(status(steps, 'upstream_identity_isolated'), 'not_covered')
  assert.equal(steps.some((s) => s.id === 'two_users_isolated'), false)
})

test('a Session bound to another user\'s credential fails the binding assertion', async () => {
  const { client } = setup({ crossBind: true })
  const steps = await vaultSmoke(sdk, client, { runId: 'r', fixture })
  assert.equal(status(steps, 'binding_uses_own_credential'), 'failed')
})

test('cleanup revokes and deletes every Session, and one failed Vault delete does not skip the next', async () => {
  const { client, calls } = setup({ failVaultDelete: 'vlt_1' })
  const steps = await vaultSmoke(sdk, client, { runId: 'r', fixture })
  for (const call of ['revoke ses_0', 'delete_session ses_0', 'revoke ses_1', 'delete_session ses_1', 'delete_vault vlt_1', 'delete_vault vlt_2']) {
    assert.ok(calls.includes(call), call)
  }
  assert.equal(status(steps, 'cleanup_vault_a'), 'failed')
  assert.equal(status(steps, 'cleanup_vault_b'), 'passed')
})
