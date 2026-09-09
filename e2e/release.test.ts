// Synthetic release records only; not captured API fixtures or proof of a live pass.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hash, hashTree, writeJSON } from './guard.ts'
import { fingerprint, publishCandidate, verifyCandidate, verifyPassed } from './release.ts'
import type { Manifest } from './release.ts'

const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'))
function candidate() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'sdk-release-record-test-')))
  const consumer = join(directory, 'consumer')
  const installed = join(consumer, 'node_modules/@zoowork-ai/sdk')
  mkdirSync(installed, { recursive: true })
  writeFileSync(join(installed, 'index.js'), 'export const synthetic = true\n')
  writeFileSync(join(directory, 'synthetic.tgz'), 'synthetic artifact, not a package')
  for (const name of ['live.ts', 'smoke.ts', 'guard.ts']) writeFileSync(join(consumer, name), '// synthetic\n')
  const manifest: Manifest = { schema_version: 1, run_id: 'synthetic', package_name: '@zoowork-ai/sdk', version: '0.0.0-test',
    source: { root, head: 'synthetic', fingerprint: fingerprint(root) }, tarball: 'synthetic.tgz',
    tarball_sha256: hash(readFileSync(join(directory, 'synthetic.tgz'))),
    runner_sha256: hash(['live.ts', 'smoke.ts', 'guard.ts'].map(name => name + '\0' + hash(readFileSync(join(consumer, name)))).join('\0')),
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
test('manual publication requires confirmation, a live pass and complete cleanup before invoking npm', () => {
  const c = candidate()
  const published: string[] = []
  const publish = (tarball: string) => { published.push(tarball) }
  assert.throws(() => publishCandidate(c.directory, false, publish), /explicit_publish_confirmation_required/)
  assert.throws(() => publishCandidate(c.directory, true, publish))
  for (const changes of [{ staging_smoke_passed: false }, { cleanup_complete: false }]) {
    writeJSON(join(c.directory, 'result.json'), { ...c.result, ...changes })
    assert.throws(() => publishCandidate(c.directory, true, publish))
  }
  assert.deepEqual(published, [])
  writeJSON(join(c.directory, 'result.json'), c.result)
  assert.equal(publishCandidate(c.directory, true, publish).run_id, c.manifest.run_id)
  assert.deepEqual(published, [join(c.directory, c.manifest.tarball)])
})
test('changed candidate cannot reach the publisher even with a recorded live pass', () => {
  const c = candidate()
  writeJSON(join(c.directory, 'result.json'), c.result)
  writeFileSync(join(c.directory, c.manifest.tarball), 'changed after E2E')
  let called = false
  assert.throws(() => publishCandidate(c.directory, true, () => { called = true }))
  assert.equal(called, false)
})
test('directory prepublish hook refuses with a release command instead of calling live APIs', () => {
  const result = spawnSync(process.execPath, [join(root, 'e2e/release.ts'), 'prepublish'], {
    cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10_000,
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Directory publication is disabled/)
})
