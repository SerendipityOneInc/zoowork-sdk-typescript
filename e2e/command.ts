import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { CheckError, check, privateDir, safeFailure } from './guard.ts'
import { prepare, run } from './runner.ts'

export const STAGING_BASE_URL = 'https://claw-interface.ecap.yesy.live/service/v1'

/** Raw terminal input: no echo, no shell history, and restore the terminal on cancellation. */
export function hiddenInput(label: string, input = process.stdin, output = process.stderr): Promise<string> {
  check(input.isTTY && output.isTTY, 'interactive_terminal_required')
  return new Promise((resolve, reject) => {
    let value = ''
    let finished = false
    const wasRaw = input.isRaw
    const wasFlowing = input.readableFlowing === true
    const finish = (error?: CheckError) => {
      if (finished) return
      finished = true
      input.off('data', data).off('end', cancel).off('close', cancel).off('error', cancel)
      process.off('SIGINT', cancel).off('SIGTERM', cancel)
      try {
        input.setRawMode(wasRaw)
        if (!wasFlowing) input.pause()
        output.write('\n')
      } catch { error ??= new CheckError('terminal_restore_failed') }
      if (error) reject(error)
      else resolve(value)
      value = ''
    }
    const cancel = () => finish(new CheckError('input_cancelled'))
    const data = (chunk: Buffer | string) => {
      for (const char of chunk.toString()) {
        if (char === '\u0003' || char === '\u0004' || char === '\u001a') { cancel(); return }
        if (char === '\r' || char === '\n') { finish(); return }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
        else if (char >= ' ' && char <= '~') value += char
        if (value.length >= 4096) { finish(new CheckError('credential_input_too_large')); return }
      }
    }
    input.on('data', data).once('end', cancel).once('close', cancel).once('error', cancel)
    process.once('SIGINT', cancel).once('SIGTERM', cancel)
    try {
      input.setRawMode(true)
      output.write(label)
      input.resume()
    } catch { finish(new CheckError('terminal_input_unavailable')) }
  })
}

interface Options { baseUrl?: string; outDir?: string; model?: string; confirmed?: boolean; keyStdin?: boolean }
interface Services {
  env: NodeJS.ProcessEnv; terminal: boolean; stdin: AsyncIterable<Buffer | string>;
  prompt: (label: string) => Promise<string>; output: (message: string) => void;
  newDirectory: () => string; prepare: typeof prepare; run: typeof run;
}
function services(): Services {
  return { env: process.env, terminal: Boolean(process.stdin.isTTY && process.stderr.isTTY), stdin: process.stdin,
    prompt: hiddenInput, output: message => { process.stderr.write(message + '\n') }, prepare, run,
    newDirectory: () => join(privateDir(join(homedir(), '.local/state/zoowork-sdk/e2e')), randomUUID()),
  }
}

/** One preparation and one authorized attempt; publication is deliberately not part of this entrypoint. */
export async function testE2E(options: Options, io: Services = services()): Promise<number> {
  let apiKey = (io.env.ZOOWORK_API_KEY ?? '').trim()
  delete io.env.ZOOWORK_API_KEY
  try {
    // Do not inherit ZOOWORK_BASE_URL: an ordinary SDK environment may point at production.
    const base = new URL(options.baseUrl ?? STAGING_BASE_URL)
    check(base.protocol === 'https:' && !base.username && !base.password && !base.search && !base.hash
      && base.pathname.replace(/\/$/, '') === '/service/v1', 'staging_public_https_url_required')
    check(options.confirmed || (io.terminal && !options.keyStdin), 'noninteractive_run_requires_confirm_staging')
    if (options.keyStdin) {
      apiKey = ''
      for await (const chunk of io.stdin) { apiKey += chunk; check(apiKey.length < 4096, 'credential_input_too_large') }
      apiKey = apiKey.trim()
    }
    check(apiKey || io.terminal, 'provide_ZOOWORK_API_KEY_or_api_key_stdin')
    if (apiKey) check(/^zct_[A-Za-z0-9_-]+$/.test(apiKey), 'invalid_key_format')
    io.output(`Staging: ${base.origin}/service/v1\nThis test creates one temporary Agent/Session, runs one potentially billable model turn, then cleans up. It never publishes.`)
    const directory = options.outDir ?? io.newDirectory()
    io.output(`Preparing candidate and retaining results in: ${directory}`)
    io.prepare(directory)
    if (!apiKey) apiKey = (await io.prompt('Staging API key (hidden; Enter authorizes the test above; Ctrl+C cancels): ')).trim()
    else if (!options.confirmed) check(await io.prompt('Key supplied by environment. Press Enter to authorize the test above; Ctrl+C cancels: ') === '', 'input_cancelled')
    check(/^zct_[A-Za-z0-9_-]+$/.test(apiKey), 'invalid_key_format')
    // run() rechecks the installed SDK's production endpoint, candidate integrity and one-attempt rule.
    const code = await io.run(directory, { baseUrl: base.href, apiKey, model: options.model, confirmed: true })
    io.output(code === 0 ? `E2E passed; not published. Candidate: ${directory}`
      : `E2E failed; not published. Review results and cleanup before another attempt: ${directory}`)
    return code
  } finally { apiKey = '' }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    'base-url': { type: 'string' }, 'out-dir': { type: 'string' }, model: { type: 'string' },
    'confirm-staging': { type: 'boolean' }, 'api-key-stdin': { type: 'boolean' }, help: { type: 'boolean' },
  } })
  if (values.help) {
    console.log(`pnpm test:e2e [--base-url HTTPS_SERVICE_V1] [--out-dir NEW_PRIVATE_DIR] [--model ID]\nDefault staging: ${STAGING_BASE_URL}\nEnter the key at the hidden terminal prompt, or supply ZOOWORK_API_KEY.\nNoninteractive: add --confirm-staging; --api-key-stdin accepts a secure pipe.\nAutomatically prepares, tests and cleans up. Never publishes. Node 22.20+.`)
    return
  }
  process.exitCode = await testE2E({ baseUrl: values['base-url'], outDir: values['out-dir'], model: values.model,
    confirmed: values['confirm-staging'], keyStdin: values['api-key-stdin'] })
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ passed: false, failure: safeFailure(error) })); process.exitCode = 1 })
}
