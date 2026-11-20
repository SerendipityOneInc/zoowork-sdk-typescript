import type * as SDK from '@zoowork-ai/sdk'
import { check, safeFailure } from './guard.ts'

export type CustomToolsSDK = Pick<typeof SDK, 'customToolUse' | 'isRunFinished'>

export interface CustomToolsObservation {
  case: string
  ingress: 'rest' | 'session_event'
  end_turn: boolean
  is_error: boolean
  turn_end_reason: string
  output_type: string
  post_resolve_assistant_events: number
}

export interface CustomToolsRecord {
  run_id: string
  passed: boolean
  checks: string[]
  model?: string
  observations: CustomToolsObservation[]
  resources: { agent_id?: string; sessions: string[]; creation_uncertain: boolean }
  failure?: ReturnType<typeof safeFailure>
  cleanup: { complete: boolean; steps: { step: string; passed: boolean; failure?: ReturnType<typeof safeFailure> }[] }
}

interface Options {
  runId: string
  model?: string
  signal: AbortSignal
  cleanupMode: () => void
  save: (record: CustomToolsRecord) => void
  pollAttempts?: number
  delay?: () => Promise<void>
}

const LOOKUP_ORDER_TOOL: SDK.CustomToolDeclaration = {
  name: 'lookup_order',
  description:
    'Look up the current status of one order in the merchant system. ' +
    'Use this tool whenever the user asks about an order.',
  input_schema: {
    type: 'object',
    properties: { orderId: { type: 'string', description: 'The order id, e.g. o-42' } },
    required: ['orderId'],
  },
  timeoutMs: 120_000,
}

