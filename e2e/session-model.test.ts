// Synthetic Session model responses. The client never contacts a deployment.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ZooworkError, type ModelThinking, type SessionModel, type ZooworkClient } from '../src/index.js'
import { checkSessionModel } from './session-model-smoke.ts'

const writes = ['set', 'level', 'clear', 'reset'] as const
type Write = typeof writes[number]

async function run(otherModel: boolean, stalled?: Write) {
  const thinking: ModelThinking = { default: 'low', levels: ['low', 'high'] }
  const models = (otherModel ? ['base', 'other'] : ['base']).map(id => ({ id, display_name: id, thinking }))
  const target = otherModel ? 'other' : 'base'
  const base = 'litellm/base'
  let state: SessionModel = {
    session_id: 'session', mode: 'agent_default', selected_model_id: null, default_model_id: base,
    default_mode: 'fixed', next_turn_model_id: base, current_model_name: 'base', default_model_name: 'base',
    current_model_thinking: thinking, available_models: models, thinking: null, default_thinking: 'high',
    selection_version: 4, config_version: 7, applies_from: 'next_turn', available: true, writable: true,
    unavailable_reason: null,
  }
  const initialVersion = state.selection_version
  let nextWrite = 0
  const patches = [{ model_id: target, thinking: 'low' }, { thinking: 'high' }, { thinking: null }, { model_id: null }]
  const client: Pick<ZooworkClient, 'getSessionModel' | 'updateSessionModel' | 'archiveSession'> = {
    getSessionModel: async () => state,
    archiveSession: async () => {
      state = { ...state, available: false, writable: false, unavailable_reason: 'session_archived', available_models: [] }
      return { archived: true }
    },
    updateSessionModel: async (_agent, _session, { expected_selection_version, expected_config_version, ...patch }) => {
      assert.equal(expected_config_version, state.config_version)
      if (!state.writable) throw new ZooworkError(409, 'synthetic', 'session_archived')
      if (patch.model_id?.startsWith('sdk-missing-')) {
        if (expected_selection_version === initialVersion) throw new ZooworkError(409, 'synthetic', 'task_model_changed')
        assert.equal(expected_selection_version, state.selection_version)
        throw new ZooworkError(400, 'synthetic', 'invalid_request')
      }
      assert.equal(expected_selection_version, state.selection_version)
      assert.deepEqual(patch, patches[nextWrite])
      const write = writes[nextWrite++]
      const reset = write === 'reset'
      state = { ...state, mode: reset ? 'agent_default' : 'override',
        selected_model_id: reset ? null : `litellm/${target}`, thinking: patch.thinking ?? null,
        current_model_name: reset ? 'base' : target, next_turn_model_id: reset ? base : `litellm/${target}`,
        default_thinking: reset ? 'high' : null,
        selection_version: state.selection_version + (write === stalled ? 0 : 1) }
      return state
    },
  }
  const labels: string[] = []
  await checkSessionModel(ZooworkError, client, 'agent', 'session', label => labels.push(label))
  return labels
}

for (const otherModel of [true, false]) {
  const label = otherModel ? 'model_switch' : 'same_model_as_default'
  test(`Session model sequence records ${label} and all checks`, async () => {
    assert.deepEqual(await run(otherModel), ['read_session_model', 'set_model_and_level', label,
      'stale_version', 'level_only', 'clear_level', 'reset_model', 'unknown_model', 'archived_session'])
  })
}

const failure: Record<Write, string> = {
  set: 'model_and_level_not_set', level: 'level_only_failed', clear: 'level_clear_failed', reset: 'reset_failed',
}
for (const write of writes) {
  test(`a stalled selection_version fails the ${write} check`, async () => {
    await assert.rejects(run(true, write), { code: failure[write] })
  })
}
