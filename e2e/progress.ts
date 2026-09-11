/** Static labels only: live responses, resource IDs and exception text never reach the terminal. */
export const MAIN_STEPS = ['models', 'create_agent', 'start_agent', 'create_session', 'stream_turn', 'rest_replay'] as const
const labels = {
  models: 'Read model catalog', create_agent: 'Create temporary agent', start_agent: 'Start agent and wait for readiness',
  create_session: 'Create session with initial message', stream_turn: 'Receive a successful streamed model reply',
  rest_replay: 'Match REST history with SSE reply', recover_created_agent: 'Recover uncertain agent creation',
  recover_created_session: 'Recover uncertain session creation', delete_session: 'Delete temporary session',
  stop_agent: 'Stop temporary agent', delete_agent: 'Delete temporary agent',
  confirm_agent_unavailable: 'Confirm deleted agent returns 404',
} as const
export type StepId = keyof typeof labels
export interface SmokeStep {
  id: StepId; status: 'running' | 'passed' | 'failed' | 'skipped'; duration_ms: number;
  reason?: 'previous_step_failed' | 'resource_unavailable';
  failure?: { kind: string; http_status?: number };
}
export function elapsed(milliseconds: number): string {
  return milliseconds < 1000 ? `${Math.round(milliseconds)}ms` : `${(milliseconds / 1000).toFixed(2)}s`
}
function failureLabel(failure?: SmokeStep['failure']): string {
  const status = failure?.http_status
  if (Number.isInteger(status) && status! >= 100 && status! <= 599) return `HTTP ${status}`
  const known: Record<string, string> = {
    timeout_or_cancelled: 'timed out or cancelled', requested_model_unavailable: 'requested model unavailable',
    turn_did_not_succeed: 'model turn did not succeed', empty_assistant_reply: 'empty assistant reply',
    rest_missing_successful_turn: 'REST history missing successful turn', rest_stream_mismatch: 'REST/SSE reply mismatch',
    deleted_agent_still_available: 'deleted agent is still readable', record_write_failed: 'result record could not be written',
  }
  return failure && Object.hasOwn(known, failure.kind) ? known[failure.kind] : 'request or check failed; see result.json'
}
function stepsFrom(record: unknown): SmokeStep[] {
  const steps = (record as { steps?: unknown } | undefined)?.steps
  if (!Array.isArray(steps)) return []
  // Read the atomically saved ledger, but never forward arbitrary strings from it.
  return steps.filter((step): step is SmokeStep => step && Object.hasOwn(labels, step.id)
    && ['running', 'passed', 'failed', 'skipped'].includes(step.status)
    && Number.isFinite(step.duration_ms) && step.duration_ms >= 0)
}
export class LiveProgress {
  private seen = new Map<StepId, SmokeStep['status']>()
  private output: (line: string) => void
  constructor(output: (line: string) => void = console.log) { this.output = output }
  observe(record: unknown): void {
    for (const step of stepsFrom(record)) {
      if (this.seen.get(step.id) === step.status) continue
      this.seen.set(step.id, step.status)
      const status = { running: 'RUN ', passed: 'PASS', failed: 'FAIL', skipped: 'SKIP' }[step.status]
      let detail = step.status === 'running' ? '' : ` (${elapsed(step.duration_ms)})`
      if (step.status === 'failed') detail += ` — ${failureLabel(step.failure)}`
      if (step.status === 'skipped') detail = step.reason === 'previous_step_failed'
        ? ' — earlier step failed' : ' — no resource ID available for cleanup'
      this.output(`  ${status} ${labels[step.id]}${detail}`)
    }
  }
  finish(record: unknown, passed: boolean, durationMs: number): void {
    this.observe(record)
    const steps = stepsFrom(record)
    const count = (status: SmokeStep['status']) => steps.filter(step => step.status === status).length
    this.output(`${passed ? 'PASS' : 'FAIL'} Live staging smoke: ${count('passed')} passed, ${count('failed')} failed, ${count('skipped')} skipped (${elapsed(durationMs)})`)
    if (!passed && count('failed') === 0) this.output('  Runner or result verification failed; inspect the retained reports.')
    const cleanup = (record as { cleanup?: { complete?: unknown } } | undefined)?.cleanup?.complete === true
    this.output(`Cleanup: ${cleanup ? 'complete' : 'incomplete or unverified'}`)
    this.output('NOT COVERED: live pagination beyond 100 agents (offline cases cover this); full API coverage; production compatibility.')
  }
}
