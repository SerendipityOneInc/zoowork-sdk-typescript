// Executed ONLY from an isolated consumer with the packed SDK installed.
import * as sdk from '@zoowork-ai/sdk'
import { baseURL, check, guardedFetch, safeFailure, writeJSON } from './guard.ts'
import { smoke } from './smoke.ts'
import { join } from 'node:path'

let buffer = ''
try {
  for await (const chunk of process.stdin) { buffer += chunk; check(buffer.length < 16_384, 'input_too_large') }
  const input = JSON.parse(buffer) as { apiKey: string; baseUrl: string; model?: string; runId: string; directory: string }
  buffer = ''
  check(typeof input.apiKey === 'string' && /^zct_[A-Za-z0-9_-]+$/.test(input.apiKey), 'invalid_key_format')
  const base = baseURL(input.baseUrl, sdk.DEFAULT_BASE_URL)
  const abort = new AbortController()
  const cancel = () => abort.abort()
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel)
  const runSignal = AbortSignal.any([abort.signal, AbortSignal.timeout(180_000)])
  let active = runSignal
  let cleaning = false
  const client = sdk.createZooworkClient({ baseUrl: base, apiKey: input.apiKey,
    fetch: guardedFetch(base, () => active, fetch, () => cleaning) })
  input.apiKey = ''
  const result = await smoke(sdk, client, { runId: input.runId, model: input.model, signal: runSignal,
    cleanupMode: () => { cleaning = true; active = AbortSignal.timeout(60_000) },
    save: record => writeJSON(join(input.directory, 'live-result.json'), record),
  })
  process.off('SIGINT', cancel); process.off('SIGTERM', cancel)
  console.log(JSON.stringify({ passed: result.passed, phase: result.phase, checks: result.checks,
    failure: result.failure, cleanup_complete: result.cleanup.complete }))
  process.exitCode = result.passed ? 0 : 1
} catch (error) {
  buffer = ''
  console.log(JSON.stringify({ passed: false, failure: safeFailure(error) }))
  process.exitCode = 1
}
