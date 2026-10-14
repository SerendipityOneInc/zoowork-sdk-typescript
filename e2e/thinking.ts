// Run from the built SDK checkout or an isolated consumer containing this runner and guard.ts.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { baseURL, check, explicitOutput, guardedFetch, hash, hashTree, privateDir, safeFailure, validApiKey, writeJSON } from './guard.ts'
import { thinkingSmoke } from './thinking-smoke.ts'

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    'out-dir': { type: 'string' }, 'base-url': { type: 'string' }, model: { type: 'string' },
    'confirm-staging': { type: 'boolean' }, 'confirm-production': { type: 'boolean' },
    'api-key-stdin': { type: 'boolean' }, help: { type: 'boolean' },
  } })
  if (values.help) {
    console.log('node e2e/thinking.ts --out-dir NEW_PRIVATE_DIR --base-url HTTPS_SERVICE_V1 (--confirm-staging | --confirm-production) [--api-key-stdin] [--model ID]\nOne temporary Agent, four turns and one Schedule, then cleanup. No publishing. Key via stdin or ZOOWORK_API_KEY.')
    return
  }
  check(values['confirm-staging'] !== values['confirm-production'], 'one_environment_confirmation_required')
  check(values['base-url'] && values['out-dir'], 'explicit_base_and_output_required')
  const sdk = await import('@zoowork-ai/sdk')
  const base = baseURL(values['base-url'], sdk.DEFAULT_BASE_URL, values['confirm-production'])
  let key = process.env.ZOOWORK_API_KEY ?? ''; delete process.env.ZOOWORK_API_KEY
  if (values['api-key-stdin']) { key = ''; for await (const chunk of process.stdin) { key += chunk; check(key.length < 4096, 'credential_input_too_large') } }
  key = key.trim(); check(validApiKey(key), 'invalid_key_format')
  const directory = explicitOutput(values['out-dir'], fileURLToPath(new URL('..', import.meta.url)))
  check(!existsSync(directory), 'new_output_directory_required'); privateDir(directory)
  const recordPath = join(directory, 'thinking-result.json')
  const controller = new AbortController(); const cancel = () => controller.abort()
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel)
  let cleaning = false
  let active = AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)])
  const client = sdk.createZooworkClient({ apiKey: key, baseUrl: base,
    fetch: guardedFetch(base, () => active, fetch, () => cleaning, { main: 400, cleanup: 40 }) })
  key = ''
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@zoowork-ai/sdk'))))
  const provenance = { sdk_version: JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version,
    sdk_dist_sha256: hashTree(join(packageRoot, 'dist')), environment: values['confirm-production'] ? 'production' : 'staging', base_url: base,
    runner_sha256: hash(['thinking.ts', 'thinking-smoke.ts', 'guard.ts'].map(name => name + '\0'
      + hash(readFileSync(new URL(name, import.meta.url)))).join('\0')) }
  const result = await thinkingSmoke(client, { runId: randomUUID().replaceAll('-', ''), model: values.model,
    signal: active, cleanupMode: () => { cleaning = true; active = AbortSignal.timeout(90_000) },
    save: record => writeJSON(recordPath, { ...provenance, ...record }),
  })
  process.off('SIGINT', cancel); process.off('SIGTERM', cancel)
  console.log(JSON.stringify({ passed: result.passed, checks: result.checks, failure: result.failure,
    cleanup_complete: result.cleanup.complete, environment: provenance.environment, reports: directory }))
  process.exitCode = result.passed ? 0 : 1
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.log(JSON.stringify({ passed: false, failure: safeFailure(error) })); process.exitCode = 1 })
}
