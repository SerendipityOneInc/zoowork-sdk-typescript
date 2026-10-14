import type { ThinkingLevel, ZooworkClient } from '@zoowork-ai/sdk'
import { check, safeFailure } from './guard.ts'

export interface ThinkingRecord {
  run_id: string
  passed: boolean
  checks: string[]
  model?: string
  default_level?: ThinkingLevel
  observations: { case: string; levels: ThinkingLevel[] }[]
  resources: { agent_id?: string; schedule_id?: string; sessions: string[]; creation_uncertain: boolean }
  failure?: ReturnType<typeof safeFailure>
  cleanup: { complete: boolean; steps: { step: string; passed: boolean; failure?: ReturnType<typeof safeFailure> }[] }
}
interface Options {
  runId: string
  model?: string
  signal: AbortSignal
  cleanupMode: () => void
  save: (record: ThinkingRecord) => void
  pollAttempts?: number
  delay?: () => Promise<void>
}

/** Four real turns on one throwaway Agent; never persists replies, prompts or server bodies. */
export async function thinkingSmoke(client: ZooworkClient, options: Options): Promise<ThinkingRecord> {
  const record: ThinkingRecord = { run_id: options.runId, passed: false, checks: [], observations: [],
    resources: { sessions: [], creation_uncertain: false }, cleanup: { complete: false, steps: [] } }
  const labels = { sdk_thinking_e2e: options.runId }
  const name = `sdk-thinking-${options.runId}`
  const delay = options.delay ?? (() => new Promise(resolve => setTimeout(resolve, 1000)))
  const attempts = options.pollAttempts ?? 120
  let agentId: string | undefined
  let scheduleId: string | undefined
  const sessions = new Set<string>()
  let cleaning = false
  const persist = () => {
    try { options.save(record) }
    catch {
      record.failure ??= { kind: 'record_write_failed' }
      record.passed = false
      // Recording errors stop new model calls but must never interrupt cleanup.
      if (!cleaning) check(false, 'record_write_failed')
    }
  }
  const passed = (value: string) => { record.checks.push(value); persist() }
  const remember = (id: string) => { sessions.add(id); record.resources.sessions = [...sessions]; persist() }

  async function completed(id: string, expected: ThinkingLevel, label: string): Promise<void> {
    remember(id)
    for (let attempt = 0; attempt < attempts; attempt++) {
      options.signal.throwIfAborted()
      const session = await client.getSession(agentId!, id, { history: true, limit: 200 })
      check(!['failed', 'aborted', 'cancelled'].includes(session.run_status ?? ''), `${label}_run_failed`)
      if (session.run_status === 'succeeded') {
        const entries = (session.history ?? []).map(row => row.entry).filter(entry =>
          entry.type === 'message' && (entry.message as { role?: string } | undefined)?.role === 'assistant')
        check(entries.length > 0, `${label}_missing_assistant_history`)
        const values = entries.map(entry => (entry.metadata as { thinking?: {
          level?: ThinkingLevel; forced?: boolean; clamped?: boolean; truncationRetry?: boolean
        } } | undefined)?.thinking)
        check(values.every(value => value !== undefined), `${label}_missing_thinking_metadata`)
        const first = values.filter(value => value && !value.truncationRetry)
        check(first.length > 0, `${label}_only_truncation_retries`)
        check(first.every(value => value!.level === expected && !value!.forced && !value!.clamped), `${label}_unexpected_level`)
        record.observations.push({ case: label, levels: first.map(value => value!.level!) })
        passed(label)
        return
      }
      await delay()
    }
    check(false, `${label}_timeout`)
  }
  async function direct(expected: ThinkingLevel, label: string): Promise<void> {
    const session = await client.createSession(agentId!, {
      metadata: { sdk_thinking_e2e: options.runId, case: label },
      initial_events: [{ type: 'user.message', content: 'Reply THINKING_E2E_OK only. Do not use tools, delegate, or create schedules.' }],
    }, `${options.runId}-${label}`)
    await completed(session.session_id, expected, label)
  }
  async function scheduled(expected: ThinkingLevel, label: string): Promise<void> {
    const before = new Set((await client.listSessions(agentId!)).map(session => session.session_id))
    check((await client.triggerSchedule(agentId!, scheduleId!)).triggered, `${label}_not_triggered`)
    for (let attempt = 0; attempt < attempts; attempt++) {
      options.signal.throwIfAborted()
      const runs = await client.listScheduleRuns(agentId!, scheduleId!, { limit: 20 })
      const rows = await client.listSessions(agentId!)
      for (const session of rows) remember(session.session_id)
      const linked = runs.find(run => run.session_id && !before.has(run.session_id))?.session_id
      const candidates = rows.filter(session => !before.has(session.session_id) && session.channel === 'cron'
        && session.session_key?.includes(`:cron:${scheduleId}:`))
      check(candidates.length <= 1, `${label}_ambiguous_session`)
      const id = linked ?? candidates[0]?.session_id
      if (id) { await completed(id, expected, label); return }
      await delay()
    }
    check(false, `${label}_dispatch_timeout`)
  }
  async function exercise(): Promise<void> {
    options.signal.throwIfAborted()
    const models = await client.listModels()
    const model = models.find(row => row.selectable !== false && (!options.model || row.model === options.model)
      && row.thinking && Array.isArray(row.thinking.levels)
      && (['off', 'low', 'medium', 'high', 'max'] as string[]).includes(row.thinking.default)
      && row.thinking.levels.includes(row.thinking.default) && ['low', 'high'].every(level => row.thinking!.levels.includes(level as ThinkingLevel))
      && row.thinking.default !== 'high')
    check(model?.thinking, 'thinking_test_model_or_capability_unavailable')
    record.model = model.model; record.default_level = model.thinking.default
    passed('thinking_catalog')
    record.resources.creation_uncertain = true; persist()
    const created = await client.createAgent({ resource: {
      name, labels, include_global_skills: false, model: { primary: model.model, thinking: 'high', max_tokens: 4096 },
    } }, options.runId)
    agentId = created.agent_id; record.resources.agent_id = agentId
    record.resources.creation_uncertain = false; persist()
    const initialModel = (await client.getAgent(agentId)).declared?.model as { thinking?: string } | undefined
    check(initialModel?.thinking === 'high', 'create_thinking_not_stored')
    passed('create_with_high')
    for (const level of ['off', 'low', 'medium', 'high', 'max'] as const) {
      await client.updateAgent(agentId, { model: { thinking: level } })
      const saved = (await client.getAgent(agentId)).declared?.model as { thinking?: string }
      check(saved?.thinking === level, 'thinking_update_not_stored')
    }
    passed('five_levels_set_and_read')
    await client.updateAgent(agentId, { model: { thinking: 'high' } })
    await client.startAgent(agentId); await client.waitUntilRunning(agentId, { timeoutMs: 30_000 })
    await direct('high', 'agent_high')
    await client.updateAgent(agentId, { model: { thinking: null } })
    const cleared = (await client.getAgent(agentId)).declared?.model as Record<string, unknown> | undefined
    check(cleared && !Object.hasOwn(cleared, 'thinking'), 'agent_null_not_cleared')
    passed('agent_null_clear')
    await direct(model.thinking.default, 'agent_default_after_clear')
    await client.updateAgent(agentId, { model: { thinking: 'high' } })
    scheduleId = `thinking-${options.runId}`; record.resources.schedule_id = scheduleId; persist()
    await client.createSchedule(agentId, {
      schedule_id: scheduleId, schedule: { kind: 'at', at: new Date(Date.now() + 7 * 86_400_000).toISOString() },
      payload: { kind: 'agentTurn', thinking: 'low', message: 'Reply THINKING_E2E_OK only. Do not use tools, delegate, or create schedules.' },
      sessionTarget: 'isolated', delivery: { mode: 'none' }, enabled: true, deleteAfterRun: false,
    }, `${options.runId}-schedule`)
    check((await client.getSchedule(agentId, scheduleId)).payload?.thinking === 'low', 'schedule_thinking_not_stored')
    await scheduled('low', 'schedule_override')
    await client.updateSchedule(agentId, scheduleId, { payload: { kind: 'agentTurn', thinking: null } })
    const payload = (await client.getSchedule(agentId, scheduleId)).payload
    check(payload && !Object.hasOwn(payload, 'thinking'), 'schedule_null_not_cleared')
    passed('schedule_null_clear')
    await scheduled('high', 'schedule_follows_agent_after_clear')
  }
  async function clean(step: string, action: () => Promise<unknown>): Promise<void> {
    try { await action(); record.cleanup.steps.push({ step, passed: true }) }
    catch (error) {
      const failure = safeFailure(error)
      record.cleanup.steps.push({ step, passed: failure.http_status === 404, ...(failure.http_status === 404 ? {} : { failure }) })
    }
    persist()
  }
  try { await exercise() }
  catch (error) { record.failure ??= safeFailure(error) }
  finally {
    cleaning = true
    options.cleanupMode()
    if (record.resources.creation_uncertain && !agentId) {
      await clean('recover_agent', async () => {
        const page = await client.listAgents({ labels })
        const own = page.data.filter(agent => agent.declared?.name === name
          && (agent.declared.labels as Record<string, string> | undefined)?.sdk_thinking_e2e === options.runId)
        check(page.total === 1 && own.length === 1, 'uncertain_create_requires_manual_recovery')
        agentId = own[0].agent_id; record.resources.agent_id = agentId; record.resources.creation_uncertain = false
      })
    }
    if (agentId) {
      if (scheduleId) await clean('delete_schedule', () => client.deleteSchedule(agentId!, scheduleId!))
      await clean('stop_agent', () => client.stopAgent(agentId!))
      // Only sessions on this newly created Agent are eligible for cleanup.
      await clean('recover_sessions', async () => { for (const session of await client.listSessions(agentId!)) remember(session.session_id) })
      for (const id of sessions) await clean('delete_session', () => client.deleteSession(agentId!, id))
      // Preserve the Agent's addressability if any earlier cleanup failed.
      if (record.cleanup.steps.every(step => step.passed)) {
        await clean('delete_agent', () => client.deleteAgent(agentId!))
        await clean('confirm_agent_unavailable', async () => {
          try { await client.getAgent(agentId!) } catch (error) { if (safeFailure(error).http_status === 404) return; throw error }
          check(false, 'deleted_agent_still_available')
        })
      }
    }
    record.cleanup.complete = record.cleanup.steps.every(step => step.passed) && !record.resources.creation_uncertain
    record.passed = !record.failure && record.cleanup.complete
    persist()
  }
  return record
}