/** Two real end_turn custom-tool turns (REST + Session API) on one throwaway Agent; never persists replies or prompts. */
export async function customToolsSmoke(
  sdk: CustomToolsSDK,
  client: SDK.ZooworkClient,
  options: Options,
): Promise<CustomToolsRecord> {
  const record: CustomToolsRecord = {
    run_id: options.runId,
    passed: false,
    checks: [],
    observations: [],
    resources: { sessions: [], creation_uncertain: false },
    cleanup: { complete: false, steps: [] },
  }
  const labels = { sdk_custom_tools_e2e: options.runId }
  const name = `sdk-custom-tools-${options.runId}`
  const delay = options.delay ?? (() => new Promise((resolve) => setTimeout(resolve, 1000)))
  const attempts = options.pollAttempts ?? 120
  let agentId: string | undefined
  const sessions = new Set<string>()
  let cleaning = false

  const persist = () => {
    try {
      options.save(record)
    } catch {
      record.failure ??= { kind: 'record_write_failed' }
      record.passed = false
      // Recording errors stop new model calls but must never interrupt cleanup.
      if (!cleaning) check(false, 'record_write_failed')
    }
  }
  const passed = (value: string) => {
    record.checks.push(value)
    persist()
  }
  const remember = (id: string) => {
    sessions.add(id)
    record.resources.sessions = [...sessions]
    persist()
  }

  async function waitForRequested(sessionId: string, label: string): Promise<{ callId: string; seq: number }> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      options.signal.throwIfAborted()
      const events = await client.listAllEvents(agentId!, sessionId)
      for (const ev of events) {
        const use = sdk.customToolUse(ev)
        if (use?.phase === 'requested' && use.name === 'lookup_order' && use.callId) {
          return { callId: use.callId, seq: ev.seq }
        }
        check(ev.eventType !== 'agent.error', `${label}_agent_error`)
        check(!sdk.isRunFinished(ev), `${label}_tool_not_called`)
      }
      await delay()
    }
    check(false, `${label}_call_timeout`)
    return { callId: '', seq: -1 }
  }

  async function verifyEndTurnCompletion(params: {
    sessionId: string
    callId: string
    requestedSeq: number
    expectedIsError: boolean
    ingress: 'rest' | 'session_event'
    label: string
  }): Promise<void> {
    const { sessionId, callId, requestedSeq, expectedIsError, ingress, label } = params
    let events: SDK.SessionEvent[] | undefined
    for (let attempt = 0; attempt < attempts; attempt++) {
      options.signal.throwIfAborted()
      const listed = await client.listAllEvents(agentId!, sessionId)
      if (listed.some((ev) => ev.seq > requestedSeq && sdk.isRunFinished(ev))) {
        events = listed
        break
      }
      await delay()
    }
    check(events, `${label}_finish_timeout`)

    const resolvedEv = events.find((ev) => {
      const use = sdk.customToolUse(ev)
      return use?.phase === 'resolved' && use.callId === callId
    })
    check(resolvedEv, `${label}_missing_resolved`)
    const resolvedUse = sdk.customToolUse(resolvedEv)!
    check(resolvedUse.outcome === 'completed', `${label}_unexpected_outcome`)
    check(resolvedUse.endTurn === true, `${label}_missing_end_turn`)
    check(resolvedUse.isError === expectedIsError, `${label}_unexpected_is_error`)

    const post = events.filter((ev) => ev.seq > resolvedEv.seq)
    check(!post.some((ev) => ev.eventType === 'agent.error'), `${label}_post_resolve_error`)
    const postAssistantCount = post.filter((ev) => ev.eventType === 'agent.assistant').length
    check(postAssistantCount === 0, `${label}_unexpected_llm_continuation`)
    check(!post.some((ev) => sdk.customToolUse(ev)?.phase === 'requested'), `${label}_unexpected_tool_retry`)

    const finished = post.find((ev) => sdk.isRunFinished(ev))
    check(finished, `${label}_missing_run_finished`)
    check(finished.payload.status === 'succeeded', `${label}_run_not_succeeded`)
    check(finished.payload.outputType === 'not_required', `${label}_unexpected_output_type`)
    check(finished.payload.turnEndReason === 'custom_tool', `${label}_unexpected_turn_end_reason`)

    record.observations.push({
      case: label,
      ingress,
      end_turn: true,
      is_error: expectedIsError,
      turn_end_reason: String(finished.payload.turnEndReason),
      output_type: String(finished.payload.outputType),
      post_resolve_assistant_events: postAssistantCount,
    })
    passed(label)
  }

  async function exercise(): Promise<void> {
    options.signal.throwIfAborted()
    const models = await client.listModels()
    const candidates = models.filter(
      (row) => row.selectable !== false && (!options.model || row.model === options.model),
    )
    const model = candidates.find((row) => row.default_for?.includes('model')) ?? candidates[0]
    check(model?.model, 'custom_tools_model_unavailable')
    record.model = model.model
    passed('model_catalog')

    record.resources.creation_uncertain = true
    persist()
    const created = await client.createAgent(
      {
        resource: {
          name,
          labels,
          include_global_skills: false,
          model: { primary: model.model },
          custom_tools: [LOOKUP_ORDER_TOOL],
        },
      },
      options.runId,
    )
    agentId = created.agent_id
    record.resources.agent_id = agentId
    record.resources.creation_uncertain = false
    persist()

    await client.startAgent(agentId)
    await client.waitUntilRunning(agentId, { timeoutMs: 30_000 })

    // Case 1: controld REST resolveCustomToolCall with camelCase endTurn: true
    const session1 = await client.createSession(
      agentId,
      {
        metadata: { sdk_custom_tools_e2e: options.runId, case: 'rest_end_turn' },
        initial_events: [{ type: 'user.message', content: 'Where is order o-42? Use lookup_order to check its status.' }],
      },
      `${options.runId}-rest-end-turn`,
    )
    remember(session1.session_id)
    const req1 = await waitForRequested(session1.session_id, 'rest_end_turn')
    const pending = await client.listCustomToolCalls(agentId, { status: 'pending', sessionId: session1.session_id })
    check(pending.some((call) => call.call_id === req1.callId), 'rest_end_turn_not_pending')
    const receipt = await client.resolveCustomToolCall(agentId, req1.callId, {
      content: [{ type: 'json', value: { orderId: 'o-42', status: 'handed-off-to-app' } }],
      isError: false,
      endTurn: true,
      resolvedBy: 'sdk-custom-tools-e2e',
    })
    check(receipt.signaled === true, 'rest_end_turn_not_signaled')
    await verifyEndTurnCompletion({
      sessionId: session1.session_id,
      callId: req1.callId,
      requestedSeq: req1.seq,
      expectedIsError: false,
      ingress: 'rest',
      label: 'rest_end_turn',
    })

    // Case 2: Session API user.custom_tool_result with is_error: true + end_turn: true
    const session2 = await client.createSession(
      agentId,
      {
        metadata: { sdk_custom_tools_e2e: options.runId, case: 'session_event_end_turn_error' },
        initial_events: [{ type: 'user.message', content: 'Where is order o-77? Use lookup_order to check its status.' }],
      },
      `${options.runId}-session-end-turn`,
    )
    remember(session2.session_id)
    const req2 = await waitForRequested(session2.session_id, 'session_event_end_turn_error')
    const posted = await client.postEvents(agentId, session2.session_id, [
      {
        type: 'user.custom_tool_result',
        custom_tool_use_id: req2.callId,
        content: [{ type: 'text', text: 'order-access-denied' }],
        is_error: true,
        end_turn: true,
        idempotency_key: `${options.runId}-session-end-turn-result`,
      } satisfies SDK.CustomToolResultEvent,
    ])
    check(posted.events[0]?.accepted === true, 'session_event_end_turn_error_not_accepted')
    await verifyEndTurnCompletion({
      sessionId: session2.session_id,
      callId: req2.callId,
      requestedSeq: req2.seq,
      expectedIsError: true,
      ingress: 'session_event',
      label: 'session_event_end_turn_error',
    })
  }

  async function clean(step: string, action: () => Promise<unknown>): Promise<void> {
    try {
      await action()
      record.cleanup.steps.push({ step, passed: true })
    } catch (error) {
      const failure = safeFailure(error)
      record.cleanup.steps.push({
        step,
        passed: failure.http_status === 404,
        ...(failure.http_status === 404 ? {} : { failure }),
      })
    }
    persist()
  }

  try {
    await exercise()
  } catch (error) {
    record.failure ??= safeFailure(error)
  } finally {
    cleaning = true
    options.cleanupMode()
    if (record.resources.creation_uncertain && !agentId) {
      await clean('recover_agent', async () => {
        const page = await client.listAgents({ labels })
        const own = page.data.filter(
          (agent) =>
            agent.declared?.name === name &&
            (agent.declared.labels as Record<string, string> | undefined)?.sdk_custom_tools_e2e === options.runId,
        )
        check(page.total === 1 && own.length === 1, 'uncertain_create_requires_manual_recovery')
        agentId = own[0].agent_id
        record.resources.agent_id = agentId
        record.resources.creation_uncertain = false
      })
    }
    if (agentId) {
      await clean('stop_agent', () => client.stopAgent(agentId!))
      await clean('recover_sessions', async () => {
        for (const session of await client.listSessions(agentId!)) remember(session.session_id)
      })
      for (const id of sessions) await clean('delete_session', () => client.deleteSession(agentId!, id))
      if (record.cleanup.steps.every((step) => step.passed)) {
        await clean('delete_agent', () => client.deleteAgent(agentId!))
        await clean('confirm_agent_unavailable', async () => {
          try {
            await client.getAgent(agentId!)
          } catch (error) {
            if (safeFailure(error).http_status === 404) return
            throw error
          }
          check(false, 'deleted_agent_still_available')
        })
      }
    }
    record.cleanup.complete = record.cleanup.steps.every((step) => step.passed) && !record.resources.creation_uncertain
    record.passed = !record.failure && record.cleanup.complete
    persist()
  }
  return record
}
