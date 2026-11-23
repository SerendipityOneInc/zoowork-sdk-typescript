// Synthetic lifecycle and fault-injection tests, never contacts a deployment.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  customToolUse,
  isRunFinished,
  normalizeEvent,
  type CustomToolResultEvent,
  type SessionEvent,
  type ZooworkClient,
} from '../src/index.js'
import { customToolsSmoke } from './custom-tools-smoke.ts'

const sensitive = 'synthetic-sensitive-response-do-not-persist'

interface SetupOptions {
  missingEndTurn?: boolean
  extraAssistantAfterResolve?: boolean
  badTurnEndReason?: boolean
  badOutputType?: boolean
  wrongIsError?: boolean
  skipToolCall?: boolean
  cleanupFailure?: boolean
  uncertainCreate?: boolean
}

function setup(options: SetupOptions = {}) {
  const calls: string[] = []
  const sessions = new Map<string, SessionEvent[]>()
  let deleted = false
  let seq = 0

  function push(sessionId: string, raw: Record<string, unknown>) {
    seq += 1
    const ev = normalizeEvent({ seq, ...raw })
    sessions.get(sessionId)!.push(ev)
    return ev
  }

  function finishSession(sessionId: string, callId: string, params: { isError: boolean; endTurn?: boolean }) {
    const resolvedPayload: Record<string, unknown> = {
      phase: 'resolved',
      callId,
      name: 'lookup_order',
      outcome: 'completed',
      isError: options.wrongIsError ? !params.isError : params.isError,
      ...(!options.missingEndTurn && params.endTurn !== undefined ? { endTurn: params.endTurn } : {}),
    }
    push(sessionId, { event_type: 'agent.custom_tool_use', payload: resolvedPayload })
    if (options.extraAssistantAfterResolve) {
      push(sessionId, {
        event_type: 'agent.assistant',
        payload: { message: { content: [{ type: 'text', text: sensitive }] } },
      })
    }
    push(sessionId, {
      event_type: 'run.finished',
      payload: {
        status: 'succeeded',
        outputType: options.badOutputType ? 'empty' : 'not_required',
        turnEndReason: options.badTurnEndReason ? 'yielded' : 'custom_tool',
      },
    })
  }

  const client = {
    listModels: async () => [
      { model: 'first' },
      { model: 'platform-default', default_for: ['model'] },
    ],
    createAgent: async (input: { resource: { custom_tools?: { name: string }[] } }) => {
      calls.push('create')
      assert.equal(input.resource.custom_tools?.[0]?.name, 'lookup_order')
      if (options.uncertainCreate) throw Error(sensitive)
      return { agent_id: 'agt_SYNTHETIC' }
    },
    listAgents: async () => ({ total: 0, data: [] }),
    getAgent: async () => {
      if (deleted) throw { status: 404 }
      return { agent_id: 'agt_SYNTHETIC' }
    },
    startAgent: async () => ({}),
    waitUntilRunning: async () => ({}),
    createSession: async () => {
      const id = `SYNTHETIC_${sessions.size + 1}`
      sessions.set(id, [])
      if (options.skipToolCall) {
        push(id, { event_type: 'run.finished', payload: { status: 'succeeded' } })
      } else {
        push(id, {
          event_type: 'agent.custom_tool_use',
          payload: {
            phase: 'requested',
            callId: `ctc_${id}`,
            toolCallId: `toolu_${id}`,
            name: 'lookup_order',
            input: { orderId: 'o-42' },
          },
        })
      }
      return { session_id: id }
    },
    listSessions: async () => [...sessions.keys()].map((id) => ({ session_id: id })),
    listAllEvents: async (_agent: string, sessionId: string) => [...(sessions.get(sessionId) ?? [])],
    listCustomToolCalls: async (_agent: string, opts?: { sessionId?: string }) => [
      { call_id: `ctc_${opts?.sessionId}`, status: 'pending' },
    ],
    resolveCustomToolCall: async (
      _agent: string,
      callId: string,
      input: { isError?: boolean; endTurn?: boolean },
    ) => {
      calls.push(`resolve:${String(input.endTurn)}:${String(input.isError)}`)
      const sessionId = callId.replace(/^ctc_/, '')
      finishSession(sessionId, callId, { isError: Boolean(input.isError), endTurn: input.endTurn })
      return { call_id: callId, status: 'pending', signaled: true }
    },
    postEvents: async (_agent: string, sessionId: string, events: CustomToolResultEvent[]) => {
      const ev = events[0]!
      calls.push(`post:${String(ev.end_turn)}:${String(ev.is_error)}`)
      const callId = ev.custom_tool_use_id ?? ev.call_id!
      finishSession(sessionId, callId, { isError: Boolean(ev.is_error), endTurn: ev.end_turn })
      return { events: [{ accepted: true }] }
    },
    deleteSession: async (_agent: string, id: string) => {
      calls.push('delete_session')
      if (options.cleanupFailure) throw { status: 503, message: sensitive }
      sessions.delete(id)
    },
    stopAgent: async () => {
      calls.push('stop')
      return {}
    },
    deleteAgent: async () => {
      calls.push('delete')
      deleted = true
    },
  } as unknown as ZooworkClient

  return { client, calls }
}

