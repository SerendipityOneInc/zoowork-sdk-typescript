import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { baseURL, check, explicitOutput, hash, hashTree, privateDir, readJSON, safeFailure, writeJSON } from './guard.ts'
import type { SmokeRecord } from './smoke.ts'
import { elapsed, LiveProgress } from './progress.ts'

const ROOT = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
const RUNNER_FILES = ['live.ts', 'smoke.ts', 'guard.ts', 'progress.ts']
let npmConfig: string | undefined
export interface Manifest {
  schema_version: 1; run_id: string; package_name: string; version: string;
  source: { root: string; head: string; fingerprint: string };
  tarball: string; tarball_sha256: string; runner_sha256: string; installed_sha256: string;
  offline_checks: string[]; status: 'prepared';
}
function environment(): NodeJS.ProcessEnv {
  // Build, pack and install never receive API/npm/cloud credentials or NODE_OPTIONS.
  if (!npmConfig) {
    npmConfig = mkdtempSync(join(tmpdir(), 'sdk-release-npm-'))
    for (const file of ['user.npmrc', 'global.npmrc']) writeFileSync(join(npmConfig, file), '', { mode: 0o600, flag: 'wx' })
  }
  return { PATH: process.env.PATH, HOME: homedir(), LANG: 'C',
    npm_config_userconfig: join(npmConfig, 'user.npmrc'), npm_config_globalconfig: join(npmConfig, 'global.npmrc'),
    npm_config_cache: join(npmConfig, 'cache'),
    npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
}
function command(cwd: string, executable: string, args: string[], phase: string, visible = false): string {
  const result = spawnSync(executable, args, { cwd, env: environment(), encoding: 'utf8', timeout: 240_000,
    maxBuffer: 8 * 1024 * 1024, stdio: visible ? ['ignore', 'inherit', 'inherit'] : 'pipe' })
  check(!result.error && result.status === 0, phase + '_failed')
  return result.stdout ?? ''
}
function offlineStep<T>(label: string, action: () => T): T {
  console.log(`RUN  ${label}`)
  const started = performance.now()
  try {
    const value = action()
    console.log(`PASS ${label} (${elapsed(performance.now() - started)})`)
    return value
  } catch (error) {
    console.log(`FAIL ${label} (${elapsed(performance.now() - started)})`)
    throw error
  }
}
export function fingerprint(repo: string): string {
  const paths = command(repo, 'git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], 'source_index').split('\0').filter(Boolean).sort()
  return hash(paths.map(path => {
    const file = join(repo, path)
    if (!existsSync(file)) return path + '\0deleted'
    check(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), 'source_symlinks_refused')
    return path + '\0' + hash(readFileSync(file))
  }).join('\0'))
}
function runnerHash(directory: string): string {
  return hash(RUNNER_FILES.map(file => file + '\0' + hash(readFileSync(join(directory, file)))).join('\0'))
}
export function verifyCandidate(directory: string): Manifest {
  const manifest = readJSON<Manifest>(join(directory, 'manifest.json'))
  check(manifest.schema_version === 1 && manifest.status === 'prepared' && manifest.package_name === '@zoowork-ai/sdk', 'invalid_manifest')
  check(/^[a-zA-Z0-9_.-]+\.tgz$/.test(manifest.tarball), 'invalid_tarball_path')
  check(hash(readFileSync(join(directory, manifest.tarball))) === manifest.tarball_sha256, 'tarball_changed')
  check(runnerHash(join(directory, 'consumer')) === manifest.runner_sha256, 'runner_changed')
  check(hashTree(join(directory, 'consumer/node_modules/@zoowork-ai/sdk')) === manifest.installed_sha256, 'installed_package_changed')
  check(manifest.source.root === ROOT && fingerprint(ROOT) === manifest.source.fingerprint, 'source_changed_repack_required')
  return manifest
}
export function verifyPassed(directory: string): Manifest {
  const manifest = verifyCandidate(directory)
  check(existsSync(join(directory, 'result.json')), 'successful_staging_check_required')
  const result = readJSON<{ schema_version: number; run_id: string; tarball_sha256: string;
    staging_smoke_passed: boolean; cleanup_complete: boolean }>(join(directory, 'result.json'))
  check(result.schema_version === 1 && result.run_id === manifest.run_id && result.tarball_sha256 === manifest.tarball_sha256
    && result.staging_smoke_passed === true && result.cleanup_complete === true, 'successful_staging_check_required')
  return manifest
}
export function prepare(directoryPath: string): string {
  const directory = explicitOutput(directoryPath, ROOT)
  check(!existsSync(directory), 'use_a_new_output_directory')
  privateDir(directory)
  const before = fingerprint(ROOT)
  const pkg = readJSON<{ name: string; version: string; dependencies?: Record<string, string>; files: string[] }>(join(ROOT, 'package.json'))
  check(pkg.name === '@zoowork-ai/sdk' && !Object.keys(pkg.dependencies ?? {}).length, 'unexpected_package_or_runtime_dependencies')
  console.log(`\nOffline preparation — ${pkg.name}@${pkg.version} (no API calls)`)
  const offline: [string, string[]][] = [
    ['SDK typecheck and test cases', ['test', '--reporter=verbose']],
    ['E2E runner typecheck', ['typecheck:e2e']],
    ['E2E runner test cases (synthetic, not live)', ['test:e2e:offline']],
  ]
  for (const [label, args] of offline) offlineStep(label, () => command(ROOT, 'pnpm', args, args[0], true))
  const pack = privateDir(join(directory, 'package'))
  // Compile into a clean candidate directory, never reuse stale dist from another build.
  offlineStep('Build clean candidate', () => command(ROOT, 'pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json', '--outDir', join(pack, 'dist')], 'build', true))
  for (const file of ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE']) copyFileSync(join(ROOT, file), join(pack, file))
  const packed = offlineStep('Pack and check published files', () => {
    const files = JSON.parse(command(pack, 'npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], 'pack')) as { filename: string; files: { path: string }[] }[]
    check(files.length === 1 && /^[a-zA-Z0-9_.-]+\.tgz$/.test(files[0].filename), 'invalid_pack_output')
    check(files[0].files.every(f => ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE'].includes(f.path)
      || (/^dist\/[A-Za-z0-9_/-]+(?:\.d)?\.js$/.test(f.path) || /^dist\/[A-Za-z0-9_/-]+\.d\.ts$/.test(f.path))
        && !f.path.includes('.test.')), 'unexpected_published_file')
    return files
  })
  const consumer = privateDir(join(directory, 'consumer'))
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }), { mode: 0o600, flag: 'wx' })
  offlineStep('Install tarball into isolated consumer', () => command(consumer, 'npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', join(directory, packed[0].filename)], 'isolated_install'))
  for (const file of RUNNER_FILES) copyFileSync(join(ROOT, 'e2e', file), join(consumer, file))
  const typecheck = "import { createZooworkClient, assistantText, type SessionEvent } from '@zoowork-ai/sdk';\nconst client = createZooworkClient({apiKey:'typecheck-only'});\nvoid client.createAgent({resource:{name:'typecheck-only'}});\nconst render: (event: SessionEvent) => string = assistantText;\nvoid render;\n"
  writeFileSync(join(consumer, 'consumer-check.ts'), typecheck, { mode: 0o600, flag: 'wx' })
  offlineStep('Typecheck installed consumer', () => command(ROOT, 'pnpm', ['exec', 'tsc', '--noEmit', '--strict', '--module', 'NodeNext', '--target', 'ES2022', '--skipLibCheck', join(consumer, 'consumer-check.ts')], 'consumer_types', true))
  offlineStep('Verify source remained unchanged', () => check(fingerprint(ROOT) === before, 'source_changed_during_prepare'))
  const manifest: Manifest = { schema_version: 1, run_id: randomUUID(), package_name: pkg.name, version: pkg.version,
    source: { root: ROOT, head: command(ROOT, 'git', ['rev-parse', 'HEAD'], 'source_head').trim(), fingerprint: before },
    tarball: packed[0].filename, tarball_sha256: hash(readFileSync(join(directory, packed[0].filename))),
    runner_sha256: runnerHash(consumer), installed_sha256: hashTree(join(consumer, 'node_modules/@zoowork-ai/sdk')),
    offline_checks: ['sdk_tests', 'runner_types', 'runner_offline_tests', 'clean_build', 'pack_contents', 'isolated_install', 'consumer_types'], status: 'prepared' }
  writeJSON(join(directory, 'manifest.json'), manifest)
  console.log(`Offline preparation passed. Candidate: ${pkg.name}@${pkg.version}`)
  return directory
}
export async function run(directoryPath: string, input: { baseUrl: string; apiKey: string; model?: string; confirmed: boolean }): Promise<number> {
  check(input.confirmed, 'explicit_staging_mutation_confirmation_required')
  const directory = realpathSync(directoryPath)
  const manifest = verifyCandidate(directory)
  const installed = await import(pathToFileURL(join(directory, 'consumer/node_modules/@zoowork-ai/sdk/dist/index.js')).href) as { DEFAULT_BASE_URL: string }
  const base = baseURL(input.baseUrl, installed.DEFAULT_BASE_URL)
  check(/^zct_[A-Za-z0-9_-]+$/.test(input.apiKey), 'invalid_key_format')
  check(!existsSync(join(directory, 'live-started.json')), 'live_attempt_already_started_no_automatic_retry')
  // Detect accidental inclusion of this credential in the unpacked candidate without logging it.
  const packageRoot = join(directory, 'consumer/node_modules/@zoowork-ai/sdk')
  function scan(path: string): void {
    for (const name of readdirSync(path)) {
      const file = join(path, name)
      if (lstatSync(file).isDirectory()) scan(file)
      else check(!readFileSync(file).includes(Buffer.from(input.apiKey)), 'credential_in_candidate_refused')
    }
  }
  scan(packageRoot)
  writeFileSync(join(directory, 'live-started.json'), JSON.stringify({ run_id: manifest.run_id, base_url: base, tarball_sha256: manifest.tarball_sha256,
    started_at: new Date().toISOString(), limits: { agents: 1, sessions: 1, turns: 1, run_seconds: 180, cleanup_seconds: 60,
      main_requests: 80, cleanup_requests: 12, output_tokens_per_request: 2048 } }), { flag: 'wx', mode: 0o600 })
  console.log(`\nLive staging smoke — ${manifest.package_name}@${manifest.version}\nOne temporary agent, one session, one model turn, then cleanup.`)
  const started = performance.now()
  const progress = new LiveProgress()
  const showProgress = () => {
    try { progress.observe(readJSON(join(directory, 'live-result.json'))) } catch { /* The first record may not exist yet. */ }
  }
  const child = spawn(process.execPath, [join(directory, 'consumer/live.ts')], { cwd: join(directory, 'consumer'), env: environment(), stdio: ['pipe', 'pipe', 'pipe'] })
  const progressTimer = setInterval(showProgress, 100)
  const cancel = () => child.kill('SIGTERM')
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel)
  child.stdout.resume(); child.stderr.resume() // No raw child output, stack, body, key or model reply is forwarded.
  child.stdin.on('error', () => {})
  child.stdin.end(JSON.stringify({ apiKey: input.apiKey, baseUrl: base, model: input.model, runId: manifest.run_id, directory }))
  input.apiKey = ''
  const watchdog = setTimeout(cancel, 250_000)
  const hardStop = setTimeout(() => child.kill('SIGKILL'), 320_000)
  const code = await new Promise<number>(resolve => { child.on('error', () => resolve(1)); child.on('exit', code => resolve(code ?? 1)) })
  clearInterval(progressTimer)
  clearTimeout(watchdog); clearTimeout(hardStop); process.off('SIGINT', cancel); process.off('SIGTERM', cancel)
  const record = existsSync(join(directory, 'live-result.json')) ? readJSON<SmokeRecord>(join(directory, 'live-result.json')) : undefined
  verifyCandidate(directory)
  const passed = code === 0 && record?.run_id === manifest.run_id && record?.passed === true && record.cleanup.complete === true
  writeJSON(join(directory, 'result.json'), { schema_version: 1, run_id: manifest.run_id, tarball_sha256: manifest.tarball_sha256,
    staging_smoke_passed: passed, cleanup_complete: record?.cleanup.complete === true,
    production_compatibility: 'unverified', publication_authorized: false, phase: record?.phase ?? 'runner_failed', failure: record?.failure })
  progress.finish(record, passed, performance.now() - started)
  console.log(`Reports: ${join(directory, 'result.json')}\nStep details: ${join(directory, 'live-result.json')}`)
  return passed ? 0 : 1
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'out-dir': { type: 'string' }, 'base-url': { type: 'string' }, model: { type: 'string' },
    'confirm-staging': { type: 'boolean' },
    'api-key-stdin': { type: 'boolean' }, help: { type: 'boolean' },
  } })
  if (values.help) { console.log('prepare --out-dir NEW_PRIVATE_DIR\nrun --out-dir PREPARED_DIR --base-url HTTPS_SERVICE_V1 --confirm-staging [--api-key-stdin] [--model ID]\nverify --out-dir PREPARED_DIR\nE2E only; never publishes. Publish separately with npm publish. Node 22.20+. Key via stdin or ZOOWORK_API_KEY, never an argument.'); return }
  check(positionals.length === 1 && values['out-dir'], 'command_and_output_directory_required')
  if (positionals[0] === 'prepare') console.log(`Prepared candidate: ${prepare(values['out-dir'])}`)
  else if (positionals[0] === 'verify') { const manifest = verifyPassed(realpathSync(values['out-dir'])); console.log(JSON.stringify({ candidate_unchanged: true, staging_smoke_passed: true, tarball_sha256: manifest.tarball_sha256, publication_authorized: false })) }
  else {
    check(positionals[0] === 'run' && values['base-url'], 'explicit_run_and_base_url_required')
    let apiKey = process.env.ZOOWORK_API_KEY ?? ''
    delete process.env.ZOOWORK_API_KEY
    if (values['api-key-stdin']) {
      apiKey = ''
      for await (const chunk of process.stdin) { apiKey += chunk; check(apiKey.length < 4096, 'credential_input_too_large') }
    }
    process.exitCode = await run(values['out-dir'], { baseUrl: values['base-url'], apiKey: apiKey.trim(), model: values.model, confirmed: values['confirm-staging'] === true })
    apiKey = ''
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.log(JSON.stringify({ passed: false, failure: safeFailure(error) })); process.exitCode = 1 })
}
