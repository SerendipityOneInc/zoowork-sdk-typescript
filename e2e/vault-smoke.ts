import type * as SDK from '@zoowork-ai/sdk'
import { check, safeFailure } from './guard.ts'
import { assertIdentity, assertObservation, type FixtureAccount, type FixtureObservation } from './vault-observation.ts'

type Client = SDK.ZooworkClient
export interface VaultFixture {
  runId: string; projectId: string; agentId: string; mcpServerUrl: string
  foreignProjectAgentId: string; foreignOrgAgentId: string
  accounts: { a: FixtureAccount; b: FixtureAccount }
}
export interface VaultAcceptanceRecord {
  run_id: string; passed: boolean; checks: string[]; failure?: ReturnType<typeof safeFailure>
  resources: { vaults: string[]; sessions: string[]; retained_offboardings: string[]; intended_vaults: string[]; intended_sessions: string[]; uncertain: boolean }
  cleanup: { complete: boolean; failures: ReturnType<typeof safeFailure>[] }
}
interface Options {
  fixture: VaultFixture; tokens: { a: string; b: string }
  foreignProject: Client; foreignOrg: Client; observe: () => Promise<FixtureObservation>
  signal: AbortSignal; cleanupMode: () => void; save: (record: VaultAcceptanceRecord) => void
  delay?: () => Promise<void>; attempts?: number
}
const USERS = ['a', 'b'] as const
type User = typeof USERS[number]

