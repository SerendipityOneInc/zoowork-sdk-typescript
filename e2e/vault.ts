// Explicit staging-only SDK acceptance, using a dedicated pre-provisioned canary/fixture.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { baseURL, check, explicitOutput, guardedFetch, hash, hashTree, privateDir, safeFailure, validApiKey, writeJSON } from './guard.ts'
import { vaultAcceptance, type VaultFixture } from './vault-smoke.ts'
import type { FixtureObservation } from './vault-observation.ts'

export function fixtureConfig(value: unknown): VaultFixture & { origin: string; facadeCommit: string; engineCommit: string } {
  const f = value as VaultFixture & { origin: string; facadeCommit: string; engineCommit: string }
  check(f && typeof f === 'object' && /^[a-f0-9]{32}$/.test(f.runId), 'invalid_fixture_run')
  check(typeof f.projectId === 'string' && f.projectId.startsWith('proj_')
    && typeof f.agentId === 'string' && f.agentId.startsWith('agt_')
    && [f.foreignProjectAgentId, f.foreignOrgAgentId].every(id => typeof id === 'string' && id.startsWith('agt_')), 'invalid_canary_ids')
  const origin = new URL(f.origin)
  check(origin.protocol === 'https:' && origin.href === origin.origin + '/', 'plain_https_fixture_origin_required')
  const mcp = new URL(f.mcpServerUrl)
  check(mcp.origin === origin.origin && /^\/mcp(?:\/[a-zA-Z0-9_-]+)?$/.test(mcp.pathname)
    && !mcp.search && !mcp.hash && !mcp.username && !mcp.password, 'fixture_mcp_origin_mismatch')
  for (const account of [f.accounts?.a, f.accounts?.b]) {
    check(account && /^[A-Za-z0-9_-]{1,64}$/.test(account.id) && /^[A-Za-z0-9]{16,}$/.test(account.marker)
      && /^hmac:[a-f0-9]{16}$/.test(account.fingerprint), 'invalid_fixture_account')
  }
  check(f.accounts.a.id !== f.accounts.b.id && f.accounts.a.marker !== f.accounts.b.marker
    && f.accounts.a.fingerprint !== f.accounts.b.fingerprint, 'distinct_fixture_accounts_required')
  check(/^[a-f0-9]{40}$/.test(f.facadeCommit) && /^[a-f0-9]{40}$/.test(f.engineCommit), 'deployment_commits_required')
  return f
}
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'out-dir': { type: 'string' }, 'base-url': { type: 'string' },
    fixture: { type: 'string' }, 'confirm-staging': { type: 'boolean' }, help: { type: 'boolean' } } })
  if (values.help) {
    console.log('node e2e/vault.ts --base-url HTTPS_SERVICE_V1 --fixture PREPARED_FIXTURE_JSON --out-dir NEW_PRIVATE_DIR --confirm-staging\nSecrets arrive as JSON on stdin only. Creates two Vaults, three Sessions and an offboarding audit record. Uses an existing dedicated canary; never changes Agent configuration or fixture state.'); return
  }
  check(values['confirm-staging'] && values.fixture && values['base-url'] && values['out-dir'], 'explicit_staging_fixture_and_output_required')
  const sdk = await import('@zoowork-ai/sdk')
  const base = baseURL(values['base-url'], sdk.DEFAULT_BASE_URL)
  const fixture = fixtureConfig(JSON.parse(readFileSync(values.fixture, 'utf8')))
  let buffer = ''
  for await (const chunk of process.stdin) { buffer += chunk; check(buffer.length <= 16_384, 'secret_input_too_large') }
  const secrets = JSON.parse(buffer) as { apiKey: string; foreignProjectKey: string; foreignOrgKey: string;
    fixtureControlToken: string; tokens: { a: string; b: string } }
  buffer = ''
  const keys = [secrets.apiKey, secrets.foreignProjectKey, secrets.foreignOrgKey]
  check(keys.every(value => typeof value === 'string' && value.startsWith('zwp_live_') && validApiKey(value))
    && new Set(keys).size === 3, 'three_distinct_project_keys_required')
  check(typeof secrets.fixtureControlToken === 'string' && secrets.fixtureControlToken.length >= 32
    && typeof secrets.tokens?.a === 'string' && typeof secrets.tokens.b === 'string'
    && secrets.tokens.a.length >= 24 && secrets.tokens.b.length >= 24 && secrets.tokens.a !== secrets.tokens.b,
  'invalid_fixture_secrets')
  const directory = explicitOutput(values['out-dir'], fileURLToPath(new URL('..', import.meta.url)))
  check(!existsSync(directory), 'new_output_directory_required'); privateDir(directory)
  const abort = new AbortController(); const cancel = () => abort.abort()
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel)
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(600_000)])
  let active = signal; let cleaning = false
  const transport = guardedFetch(base, () => active, fetch, () => cleaning, { main: 800, cleanup: 100 })
  const clients = keys.map(apiKey => sdk.createZooworkClient({ apiKey, baseUrl: base, fetch: transport }))
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@zoowork-ai/sdk'))))
  const provenance = { environment: 'staging', base_url: base,
    sdk_version: JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version,
    sdk_dist_sha256: hashTree(join(packageRoot, 'dist')),
    declared_deployment_commits: { facade: fixture.facadeCommit, engine: fixture.engineCommit },
    runner_sha256: hash(['vault.ts', 'vault-smoke.ts', 'vault-observation.ts', 'guard.ts'].map(name => name + '\0'
      + hash(readFileSync(new URL(name, import.meta.url)))).join('\0')) }
  let observations = 0
  const result = await vaultAcceptance(sdk, clients[0]!, { fixture, tokens: secrets.tokens,
    foreignProject: clients[1]!, foreignOrg: clients[2]!, signal,
    observe: async () => {
      check(++observations <= 60, 'fixture_request_budget_exceeded')
      const response = await fetch(new URL('/v1/observations', fixture.origin), { redirect: 'error',
        headers: { authorization: `Bearer ${secrets.fixtureControlToken}` },
        signal: AbortSignal.any([active, AbortSignal.timeout(30_000)]) })
      check(response.ok && response.body, 'fixture_observation_unavailable')
      let bytes = 0; const chunks: Uint8Array[] = []
      for await (const chunk of response.body) { bytes += chunk.length; check(bytes <= 8 * 1024 * 1024, 'fixture_response_too_large'); chunks.push(chunk) }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as FixtureObservation
    },
    cleanupMode: () => { cleaning = true; active = AbortSignal.timeout(90_000) },
    save: record => writeJSON(join(directory, 'vault-result.json'), { ...provenance, ...record }),
  })
  process.off('SIGINT', cancel); process.off('SIGTERM', cancel)
  console.log(JSON.stringify({ passed: result.passed, checks: result.checks, failure: result.failure,
    cleanup_complete: result.cleanup.complete, reports: directory }))
  process.exitCode = result.passed ? 0 : 1
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.log(JSON.stringify({ passed: false, failure: safeFailure(error) })); process.exitCode = 1 })
}
