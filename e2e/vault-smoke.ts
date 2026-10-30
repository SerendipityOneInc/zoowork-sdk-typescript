// SKELETON, NOT WIRED IN: no command runs this file, and `pnpm test:e2e` does not call it.
//
// The beta Vault live check for the façade on staging (ecap-workspace Vault public API spec,
// "Acceptance and smoke evidence"). It needs things the standard smoke does not have: Vault
// enabled for the test organization, a project key, an Agent in that project whose MCP server is a
// fixture that records the injected identity, and a second fixture token. Until those exist and a
// maintainer wires it into `runner.ts` with the same guards as `smoke.ts` (pinned origin, bounded
// requests, private records, cleanup reserve), every step that needs them reports `not_covered`.
// A step passes only on an assertion it actually made; creating resources is not one.
import type * as SDK from '@zoowork-ai/sdk'

type PublicSDK = typeof SDK
export type VaultStepStatus = 'passed' | 'failed' | 'not_covered'
export interface VaultStep { id: string; status: VaultStepStatus; code?: string }

export interface VaultSmokeFixture {
  projectId: string
  agentId: string
  mcpServerUrl: string
  /** One fixture token per simulated end user. Never logged or saved. */
  tokens: { a: string; b: string }
}

const USERS = ['a', 'b'] as const
type User = (typeof USERS)[number]
interface UserResources { vaultId?: string; credentialId?: string; session?: SDK.SessionRecord }

/** Steps that need a fixture-side record of the identity each MCP call carried. */
const UPSTREAM_STEPS = ['upstream_identity_isolated', 'revoke_refuses_drive', 'offboarding_completes'] as const

export async function vaultSmoke(sdk: PublicSDK, client: SDK.ZooworkClient, options: {
  runId: string; fixture?: VaultSmokeFixture
}): Promise<VaultStep[]> {
  const steps: VaultStep[] = []
  const created: Record<User, UserResources> = { a: {}, b: {} }
  const key = (step: string) => `${options.runId}:${step}`
  const record = async (id: string, body: () => Promise<void>): Promise<boolean> => {
    try {
      await body()
      steps.push({ id, status: 'passed' })
      return true
    } catch (error) {
      const code = error instanceof sdk.ZooworkError ? error.type : undefined
      steps.push({ id, status: sdk.isVaultBetaUnavailable(error) ? 'not_covered' : 'failed', ...(code ? { code } : {}) })
      return false
    }
  }
  const assert = (condition: boolean, what: string): void => {
    if (!condition) throw new Error(`assertion failed: ${what}`)
  }

  // Reachability: a list either answers or says the beta is off for this organization.
  const reachable = await record('vault_list', async () => { await client.listVaults({ limit: 1 }) })
  const fixture = options.fixture
  if (!fixture || !reachable) {
    for (const id of ['two_users_setup', 'binding_uses_own_credential', ...UPSTREAM_STEPS, 'cleanup']) {
      steps.push({ id, status: 'not_covered' })
    }
    return steps
  }

  try {
    // Two users, one project Vault each, same MCP URL, one credentialed Session each.
    const ready = await record('two_users_setup', async () => {
      for (const user of USERS) {
        const own = created[user]
        const vault = await client.createVault(
          { scope: 'project', project_id: fixture.projectId, name: `sdk-e2e-${options.runId}-${user}` },
          { idempotencyKey: key(`vault-${user}`) },
        )
        own.vaultId = vault.id
        const credential = await client.createVaultCredential(vault.id, {
          name: 'fixture', purpose: 'mcp', provider_account_ref: `sdk-e2e-${user}`,
          auth: { type: 'static_bearer', mcp_server_url: fixture.mcpServerUrl, access_token: fixture.tokens[user] },
        }, { idempotencyKey: key(`credential-${user}`) })
        own.credentialId = credential.id
        own.session = await client.createSession(fixture.agentId, {
          isolation: 'session', vault_ids: [vault.id], external_user_ref: `sdk-e2e-${user}`,
        }, key(`session-${user}`))
      }
    })

    // Each Session's binding selects its own user's credential, and only that one.
    if (ready) {
      await record('binding_uses_own_credential', async () => {
        for (const user of USERS) {
          const own = created[user]
          const binding = own.session?.vault_binding
          assert(binding !== undefined && binding.status === 'unrevoked', `${user}: an unrevoked binding`)
          assert(binding!.credential_bindings.length > 0, `${user}: at least one bound credential`)
          for (const selection of binding!.credential_bindings) {
            assert(selection.vault_id === own.vaultId && selection.credential_id === own.credentialId,
              `${user}: every selection is the user's own Vault and credential`)
          }
          assert(own.session?.vault_ids?.length === 1 && own.session.vault_ids[0] === own.vaultId, `${user}: vault_ids`)
        }
      })
    } else {
      steps.push({ id: 'binding_uses_own_credential', status: 'not_covered' })
    }

    // Not asserted yet: what the fixture received on each MCP call. Reported, never passed.
    for (const id of UPSTREAM_STEPS) steps.push({ id, status: 'not_covered' })
  } finally {
    // Only what this run created, each item on its own: one failure must not leave the rest behind.
    // A 404 on a retried delete means it is already gone.
    const gone = (error: unknown) => error instanceof sdk.ZooworkError && error.status === 404
    const cleanup = async (id: string, action: () => Promise<unknown>): Promise<void> => {
      await record(id, async () => {
        try { await action() } catch (error) { if (!gone(error)) throw error }
      })
    }
    for (const user of USERS) {
      const { session, vaultId } = created[user]
      if (session) {
        await cleanup(`cleanup_revoke_${user}`, () => client.revokeSessionVaultBinding(fixture.agentId, session.session_id, {
          idempotencyKey: key(`revoke-${user}`), revision: session.vault_binding?.revision ?? 1,
        }))
        await cleanup(`cleanup_session_${user}`, () => client.deleteSession(fixture.agentId, session.session_id))
      }
      if (vaultId) {
        await cleanup(`cleanup_vault_${user}`, async () => {
          const current = await client.getVault(vaultId)
          await client.deleteVault(vaultId, { idempotencyKey: key(`delete-${user}`), revision: current.revision })
        })
      }
    }
  }
  return steps
}