async function run(options: SetupOptions = {}) {
  const f = setup(options)
  const result = await customToolsSmoke(
    { customToolUse, isRunFinished },
    f.client,
    {
      runId: 'synthetic-run',
      signal: new AbortController().signal,
      save: () => {},
      cleanupMode: () => {},
      pollAttempts: 2,
      delay: async () => {},
    },
  )
  assert.equal(JSON.stringify(result).includes(sensitive), false)
  return { ...f, result }
}

test('end_turn custom tool smoke proves REST camelCase endTurn and Session API is_error+end_turn', async () => {
  const f = await run()
  assert.equal(f.result.passed, true)
  assert.equal(f.result.model, 'platform-default')
  assert.deepEqual(f.result.checks, ['model_catalog', 'rest_end_turn', 'session_event_end_turn_error'])
  assert.deepEqual(f.result.observations, [
    {
      case: 'rest_end_turn',
      ingress: 'rest',
      end_turn: true,
      is_error: false,
      turn_end_reason: 'custom_tool',
      output_type: 'not_required',
      post_resolve_assistant_events: 0,
    },
    {
      case: 'session_event_end_turn_error',
      ingress: 'session_event',
      end_turn: true,
      is_error: true,
      turn_end_reason: 'custom_tool',
      output_type: 'not_required',
      post_resolve_assistant_events: 0,
    },
  ])
  assert.ok(f.calls.includes('resolve:true:false'))
  assert.ok(f.calls.includes('post:true:true'))
  assert.equal(f.result.cleanup.complete, true)
  assert.ok(f.calls.indexOf('stop') < f.calls.indexOf('delete_session'))
  assert.ok(f.calls.indexOf('delete_session') < f.calls.indexOf('delete'))
  assert.equal(f.calls.filter((c) => c === 'delete_session').length, 2)
})

test('fails if gateway drops endTurn, continues LLM, or misreports run.finished metadata', async () => {
  assert.equal((await run({ missingEndTurn: true })).result.failure?.kind, 'rest_end_turn_missing_end_turn')
  assert.equal(
    (await run({ extraAssistantAfterResolve: true })).result.failure?.kind,
    'rest_end_turn_unexpected_llm_continuation',
  )
  assert.equal((await run({ badTurnEndReason: true })).result.failure?.kind, 'rest_end_turn_unexpected_turn_end_reason')
  assert.equal((await run({ badOutputType: true })).result.failure?.kind, 'rest_end_turn_unexpected_output_type')
  assert.equal((await run({ wrongIsError: true })).result.failure?.kind, 'rest_end_turn_unexpected_is_error')
  assert.equal((await run({ skipToolCall: true })).result.failure?.kind, 'rest_end_turn_tool_not_called')
})

test('failed Session deletion preserves the Agent for recovery', async () => {
  const f = await run({ cleanupFailure: true })
  assert.equal(f.result.passed, false)
  assert.equal(f.result.cleanup.complete, false)
  assert.equal(f.calls.includes('delete'), false)
})

test('uncertain Agent creation is not retried or counted as cleaned up', async () => {
  const f = await run({ uncertainCreate: true })
  assert.equal(f.calls.filter((c) => c === 'create').length, 1)
  assert.equal(f.result.passed, false)
  assert.equal(f.result.cleanup.complete, false)
  assert.equal(f.result.resources.creation_uncertain, true)
  assert.equal(f.calls.includes('delete'), false)
})

for (const phase of ['exercise', 'cleanup'] as const) {
  test(`record write failure during ${phase} cannot skip cleanup`, async () => {
    const f = setup()
    const result = await customToolsSmoke(
      { customToolUse, isRunFinished },
      f.client,
      {
        runId: 'synthetic-run',
        signal: new AbortController().signal,
        save: (record) => {
          if (record.resources.agent_id && (phase === 'exercise' || record.cleanup.steps.length > 0)) {
            throw Error(sensitive)
          }
        },
        cleanupMode: () => {},
        pollAttempts: 2,
        delay: async () => {},
      },
    )
    assert.equal(result.passed, false)
    assert.equal(result.failure?.kind, 'record_write_failed')
    assert.equal(result.cleanup.complete, true)
    assert.equal(f.calls.includes('delete'), true)
    assert.equal(JSON.stringify(result).includes(sensitive), false)
  })
}
