// Synthetic credentials and stubbed preparation/live execution only. No network or publication.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { hiddenInput, STAGING_BASE_URL, testE2E } from './command.ts'
import { CheckError } from './guard.ts'

const syntheticKey = 'zct_SYNTHETIC_NOT_A_CREDENTIAL'
function fixture() {
  const calls: string[] = []
  const output: string[] = []
  const prompts: string[] = []
  const io = {
    env: {} as NodeJS.ProcessEnv, terminal: true, stdin: (async function* () { yield syntheticKey })(),
    prompt: async (label: string) => { prompts.push(label); calls.push('prompt'); return syntheticKey },
    output: (message: string) => { output.push(message) },
    newDirectory: () => '/synthetic/private/candidate',
    prepare: (directory: string) => { assert.equal(io.env.ZOOWORK_API_KEY, undefined); calls.push('prepare'); return directory },
    run: async (directory: string, input: { baseUrl: string; apiKey: string; model?: string; confirmed: boolean }) => {
      calls.push('run'); assert.equal(directory, '/synthetic/private/candidate')
      assert.equal(input.apiKey, syntheticKey); assert.equal(input.confirmed, true); return 0
    },
  }
  return { io, calls, output, prompts }
}
test('one command prepares then prompts then runs once; defaults to staging, not the ambient SDK URL', async () => {
  const f = fixture()
  f.io.env.ZOOWORK_BASE_URL = 'https://production.invalid/service/v1'
  const run = f.io.run
  f.io.run = async (directory, input) => { assert.equal(input.baseUrl, STAGING_BASE_URL); return run(directory, input) }
  assert.equal(await testE2E({}, f.io), 0)
  assert.deepEqual(f.calls, ['prepare', 'prompt', 'run'])
  assert.match(f.prompts[0], /Enter authorizes/)
  assert.match(f.output.join('\n'), /potentially billable/)
  assert.match(f.output.join('\n'), /E2E passed; not published/)
  assert.ok(!f.output.join('\n').includes(syntheticKey))
})
test('environment key is removed before preparation; an interactive run still needs consent', async () => {
  const f = fixture()
  f.io.env.ZOOWORK_API_KEY = syntheticKey
  f.io.prompt = async label => { assert.match(label, /Press Enter to authorize/); f.calls.push('consent'); return '' }
  assert.equal(await testE2E({}, f.io), 0)
  assert.deepEqual(f.calls, ['prepare', 'consent', 'run'])
  assert.equal(f.io.env.ZOOWORK_API_KEY, undefined)
})
test('noninteractive runs refuse missing consent or credentials before any preparation', async () => {
  const f = fixture(); f.io.terminal = false; f.io.env.ZOOWORK_API_KEY = syntheticKey
  await assert.rejects(testE2E({}, f.io), /noninteractive_run_requires_confirm_staging/)
  assert.equal(f.io.env.ZOOWORK_API_KEY, undefined)
  await assert.rejects(testE2E({ confirmed: true }, f.io), /provide_ZOOWORK_API_KEY_or_api_key_stdin/)
  assert.deepEqual(f.calls, [])
})
test('confirmed environment and secure stdin paths need no prompt and forward endpoint/model overrides', async () => {
  for (const keyStdin of [false, true]) {
    const f = fixture(); f.io.terminal = false; f.io.env.ZOOWORK_API_KEY = keyStdin ? 'ignored' : syntheticKey
    const run = f.io.run
    f.io.run = async (directory, input) => {
      assert.equal(input.baseUrl, 'https://staging.example/service/v1'); assert.equal(input.model, 'synthetic-model')
      return run(directory, input)
    }
    assert.equal(await testE2E({ confirmed: true, keyStdin, baseUrl: 'https://staging.example/service/v1',
      model: 'synthetic-model', outDir: '/synthetic/private/candidate' }, f.io), 0)
    assert.deepEqual(f.calls, ['prepare', 'run'])
  }
})
test('invalid key, unsafe URL and oversized stdin fail without preparation or live calls', async () => {
  const f = fixture(); f.io.env.ZOOWORK_API_KEY = 'invalid'
  await assert.rejects(testE2E({}, f.io), /invalid_key_format/)
  await assert.rejects(testE2E({ baseUrl: 'https://user:password@staging.example/service/v1' }, f.io), /staging_public_https_url_required/)
  f.io.stdin = (async function* () { yield 'x'.repeat(4096) })()
  await assert.rejects(testE2E({ confirmed: true, keyStdin: true }, f.io), /credential_input_too_large/)
  assert.deepEqual(f.calls, [])
})
test('preparation failure or prompt cancellation never starts a live attempt', async () => {
  const f = fixture()
  f.io.prepare = () => { throw new CheckError('offline_check_failed') }
  await assert.rejects(testE2E({}, f.io), /offline_check_failed/)
  assert.deepEqual(f.calls, [])
  const g = fixture(); g.io.prompt = async () => { throw new CheckError('input_cancelled') }
  await assert.rejects(testE2E({}, g.io), /input_cancelled/)
  assert.deepEqual(g.calls, ['prepare'])
})
test('failed live execution is not retried or marked passed, and retained results are shown', async () => {
  const f = fixture(); f.io.run = async () => { f.calls.push('run'); return 1 }
  assert.equal(await testE2E({}, f.io), 1)
  assert.deepEqual(f.calls, ['prepare', 'prompt', 'run'])
  assert.match(f.output.join('\n'), /E2E failed; not published/)
  assert.match(f.output.join('\n'), /\/synthetic\/private\/candidate/)
})
function terminal() {
  const stream = new PassThrough()
  const raw: boolean[] = []
  const input = Object.assign(stream, { isTTY: true, isRaw: false, setRawMode(value: boolean) { raw.push(value); this.isRaw = value; return this } })
  const output = Object.assign(new PassThrough(), { isTTY: true })
  let displayed = ''; output.on('data', chunk => { displayed += chunk.toString() })
  return { input: input as unknown as typeof process.stdin, output: output as unknown as typeof process.stderr,
    raw, displayed: () => displayed }
}
test('hidden prompt accepts a key and backspace without echo, then restores terminal state/listeners', async () => {
  const t = terminal()
  const pending = hiddenInput('Hidden key: ', t.input, t.output)
  t.input.emit('data', syntheticKey + 'x\u007f\r')
  assert.equal(await pending, syntheticKey)
  assert.deepEqual(t.raw, [true, false]); assert.equal(t.input.isPaused(), true)
  assert.equal(t.input.listenerCount('data'), 0)
  assert.equal(t.displayed(), 'Hidden key: \n')
})
test('hidden prompt restores the terminal on Ctrl+C, EOF and oversized input without echo', async () => {
  for (const action of ['cancel', 'end', 'oversize']) {
    const t = terminal(); const pending = hiddenInput('Hidden key: ', t.input, t.output)
    if (action === 'end') t.input.emit('end')
    else t.input.emit('data', action === 'cancel' ? syntheticKey + '\u0003' : 'x'.repeat(4096))
    await assert.rejects(pending, /input_cancelled|credential_input_too_large/)
    assert.deepEqual(t.raw, [true, false]); assert.equal(t.input.listenerCount('data'), 0)
    assert.equal(t.displayed(), 'Hidden key: \n')
  }
})
test('hidden prompt preserves an already raw/flowing terminal and cleans up after setup failure', async () => {
  const t = terminal(); t.input.isRaw = true; t.input.resume()
  const pending = hiddenInput('Hidden key: ', t.input, t.output)
  t.input.emit('data', '\r'); assert.equal(await pending, '')
  assert.deepEqual(t.raw, [true, true]); assert.equal(t.input.isPaused(), false)
  t.input.pause()
  const broken = terminal()
  broken.input.setRawMode = () => { throw new Error('synthetic terminal error') }
  await assert.rejects(hiddenInput('Hidden key: ', broken.input, broken.output), /terminal_input_unavailable/)
  assert.equal(broken.input.listenerCount('data'), 0)
})
test('CLI help is offline and a missing noninteractive credential exits safely', () => {
  const command = fileURLToPath(new URL('./command.ts', import.meta.url))
  for (const args of [['--help'], ['--confirm-staging']]) {
    const result = spawnSync(process.execPath, [command, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10_000 })
    assert.equal(result.status, args[0] === '--help' ? 0 : 1)
    assert.match(result.stdout + result.stderr, args[0] === '--help' ? /Never publishes/ : /provide_ZOOWORK_API_KEY_or_api_key_stdin/)
  }
})
