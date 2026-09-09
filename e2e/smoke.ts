import type * as SDK from '@zoowork-ai/sdk'
import { check, safeFailure } from './guard.ts'

type PublicSDK = typeof SDK
export interface SmokeRecord {
  schema_version: 1; run_id: string; phase: string; passed: boolean;
  checks: string[]; failure?: ReturnType<typeof safeFailure>;
  cleanup: { complete: boolean; steps: { step: string; passed: boolean; failure?: ReturnType<typeof safeFailure> }[] };
  resources: { agent_id?: string; session_id?: string; creation_uncertain: boolean; session_creation_uncertain: boolean };
}
export async function smoke(sdk: PublicSDK, client: SDK.ZooworkClient, options: {
  runId: string; model?: string; signal: AbortSignal;
  cleanupMode: () => void; save: (record: SmokeRecord) => void;
}): Promise<SmokeRecord> {
  const record: SmokeRecord = { schema_version: 1, run_id: options.runId, phase: 'models', passed: false,
    checks: [], cleanup: { complete: false, steps: [] }, resources: { creation_uncertain: false, session_creation_uncertain: false } }
  const save = () => options.save(structuredClone(record))
  let writeFailed = false
  const safeSave = () => { try { save() } catch { writeFailed = true } }
  let creationStarted = false
  let failure = false
  const label = { sdk_e2e_run: options.runId }
  const name = `sdk-e2e-${options.runId}`
  const ownAgent = (id: unknown): string => {
    check(typeof id === 'string' && /^agt_[A-Za-z0-9_-]{1,120}$/.test(id), 'invalid_created_agent_id')
    return id
  }
  const ownSession = (id: unknown): string => {
    check(typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) && !id.startsWith('zct_'), 'invalid_created_session_id')
    return id
  }
  const stage = (phase: string) => { options.signal.throwIfAborted(); record.phase = phase; save() }
  try {
    stage('models')
    const models = await client.listModels()
    const model = options.model ?? models[0]?.model
    check(model && models.some(m => m.model === model), 'requested_model_unavailable')
    record.checks.push('model_catalog')
    stage('create_agent')
    creationStarted = true
    record.resources.creation_uncertain = true
    save()
    const agent = await client.createAgent({ resource: { name, model: { primary: model, max_tokens: 2048 }, labels: label } }, options.runId)
    record.resources.agent_id = ownAgent(agent.agent_id)
    record.resources.creation_uncertain = false
    save()
    stage('start_agent')
    await client.startAgent(record.resources.agent_id)
    await client.waitUntilRunning(record.resources.agent_id, { timeoutMs: 30_000, signal: options.signal })
    record.checks.push('agent_lifecycle')
    stage('create_session')
    record.resources.session_creation_uncertain = true
    save()
    const session = await client.createSession(record.resources.agent_id, {
      metadata: { source: 'sdk-release-e2e', run_id: options.runId },
      initial_events: [{ type: 'user.message', content: 'Reply with SDK_E2E_OK only. Do not call tools or create schedules.' }],
    }, options.runId + '-session')
    record.resources.session_id = ownSession(session.session_id)
    record.resources.session_creation_uncertain = false
    save()
    stage('stream_turn')
    let text = ''
    let succeeded = false
    let count = 0
    for await (const event of client.streamEvents(record.resources.agent_id, record.resources.session_id, { signal: options.signal })) {
      check(++count <= 500, 'event_budget_exceeded')
      text += sdk.assistantText(event)
      if (sdk.isRunFinished(event)) { succeeded = sdk.runOutcome(event) === 'succeeded'; break }
    }
    check(succeeded, 'turn_did_not_succeed')
    check(text.trim().length > 0, 'empty_assistant_reply')
    record.checks.push('successful_streamed_turn')
    stage('rest_replay')
    const durable = await client.listAllEvents(record.resources.agent_id, record.resources.session_id)
    check(durable.some(e => sdk.isRunFinished(e) && sdk.runOutcome(e) === 'succeeded'), 'rest_missing_successful_turn')
    check(durable.map(sdk.assistantText).join('').trim() === text.trim(), 'rest_stream_mismatch')
    record.checks.push('rest_sse_agreement')
  } catch (error) { failure = true; record.failure = safeFailure(error) }
  finally {
    options.cleanupMode()
    const failedPhase = record.phase
    record.phase = 'cleanup'
    safeSave()
    async function clean(step: string, fn: () => Promise<void>, notFoundOK = false) {
      try { await fn(); record.cleanup.steps.push({ step, passed: true }) }
      catch (error) {
        if (notFoundOK && (error as { status?: number })?.status === 404) record.cleanup.steps.push({ step, passed: true })
        else record.cleanup.steps.push({ step, passed: false, failure: safeFailure(error) })
      }
      safeSave()
    }
    if (creationStarted && !record.resources.agent_id) {
      // Do not repeat POST on uncertain creation. Only inspect the unique run label; never list/delete the tenant broadly.
      await clean('recover_created_agent', async () => {
        const found = await client.listAgents({ labels: label })
        check(found.length === 1, 'creation_uncertain_manual_lookup_required')
        const declared = found[0].declared as { name?: string; labels?: Record<string, string> } | undefined
        check(declared?.name === name && declared.labels?.sdk_e2e_run === options.runId, 'recovery_ownership_unverified')
        record.resources.agent_id = ownAgent(found[0].agent_id)
        record.resources.creation_uncertain = false
      })
    }
    const agentId = record.resources.agent_id
    if (agentId) {
      if (record.resources.session_creation_uncertain) await clean('recover_created_session', async () => {
        const sessions = await client.listSessions(agentId)
        const own = sessions.filter(s => (s.metadata as Record<string, unknown> | undefined)?.run_id === options.runId)
        check(own.length === 1, 'session_creation_uncertain_manual_lookup_required')
        record.resources.session_id = ownSession(own[0].session_id)
        record.resources.session_creation_uncertain = false
      })
      if (record.resources.session_id) await clean('delete_session', () => client.deleteSession(agentId, record.resources.session_id!), true)
      await clean('stop_agent', async () => { await client.stopAgent(agentId) }, true)
      await clean('delete_agent', () => client.deleteAgent(agentId), true)
      await clean('confirm_agent_unavailable', async () => {
        try { await client.getAgent(agentId) } catch (error) {
          if ((error as { status?: number })?.status === 404) return
          throw error
        }
        check(false, 'deleted_agent_still_available')
      })
    }
    record.cleanup.complete = !record.resources.creation_uncertain && !record.resources.session_creation_uncertain && record.cleanup.steps.every(s => s.passed)
    record.passed = !failure && !writeFailed && record.cleanup.complete
    record.phase = record.passed ? 'complete' : failedPhase
    safeSave()
    if (writeFailed) { record.passed = false; record.failure = { kind: 'record_write_failed' } }
  }
  return record
}
