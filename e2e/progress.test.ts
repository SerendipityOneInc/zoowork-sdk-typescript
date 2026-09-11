// Synthetic ledger snapshots only. No API requests or proof of a live pass.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LiveProgress } from './progress.ts'

test('live progress prints running and completed cases once, with durations', () => {
  const lines: string[] = []
  const progress = new LiveProgress(line => lines.push(line))
  const running = { steps: [{ id: 'models', status: 'running', duration_ms: 0 }] }
  progress.observe(running); progress.observe(running)
  const passed = { steps: [{ id: 'models', status: 'passed', duration_ms: 1250 }], cleanup: { complete: true } }
  progress.observe(passed); progress.observe(passed)
  progress.finish(passed, true, 1500)
  assert.equal(lines.filter(line => line.includes('Read model catalog')).length, 2)
  assert.ok(lines.includes('  RUN  Read model catalog'))
  assert.ok(lines.includes('  PASS Read model catalog (1.25s)'))
  assert.match(lines.join('\n'), /1 passed, 0 failed, 0 skipped \(1.50s\)/)
  assert.ok(lines.includes('Cleanup: complete'))
  assert.match(lines.join('\n'), /NOT COVERED: live pagination beyond 100 agents/)
})
test('failed steps, skipped cases and cleanup failures are distinct from a pass', () => {
  const lines: string[] = []
  new LiveProgress(line => lines.push(line)).finish({ cleanup: { complete: false }, steps: [
    { id: 'stream_turn', status: 'failed', duration_ms: 200, failure: { kind: 'http_failure', http_status: 503 } },
    { id: 'rest_replay', status: 'skipped', duration_ms: 0, reason: 'previous_step_failed' },
    { id: 'delete_session', status: 'failed', duration_ms: 30, failure: { kind: 'timeout_or_cancelled' } },
    { id: 'stop_agent', status: 'passed', duration_ms: 20 },
  ] }, false, 300)
  const output = lines.join('\n')
  assert.match(output, /FAIL Receive a successful streamed model reply \(200ms\) — HTTP 503/)
  assert.match(output, /SKIP Match REST history with SSE reply — earlier step failed/)
  assert.match(output, /FAIL Delete temporary session \(30ms\) — timed out or cancelled/)
  assert.match(output, /1 passed, 2 failed, 1 skipped/)
  assert.match(output, /Cleanup: incomplete or unverified/)
})
test('arbitrary record strings, resource IDs, API bodies and malformed steps are never displayed', () => {
  const sentinel = 'synthetic-sensitive-value-do-not-emit'
  const lines: string[] = []
  new LiveProgress(line => lines.push(line)).finish({ resources: { agent_id: sentinel }, body: sentinel, steps: [
    { id: sentinel, status: 'failed', duration_ms: 1 },
    { id: 'models', status: sentinel, duration_ms: 1 },
    { id: 'models', status: 'passed', duration_ms: sentinel },
    { id: 'models', status: 'failed', duration_ms: 1, label: sentinel, failure: { kind: sentinel, http_status: sentinel } },
    { id: 'delete_session', status: 'skipped', duration_ms: 0, reason: sentinel },
  ] }, false, 2)
  assert.equal(lines.join('\n').includes(sentinel), false)
  assert.match(lines.join('\n'), /request or check failed; see result.json/)
  assert.match(lines.join('\n'), /no resource ID available for cleanup/)
})
test('missing or incomplete runner evidence is reported as failure even without a failed case', () => {
  for (const record of [undefined, {}, { steps: [{ id: 'models', status: 'running', duration_ms: 0 }] }]) {
    const lines: string[] = []
    new LiveProgress(line => lines.push(line)).finish(record, false, 10)
    assert.match(lines.join('\n'), /FAIL Live staging smoke/)
    assert.match(lines.join('\n'), /Runner or result verification failed/)
    assert.match(lines.join('\n'), /Cleanup: incomplete or unverified/)
  }
})
