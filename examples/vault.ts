/**
 * Vault (BETA): one project Vault per end user, a credentialed Session for that user, then
 * offboarding. Not a unit test: it creates a real Vault, credential and Session.
 *
 *   ZOOWORK_API_KEY=zwp_live_... AGENT_ID=agt_... PROJECT_ID=proj_... \
 *   MCP_SERVER_URL=https://... MCP_TOKEN=... pnpm exec tsx examples/vault.ts
 *
 * Beta: Vault needs to be enabled for your ZooWork account or environment. Until it is, the first
 * call fails with `VaultBetaUnavailableError` (404 `service_api.not_found`). Behaviour and fields
 * may change before general availability.
 *
 * The key must be a project key of PROJECT_ID, and AGENT_ID an Agent in that project whose
 * declared MCP server is MCP_SERVER_URL. Every write carries an idempotency key derived from the
 * run, so rerunning a failed step with the same RUN_ID replays instead of duplicating.
 */
import {
  createZooworkClient,
  isVaultBetaUnavailable,
  vaultCredentialHealthState,
  vaultSessionErrorCode,
  ZooworkError,
} from '../src/index.js'

const need = (n: string): string => {
  const v = process.env[n]
  if (!v) throw new Error(`missing env ${n}`)
  return v
}

const zc = createZooworkClient()
const agentId = need('AGENT_ID')
const run = process.env.RUN_ID ?? `vault-example-${Date.now()}`
const user = 'example-user-a' // your application's own user ID; ZooWork never interprets it

// What this run created, so `finally` removes exactly that, whatever step failed.
const created: { vaultId?: string; session?: { id: string; revision: number } } = {}

try {
  // 1. A Vault for this user, recorded in your own user → Vault mapping.
  const vault = await zc.createVault(
    { scope: 'project', project_id: need('PROJECT_ID'), name: `${run}-${user}`, metadata: { user } },
    { idempotencyKey: `${run}:vault` },
  )
  created.vaultId = vault.id
  const credential = await zc.createVaultCredential(vault.id, {
    name: 'mcp',
    purpose: 'mcp',
    provider_account_ref: user,
    auth: { type: 'static_bearer', mcp_server_url: need('MCP_SERVER_URL'), access_token: need('MCP_TOKEN') },
  }, { idempotencyKey: `${run}:credential` })
  console.log(`vault ${vault.id}, credential ${credential.id}, health ${vaultCredentialHealthState(credential)}`)

  // 2. A Session that uses only this user's Vault. `session` isolation: the Agent serves several users.
  const session = await zc.createSession(agentId, {
    isolation: 'session',
    vault_ids: [vault.id],
    external_user_ref: user,
  }, `${run}:session`)
  const revision = session.vault_binding?.revision ?? 1
  created.session = { id: session.session_id, revision }
  console.log(`session ${session.session_id}, binding revision ${revision}, profile ${session.vault_binding?.profile}`)

  // 3. The user leaves: revoke their Sessions through the durable ledger and wait for the result.
  const ledger = await zc.createVaultOffboarding(
    { sessions: [{ agent_id: agentId, session_id: session.session_id, revision }], external_user_ref: user },
    { idempotencyKey: `${run}:offboard` },
  )
  let current = ledger
  const deadline = Date.now() + 10 * 60_000
  while (current.status === 'in_progress' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 15_000))
    current = await zc.getVaultOffboarding(ledger.id)
  }
  // `not_found` is not a revocation; anything but `completed` needs a look.
  console.log(`offboarding ${current.status}`, current.sessions.map((s) => `${s.session_id}:${s.state}`))

  // A revoked Session refuses new work under either error spelling.
  try {
    await zc.postEvents(agentId, session.session_id, [{ type: 'user.message', content: 'still there?' }])
  } catch (error) {
    console.log(`after revoke: ${vaultSessionErrorCode(error) ?? (error as ZooworkError).type}`)
  }
  if (current.status !== 'completed') process.exitCode = 1
} catch (error) {
  if (isVaultBetaUnavailable(error)) {
    console.error('Vault beta is not enabled for this account or environment.')
  } else {
    console.error(error)
  }
  process.exitCode = 1
} finally {
  // 4. Clean up what this run created, each step on its own so one failure does not skip the rest.
  // Revoking an already revoked binding with the revision that revoked it is a no-op.
  const step = async (name: string, action: () => Promise<unknown>): Promise<void> => {
    try {
      await action()
    } catch (error) {
      // A 404 on a retried delete means it is already gone.
      if (!(error instanceof ZooworkError && error.status === 404)) {
        console.error(`cleanup ${name} failed:`, error)
        process.exitCode = 1
      }
    }
  }
  const { vaultId, session } = created
  if (session) {
    await step('revoke', () =>
      zc.revokeSessionVaultBinding(agentId, session.id, { idempotencyKey: `${run}:revoke`, revision: session.revision }))
    await step('session', () => zc.deleteSession(agentId, session.id))
  }
  if (vaultId) {
    // Delete needs the current revision.
    await step('vault', async () =>
      zc.deleteVault(vaultId, { idempotencyKey: `${run}:delete`, revision: (await zc.getVault(vaultId)).revision }))
  }
}
