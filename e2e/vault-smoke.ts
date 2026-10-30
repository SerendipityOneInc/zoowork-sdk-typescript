// SKELETON, NOT WIRED IN: no command runs this file, and `pnpm test:e2e` does not call it.
//
// The beta Vault live check for the façade on staging (ecap-workspace Vault public API spec,
// "Acceptance and smoke evidence"). It needs things the standard smoke does not have: Vault
// enabled for the test organization, a project key, an Agent in that project whose MCP server is a
// fixture that records the injected identity, and a second fixture token. Until those exist and a
// maintainer wires it into `runner.ts` with the same guards as `smoke.ts` (pinned origin, bounded
// requests, private records, cleanup reserve), every step that needs them reports NOT_COVERED.
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

export async function vaultSmoke(sdk: PublicSDK, client: SDK.ZooworkClient, options: {
  runId: string; fixture?: VaultSmokeFixture
}): Promise<VaultStep[]> {
  const steps: VaultStep[] = []
  const created: { vaults: { id: string }[] } = { vaults: [] }
  const key = (step: string) => `${options.runId}:${step}`
  const record = async (id: string, body: () => Promise<void>): Promise<void> => {
    try {
      await body()
      steps.push({ id, status: 'passed' })
    } catch (error) {
      const code = error instanceof sdk.ZooworkError ? error.type : undefined
      steps.push({ id, status: sdk.isVaultBetaUnavailable(error) ? 'not_covered' : 'failed', ...(code ? { code } : {}) })
    }
  }

  // Reachability: a list either answers or says the beta is off for this organization.
  await record('vault_list', async () => { await client.listVaults({ limit: 1 }) })
  const fixture = options.fixture
  if (!fixture || steps[0]?.status !== 'passed') {
    for (const id of ['two_users_isolated', 'revision_conflict', 'revoke_refuses_drive', 'offboarding_completes', 'cleanup']) {
      steps.push({ id, status: 'not_covered' })
    }
    return steps
  }

  try {
    // Two users, one project Vault each, same MCP URL. Assertion to add: each Session's tool call
    // reaches the fixture with that user's token only (checked on the fixture side, not here).
    await record('two_users_isolated', async () => {
      for (const user of ['a', 'b'] as const) {
        const vault = await client.createVault(
          { scope: 'project', project_id: fixture.projectId, name: `sdk-e2e-${options.runId}-${user}` },
          { idempotencyKey: key(`vault-${user}`) },
        )
        created.vaults.push(vault)
        await client.createVaultCredential(vault.id, {
          name: 'fixture', purpose: 'mcp', provider_account_ref: `sdk-e2e-${user}`,
          auth: { type: 'static_bearer', mcp_server_url: fixture.mcpServerUrl, access_token: fixture.tokens[user] },
        }, { idempotencyKey: key(`credential-${user}`) })
        await client.createSession(fixture.agentId, {
          isolation: 'session', vault_ids: [vault.id], external_user_ref: `sdk-e2e-${user}`,
        }, key(`session-${user}`))
      }
    })
    steps.push({ id: 'revision_conflict', status: 'not_covered' })
    steps.push({ id: 'revoke_refuses_drive', status: 'not_covered' })
    steps.push({ id: 'offboarding_completes', status: 'not_covered' })
  } finally {
    // Only the Vaults this run created; a cleanup failure fails the smoke.
    await record('cleanup', async () => {
      for (const vault of created.vaults) {
        const current = await client.getVault(vault.id)
        await client.deleteVault(vault.id, { idempotencyKey: key(`delete-${vault.id}`), revision: current.revision })
      }
    })
  }
  return steps
}
