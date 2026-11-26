import { ZooworkError, type SessionModel, type ZooworkClient } from '@zoowork-ai/sdk'
import { check } from './guard.ts'

function versions(state: SessionModel) {
  return { expected_selection_version: state.selection_version, expected_config_version: state.config_version }
}

async function expectError(request: Promise<SessionModel>, status: number, type: string) {
  try { await request }
  catch (error) {
    check(error instanceof ZooworkError && error.status === status && error.type === type, `expected_${type}`)
    return
  }
  check(false, `expected_${type}`)
}

export async function checkSessionModel(client: ZooworkClient, agentId: string, sessionId: string, passed: (label: string) => void) {
  const initial = await client.getSessionModel(agentId, sessionId)
  check(initial.writable && initial.mode === 'agent_default' && initial.selected_model_id === null && initial.thinking === null, 'expected_agent_default')
  const target = initial.available_models.find(model => model.thinking?.levels?.length >= 2)
  check(target, 'model_with_two_levels_required')
  const [first, second] = target.thinking.levels
  passed('read_session_model')

  const set = await client.updateSessionModel(agentId, sessionId, { ...versions(initial), model_id: target.id, thinking: first })
  check(set.mode === 'override' && set.selected_model_id === `litellm/${target.id}` && set.thinking === first
    && set.selection_version === initial.selection_version + 1, 'model_and_level_not_set')
  const saved = await client.getSessionModel(agentId, sessionId)
  check(saved.selected_model_id === set.selected_model_id && saved.thinking === first, 'selection_not_persisted')
  passed('set_model_and_level')

  const unknown = `sdk-missing-${crypto.randomUUID()}`
  await expectError(client.updateSessionModel(agentId, sessionId, { ...versions(initial), model_id: unknown }), 409, 'task_model_changed')
  passed('stale_version')
  const changed = await client.updateSessionModel(agentId, sessionId, { ...versions(saved), thinking: second })
  check(changed.selected_model_id === set.selected_model_id && changed.thinking === second, 'level_only_failed')
  passed('level_only')
  const cleared = await client.updateSessionModel(agentId, sessionId, { ...versions(changed), thinking: null })
  check(cleared.selected_model_id === set.selected_model_id && cleared.thinking === null, 'level_clear_failed')
  passed('clear_level')
  const reset = await client.updateSessionModel(agentId, sessionId, { ...versions(cleared), model_id: null })
  check(reset.mode === 'agent_default' && reset.selected_model_id === null && reset.thinking === null, 'reset_failed')
  passed('reset_model')
  await expectError(client.updateSessionModel(agentId, sessionId, { ...versions(reset), model_id: unknown }), 400, 'invalid_request')
  passed('unknown_model')

  await client.archiveSession(agentId, sessionId)
  const archived = await client.getSessionModel(agentId, sessionId)
  check(!archived.writable && archived.unavailable_reason === 'session_archived' && archived.available_models.length === 0, 'expected_archived_state')
  await expectError(client.updateSessionModel(agentId, sessionId, { ...versions(archived), thinking: first }), 409, 'session_archived')
  passed('archived_session')
}
