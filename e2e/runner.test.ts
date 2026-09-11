// Synthetic E2E records only; not captured API fixtures or proof of a live pass.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hash, hashTree, writeJSON } from './guard.ts'
import { fingerprint, run, verifyCandidate, verifyPassed } from './runner.ts'
import type { Manifest } from './runner.ts'

const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'))
function candidate() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'sdk-release-record-test-')))
  const consumer = join(directory, 'consumer')
  const installed = join(consumer, 'node_modules/@zoowork-ai/sdk')
  mkdirSync(installed, { recursive: true })
  writeFileSync(join(installed, 'index.js'), 'export const synthetic = true\n')
  writeFileSync(join(directory, 'synthetic.tgz'), 'synthetic artifact, not a package')
  for (const name of ['live.ts', 'smoke.ts', 'guard.ts', 'progress.ts']) writeFileSync(join(consumer, name), '// synthetic\n')
  const manifest: Manifest = { schema_version: 1, run_id: 'synthetic', package_name: '@zoowork-ai/sdk', version: '0.0.0-test',
    source: { root, head: 'synthetic', fingerprint: fingerprint(root) }, tarball: 'synthetic.tgz',
    tarball_sha256: hash(readFileSync(join(directory, 'synthetic.tgz'))),
    runner_sha256: hash(['live.ts', 'smoke.ts', 'guard.ts', 'progress.ts'].map(name => name + '\0' + hash(readFileSync(join(consumer, name)))).join('\0')),
    installed_sha256: hashTree(installed), offline_checks: [], status: 'prepared' }
  writeJSON(join(directory, 'manifest.json'), manifest)
  const result = { schema_version: 1, run_id: manifest.run_id, tarball_sha256: manifest.tarball_sha256,
    staging_smoke_passed: true, cleanup_complete: true }
  return { directory, consumer, installed, manifest, result }
}
test('candidate verification rejects tarball, runner, installed package and source drift', () => {
  for (const target of ['tarball', 'runner', 'installed', 'source'] as const) {
    const c = candidate()
    assert.equal(verifyCandidate(c.directory).run_id, 'synthetic')
    if (target === 'tarball') writeFileSync(join(c.directory, c.manifest.tarball), 'changed')
    if (target === 'runner') writeFileSync(join(c.consumer, 'live.ts'), '// changed')
    if (target === 'installed') writeFileSync(join(c.installed, 'index.js'), '// changed')
    if (target === 'source') { c.manifest.source.fingerprint = 'changed'; writeJSON(join(c.directory, 'manifest.json'), c.manifest) }
    assert.throws(() => verifyCandidate(c.directory))
  }
})
test('preparation or a partial/failed/mismatched result cannot satisfy verify', () => {
  const c = candidate()
  assert.throws(() => verifyPassed(c.directory), /successful_staging_check_required/)
  for (const changes of [{ cleanup_complete: false }, { staging_smoke_passed: false }, { run_id: 'other' }, { tarball_sha256: 'other' }]) {
    writeJSON(join(c.directory, 'result.json'), { ...c.result, ...changes })
    assert.throws(() => verifyPassed(c.directory))
  }
  writeJSON(join(c.directory, 'result.json'), c.result)
  assert.equal(verifyPassed(c.directory).run_id, 'synthetic')
})
test('source fingerprints include local edits and untracked files, not ignored credentials', () => {
  const repo = mkdtempSync(join(tmpdir(), 'sdk-release-source-test-'))
  execFileSync('git', ['init', '-q', repo])
  writeFileSync(join(repo, '.gitignore'), '.env\n')
  writeFileSync(join(repo, 'index.ts'), 'export const n = 1\n')
  const before = fingerprint(repo)
  writeFileSync(join(repo, '.env'), 'SYNTHETIC_NOT_A_CREDENTIAL=yes\n')
  assert.equal(fingerprint(repo), before)
  writeFileSync(join(repo, 'index.ts'), 'export const n = 2\n')
  const edited = fingerprint(repo)
  assert.notEqual(edited, before)
  writeFileSync(join(repo, 'new.ts'), '// new\n')
  assert.notEqual(fingerprint(repo), edited)
})
test('E2E helper has no publication command and directs maintainers to npm', () => {
  const result = spawnSync(process.execPath, [join(root, 'e2e/runner.ts'), '--help'], {
    cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10_000,
  })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /E2E only; never publishes/)
  const publish = spawnSync(process.execPath, [join(root, 'e2e/runner.ts'), 'publish', '--out-dir', '/synthetic'], {
    cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10_000,
  })
  assert.equal(publish.status, 1)
  assert.match(publish.stdout, /explicit_run_and_base_url_required/)
})
test('real child runner reports timed steps while raw child output stays suppressed (synthetic SDK, no network)', async () => {
  const c = candidate()
  const runnerFiles = ['live.ts', 'smoke.ts', 'guard.ts', 'progress.ts']
  for (const name of runnerFiles) copyFileSync(join(root, 'e2e', name), join(c.consumer, name))
  mkdirSync(join(c.installed, 'dist'))
  writeFileSync(join(c.installed, 'package.json'), JSON.stringify({ type: 'module', exports: './dist/index.js' }))
  // Deliberately noisy synthetic child: the parent must display only its structured ledger.
  writeFileSync(join(c.installed, 'dist/index.js'), `
export const DEFAULT_BASE_URL = 'https://production.invalid/service/v1';
export const assistantText = e => e.text ?? '';
export const isRunFinished = e => e.done === true;
export const runOutcome = () => 'succeeded';
export function createZooworkClient(options) {
  const events = [{text:'synthetic-private-reply'}, {done:true}];
  console.log(options.apiKey); console.error('synthetic-private-child-error');
  return {
    listModels: async () => { await new Promise(r => setTimeout(r, 250)); return [{model:'synthetic'}]; },
    createAgent: async () => ({agent_id:'agt_SYNTHETIC'}),
    startAgent: async () => ({}), waitUntilRunning: async () => ({}),
    createSession: async () => ({session_id:'SYNTHETIC_SESSION'}),
    streamEvents: async function* () { yield* events; }, listAllEvents: async () => events,
    deleteSession: async () => {}, stopAgent: async () => {}, deleteAgent: async () => {},
    getAgent: async () => { throw {status:404}; },
  };
}
`)
  c.manifest.runner_sha256 = hash(runnerFiles.map(name => name + '\0' + hash(readFileSync(join(c.consumer, name)))).join('\0'))
  c.manifest.installed_sha256 = hashTree(c.installed)
  writeJSON(join(c.directory, 'manifest.json'), c.manifest)
  const lines: string[] = []
  const log = console.log
  console.log = line => { lines.push(String(line)) }
  try {
    assert.equal(await run(c.directory, { baseUrl: 'https://staging.example.invalid/service/v1', apiKey: 'zct_SYNTHETIC_INPUT_ONLY', confirmed: true }), 0)
  } finally { console.log = log }
  const output = lines.join('\n')
  assert.match(output, /RUN  Read model catalog/)
  assert.match(output, /PASS Read model catalog \([\d.]+ms\)/)
  assert.match(output, /10 passed, 0 failed, 0 skipped/)
  assert.match(output, /Cleanup: complete/)
  for (const secret of ['zct_SYNTHETIC_INPUT_ONLY', 'synthetic-private-child-error', 'synthetic-private-reply', 'agt_SYNTHETIC']) assert.equal(output.includes(secret), false)
  const record = JSON.parse(readFileSync(join(c.directory, 'live-result.json'), 'utf8'))
  assert.equal(record.steps.length, 10)
  assert.ok(record.steps.every((step: { status: string }) => step.status === 'passed'))
  assert.equal(verifyPassed(c.directory).run_id, 'synthetic')
})
