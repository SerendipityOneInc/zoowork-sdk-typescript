// Run from the built SDK checkout or an isolated consumer containing this runner, custom-tools-smoke.ts and guard.ts.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  baseURL,
  check,
  explicitOutput,
  guardedFetch,
  hash,
  hashTree,
  privateDir,
  safeFailure,
  validApiKey,
  writeJSON,
} from './guard.ts'
import { customToolsSmoke } from './custom-tools-smoke.ts'

const STAGING_BASE_URL = 'https://claw-interface.ecap.yesy.live/service/v1'

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'out-dir': { type: 'string' },
      'base-url': { type: 'string' },
      model: { type: 'string' },
      'confirm-staging': { type: 'boolean' },
      'confirm-production': { type: 'boolean' },
      'api-key-stdin': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  })
  if (values.help) {
    console.log(
      `node e2e/custom-tools.ts --out-dir NEW_PRIVATE_DIR (--confirm-staging [--base-url HTTPS_SERVICE_V1] | --confirm-production --base-url HTTPS_SERVICE_V1) [--api-key-stdin] [--model ID]\nDefault staging: ${STAGING_BASE_URL}\nOne temporary Agent and two custom-tool end_turn sessions, then cleanup. No publishing. Key via stdin or ZOOWORK_API_KEY.`,
    )
    return
  }
  check(values['confirm-staging'] !== values['confirm-production'], 'one_environment_confirmation_required')
  check(!values['confirm-production'] || values['base-url'], 'explicit_production_url_required')
  check(values['out-dir'], 'explicit_output_required')

  const sdk = await import('@zoowork-ai/sdk')
  const base = baseURL(values['base-url'] ?? STAGING_BASE_URL, sdk.DEFAULT_BASE_URL, values['confirm-production'])
  let key = process.env.ZOOWORK_API_KEY ?? ''
  delete process.env.ZOOWORK_API_KEY
  if (values['api-key-stdin']) {
    key = ''
    for await (const chunk of process.stdin) {
      key += chunk
      check(key.length < 4096, 'credential_input_too_large')
    }
  }
  key = key.trim()
  check(validApiKey(key), 'invalid_key_format')

  const directory = explicitOutput(values['out-dir'], fileURLToPath(new URL('..', import.meta.url)))
  check(!existsSync(directory), 'new_output_directory_required')
  privateDir(directory)
  const recordPath = join(directory, 'custom-tools-result.json')

  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.on('SIGINT', cancel)
  process.on('SIGTERM', cancel)
  let cleaning = false
  let active = AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)])
  const client = sdk.createZooworkClient({
    apiKey: key,
    baseUrl: base,
    fetch: guardedFetch(base, () => active, fetch, () => cleaning, { main: 250, cleanup: 40 }),
  })
  key = ''

  const packageRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@zoowork-ai/sdk'))))
  const provenance = {
    sdk_version: JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version,
    sdk_dist_sha256: hashTree(join(packageRoot, 'dist')),
    environment: values['confirm-production'] ? 'production' : 'staging',
    base_url: base,
    runner_sha256: hash(
      ['custom-tools.ts', 'custom-tools-smoke.ts', 'guard.ts']
        .map((name) => name + '\0' + hash(readFileSync(new URL(name, import.meta.url))))
        .join('\0'),
    ),
  }

  const result = await customToolsSmoke(
    { customToolUse: sdk.customToolUse, isRunFinished: sdk.isRunFinished },
    client,
    {
      runId: randomUUID().replaceAll('-', ''),
      model: values.model,
      signal: active,
      cleanupMode: () => {
        cleaning = true
        active = AbortSignal.timeout(90_000)
      },
      save: (record) => writeJSON(recordPath, { ...provenance, ...record }),
    },
  )
  process.off('SIGINT', cancel)
  process.off('SIGTERM', cancel)

  console.log(
    JSON.stringify({
      passed: result.passed,
      checks: result.checks,
      failure: result.failure,
      cleanup_complete: result.cleanup.complete,
      environment: provenance.environment,
      reports: directory,
    }),
  )
  process.exitCode = result.passed ? 0 : 1
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.log(JSON.stringify({ passed: false, failure: safeFailure(error) }))
    process.exitCode = 1
  })
}
