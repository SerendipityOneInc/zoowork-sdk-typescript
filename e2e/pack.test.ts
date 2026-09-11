// Offline npm dry-run only: no credentials, staging calls or registry publication.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'))
test('npm publish dry-run builds a clean package without E2E code, reports or credentials', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdk-publish-dry-run-'))
  const checkout = join(directory, 'checkout')
  mkdirSync(checkout)
  for (const name of ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'tsconfig.json', 'tsconfig.build.json']) {
    copyFileSync(join(root, name), join(checkout, name))
  }
  cpSync(join(root, 'src'), join(checkout, 'src'), { recursive: true })
  symlinkSync(join(root, 'node_modules'), join(checkout, 'node_modules'), 'junction')
  mkdirSync(join(checkout, 'dist'))
  writeFileSync(join(checkout, 'dist/stale.test.js'), '// stale generated test must not be published\n')
  for (const name of ['user.npmrc', 'global.npmrc']) writeFileSync(join(directory, name), '', { mode: 0o600 })
  const result = spawnSync('npm', ['publish', '--dry-run', '--offline', '--json'], {
    cwd: checkout, encoding: 'utf8', timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: homedir(), LANG: 'C',
      npm_config_userconfig: join(directory, 'user.npmrc'), npm_config_globalconfig: join(directory, 'global.npmrc'),
      npm_config_cache: join(directory, 'cache'), npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' },
  })
  assert.equal(result.status, 0, result.stderr)
  const resultJSON = JSON.parse(result.stdout)
  // npm versions return either pack metadata directly or a map keyed by package name.
  const packed = (Array.isArray(resultJSON) ? resultJSON : [resultJSON['@zoowork-ai/sdk'] ?? resultJSON]) as { version: string; files: { path: string }[] }[]
  assert.equal(packed.length, 1)
  assert.equal(packed[0].version, JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version)
  const paths = packed[0].files.map(file => file.path)
  assert.ok(paths.includes('dist/index.js') && paths.includes('dist/index.d.ts'))
  assert.ok(paths.every(path => ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE'].includes(path)
    || /^dist\/[A-Za-z0-9_/-]+(?:\.js|\.d\.ts)$/.test(path)), paths.join('\n'))
  assert.equal(existsSync(join(checkout, 'dist/stale.test.js')), false)
  assert.equal(existsSync(join(checkout, 'e2e')), false)
  assert.equal(existsSync(join(checkout, 'manifest.json')), false)
  assert.equal(existsSync(join(checkout, 'result.json')), false)
})