/** Public SDK compatibility acceptance. The application, not Engine, maps A/B to their Vaults. */
export async function vaultAcceptance(sdk: typeof SDK, client: Client, options: Options): Promise<VaultAcceptanceRecord> {
  const f = options.fixture
  const record: VaultAcceptanceRecord = { run_id: f.runId, passed: false, checks: [],
    resources: { vaults: [], sessions: [], retained_offboardings: [], intended_vaults: [], intended_sessions: [], uncertain: false }, cleanup: { complete: false, failures: [] } }
  const own: Record<User, { vault?: SDK.VaultRecord; credential?: string; session?: SDK.SessionRecord }> = { a: {}, b: {} }
  const delay = options.delay ?? (() => new Promise(resolve => setTimeout(resolve, 1000)))
  const attempts = options.attempts ?? 120
  let cleaning = false
  let began = false
  const save = () => {
    try { options.save(record) } catch {
      record.failure ??= { kind: 'record_write_failed' }; record.passed = false
      if (!cleaning) check(false, 'record_write_failed')
    }
  }
  const pass = (name: string) => { record.checks.push(name); save() }
  const key = (name: string) => `${f.runId}:${name}`
  const scan = (value: unknown) => {
    const text = JSON.stringify(value)
    check(![options.tokens.a, options.tokens.b].some(secret => text.includes(secret)), 'secret_in_public_response')
  }
  const observe = async () => {
    const value = await options.observe()
    assertObservation(value, f.runId, Object.values(f.accounts)); scan(value)
    return value
  }
  const expect404 = async (action: () => Promise<unknown>) => {
    try { await action() } catch (error) {
      check(error instanceof sdk.ZooworkError && error.status === 404 && !sdk.isVaultBetaUnavailable(error), 'wrong_tenant_error')
      return
    }
    check(false, 'foreign_scope_read_succeeded')
  }
  async function session(user: User, suffix: string): Promise<SDK.SessionRecord> {
    record.resources.uncertain = true; record.resources.intended_sessions.push(suffix); save()
    const value = await client.createSession(f.agentId, { isolation: 'session', vault_ids: [own[user].vault!.id],
      external_user_ref: key(user), metadata: { sdk_vault_e2e: f.runId, user, case: suffix },
    }, key(suffix))
    record.resources.sessions.push(value.session_id); save(); scan(value)
    const binding = value.vault_binding
    check(value.isolation === 'session' && binding?.status === 'unrevoked'
      && value.vault_ids?.length === 1 && value.vault_ids[0] === own[user].vault!.id
      && binding.credential_bindings.length > 0 && binding.credential_bindings.every(item =>
        item.vault_id === own[user].vault!.id && item.credential_id === own[user].credential), 'binding_wrong_credential')
    return value
  }
  async function drive(user: User, target: SDK.SessionRecord, phase: string): Promise<void> {
    const before = await observe()
    const title = key(phase)
    const receipt = await client.postEvents(f.agentId, target.session_id, [{ type: 'user.message',
      content: `Use the connected support service to call whoami. Create one draft titled "${title}" whose body contains the marker returned by whoami. Reply with the draft title and that marker.`,
    }])
    scan(receipt); check(receipt.events.some(row => row.accepted === true), 'event_not_accepted')
    for (let attempt = 0; attempt < attempts; attempt++) {
      options.signal.throwIfAborted()
      const value = await client.getSession(f.agentId, target.session_id, { history: true, limit: 200 })
      scan(value)
      check(!['failed', 'aborted', 'cancelled'].includes(value.run_status ?? ''), 'run_failed')
      const history = value.history ?? []
      check(history.length < 200, 'history_truncated')
      check(!JSON.stringify(history).includes(f.accounts[user === 'a' ? 'b' : 'a'].marker), 'other_user_marker_leaked')
      const answer = history.some(row => {
        const message = row.entry.message as { role?: string } | undefined
        const text = JSON.stringify(message)
        return message?.role === 'assistant' && text.includes(title) && text.includes(f.accounts[user].marker)
      })
      if (value.run_status === 'succeeded' && answer) {
        assertIdentity(before, await observe(), f.accounts[user], f.accounts[user === 'a' ? 'b' : 'a'], title)
        pass(phase); return
      }
      await delay()
    }
    check(false, 'turn_or_fixture_not_covered')
  }
  async function refusesDrive(target: SDK.SessionRecord): Promise<void> {
    const before = await observe()
    let refused = false
    try { await client.postEvents(f.agentId, target.session_id, [{ type: 'user.message', content: 'Check my support account.' }]) }
    catch (error) { refused = error instanceof sdk.ZooworkError && error.status === 409
      && sdk.vaultSessionErrorCode(error) === 'vault.binding_revoked' }
    check(refused, 'revoked_drive_not_refused')
    check(JSON.stringify((await observe()).accounts) === JSON.stringify(before.accounts), 'revoked_drive_reached_provider')
  }
  try {
    // Only this run's already-provisioned canary Agent may receive sessions. No mutable Agent configuration is changed.
    check(/^[a-f0-9]{32}$/.test(f.runId), 'invalid_run_id')
    const agent = await client.getAgent(f.agentId); scan(agent)
    check(agent.declared?.name === `sdk-vault-${f.runId}`
      && (agent.declared?.labels as Record<string, unknown> | undefined)?.sdk_vault_e2e === f.runId
      && agent.ownership?.project_id === f.projectId, 'dedicated_canary_agent_required')
    const projectAgent = await options.foreignProject.getAgent(f.foreignProjectAgentId)
    const orgAgent = await options.foreignOrg.getAgent(f.foreignOrgAgentId)
    scan(projectAgent); scan(orgAgent)
    check(Boolean(agent.ownership?.org_id) && Boolean(projectAgent.ownership?.project_id)
      && projectAgent.ownership?.org_id === agent.ownership?.org_id
      && projectAgent.ownership?.project_id !== f.projectId
      && Boolean(orgAgent.ownership?.org_id) && orgAgent.ownership?.org_id !== agent.ownership?.org_id,
    'foreign_scope_provenance_required')
    for (const scoped of [client, options.foreignProject, options.foreignOrg]) scan(await scoped.listVaults({ limit: 1 }))
    const initial = await observe()
    check(Object.values(f.accounts).every(account => initial.accounts[account.id]!.requests.length === 0
      && initial.drafts[account.id]!.length === 0), 'fresh_fixture_accounts_required')
    pass('preflight'); began = true
    for (const user of USERS) {
      record.resources.uncertain = true; record.resources.intended_vaults.push(user); save()
      const vault = await client.createVault({ scope: 'project', project_id: f.projectId,
        name: `sdk-vault-${f.runId}-${user}`, metadata: { sdk_vault_e2e: f.runId, user },
      }, { idempotencyKey: key(`vault-${user}`) })
      own[user].vault = vault; record.resources.vaults.push(vault.id); save(); scan(vault)
      check(vault.scope === 'project' && vault.project_id === f.projectId, 'vault_wrong_project')
      const credential = await client.createVaultCredential(vault.id, { name: 'fixture', purpose: 'mcp',
        provider_account_ref: f.accounts[user].id,
        auth: { type: 'static_bearer', mcp_server_url: f.mcpServerUrl, access_token: options.tokens[user] },
      }, { idempotencyKey: key(`credential-${user}`) })
      scan(credential); own[user].credential = credential.id
      own[user].session = await session(user, `session-${user}`)
    }
    pass('bindings_use_own_credentials')
    const beforeDenied = await observe()
    for (const scoped of [options.foreignProject, options.foreignOrg]) {
      await expect404(() => scoped.getVault(own.a.vault!.id))
      await expect404(() => scoped.getSession(f.agentId, own.a.session!.session_id))
    }
    check(JSON.stringify((await observe()).accounts) === JSON.stringify(beforeDenied.accounts), 'denied_read_reached_provider')
    pass('foreign_project_and_org_reads_denied')
    await drive('a', own.a.session!, 'a_identity')
    await drive('b', own.b.session!, 'b_identity')
    const binding = own.a.session!.vault_binding!
    const revoked = await client.revokeSessionVaultBinding(f.agentId, own.a.session!.session_id,
      { idempotencyKey: key('revoke-a'), revision: binding.revision })
    scan(revoked); check(revoked.status === 'revoked', 'revoke_not_confirmed')
    await refusesDrive(own.a.session!); pass('revoke_refuses_drive')
    const second = await session('a', 'session-a-second')
    const input = { external_user_ref: key('a'), sessions: [own.a.session!, second].map(value => ({
      agent_id: f.agentId, session_id: value.session_id,
      revision: value.session_id === own.a.session!.session_id ? revoked.revision : value.vault_binding!.revision,
    })) }
    let ledger = await client.createVaultOffboarding(input, { idempotencyKey: key('offboard-a') })
    record.resources.retained_offboardings.push(ledger.id); save(); scan(ledger)
    const replay = await client.createVaultOffboarding(input, { idempotencyKey: key('offboard-a') })
    scan(replay); check(replay.id === ledger.id, 'offboarding_not_idempotent')
    for (let attempt = 0; attempt < attempts && ledger.status === 'in_progress'; attempt++) {
      options.signal.throwIfAborted(); await delay(); ledger = await client.getVaultOffboarding(ledger.id); scan(ledger)
    }
    check(ledger.status === 'completed' && ledger.counts.revoked === 2 && ledger.counts.pending === 0
      && ledger.counts.failed === 0 && ledger.counts.not_found === 0 && ledger.actor_ref.length > 0
      && ledger.correlation_id.length > 0 && ledger.sessions.length === 2, 'offboarding_incomplete')
    check(input.sessions.every(expected => ledger.sessions.some(row => row.agent_id === expected.agent_id
      && row.session_id === expected.session_id && row.state === 'revoked' && row.attempts >= 1
      && row.attempt_log.some(attempt => attempt.result === 'revoked'))), 'offboarding_audit_incomplete')
    await refusesDrive(own.a.session!); await refusesDrive(second); pass('offboarding_completes')
    await drive('b', own.b.session!, 'b_survives_a_offboarding')
  } catch (error) { record.failure = safeFailure(error) }
  finally {
    cleaning = true; options.cleanupMode()
    const clean = async (action: () => Promise<void>) => {
      try { await action() } catch (error) { record.cleanup.failures.push(safeFailure(error)) }
      save()
    }
    if (began) {
      // Recover ambiguous create responses by exact run metadata, never by a loose name prefix.
      await clean(async () => {
        let sessionCursor: string | undefined
        const foundSessions = new Set<string>()
        for (let page = 0; page < 10; page++) {
          const values = await client.listSessionPage(f.agentId, { cursor: sessionCursor, limit: 100 }); scan(values)
          for (const value of values.sessions) if (value.metadata?.sdk_vault_e2e === f.runId) {
            foundSessions.add(String(value.metadata.case))
            if (!record.resources.sessions.includes(value.session_id)) record.resources.sessions.push(value.session_id)
          }
          if (!values.next_cursor) break
          check(values.next_cursor !== sessionCursor && page < 9, 'cleanup_session_discovery_incomplete')
          sessionCursor = values.next_cursor
        }
        const foundVaults = new Set<string>()
        let cursor: string | undefined
        for (let page = 0; page < 10; page++) {
          const values = await client.listVaults({ cursor, limit: 100 }); scan(values)
          for (const value of values.data) if (value.metadata.sdk_vault_e2e === f.runId && value.project_id === f.projectId) {
            foundVaults.add(String(value.metadata.user))
            if (!record.resources.vaults.includes(value.id)) record.resources.vaults.push(value.id)
          }
          if (!values.has_more) {
            record.resources.uncertain = !record.resources.intended_vaults.every(value => foundVaults.has(value))
              || !record.resources.intended_sessions.every(value => foundSessions.has(value))
            check(!record.resources.uncertain, 'unsettled_create_requires_recovery'); return
          }
          check(values.next_cursor && values.next_cursor !== cursor, 'cleanup_cursor_missing'); cursor = values.next_cursor
        }
        check(false, 'cleanup_discovery_incomplete')
      })
      for (const id of record.resources.sessions) await clean(async () => {
        try {
          const value = await client.getSession(f.agentId, id); scan(value)
          check(value.metadata?.sdk_vault_e2e === f.runId, 'cleanup_session_ownership_changed')
          await client.deleteSession(f.agentId, id)
          await expect404(() => client.getSession(f.agentId, id))
        } catch (error) {
          if (!(error instanceof sdk.ZooworkError && error.status === 404)) throw error
        }
      })
      for (const id of record.resources.vaults) await clean(async () => {
        try {
          const value = await client.getVault(id); scan(value)
          check(value.metadata.sdk_vault_e2e === f.runId && value.project_id === f.projectId, 'cleanup_vault_ownership_changed')
          await client.deleteVault(id, { idempotencyKey: key(`cleanup-${id}`), revision: value.revision })
          await expect404(() => client.getVault(id))
        } catch (error) { if (!(error instanceof sdk.ZooworkError && error.status === 404)) throw error }
      })
    }
    record.cleanup.complete = !record.resources.uncertain && record.cleanup.failures.length === 0
    record.passed = !record.failure && record.cleanup.complete && record.checks.includes('b_survives_a_offboarding')
    save()
  }
  return record
}
