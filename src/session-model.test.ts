/**
 * SYNTHETIC offline inputs for the Session model resource, source-reviewed against Engine
 * `session-model.ts`. No live response recording exists yet; these tests prove SDK behavior only.
 */
import { expect, expectTypeOf, test } from 'vitest'
import {
  createZooworkClient, vaultSessionErrorCode, ZooworkError,
  type SessionModel, type SessionModelOption, type SessionModelUpdate, type ThinkingLevel,
} from './index.js'

const BASE = 'https://sdk-contract.test/service/v1'
const VERSIONS = { expected_selection_version: 0, expected_config_version: 7 }

function harness(reply: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = []
  const client = createZooworkClient({
    apiKey: 'synthetic-unit-key',
    baseUrl: BASE,
    fetch: async (url, init = {}) => {
      calls.push({ url, init })
      return new Response(JSON.stringify(reply), { status, headers: { 'Content-Type': 'application/json' } })
    },
  })
  return { client, calls }
}

const STATE: SessionModel = {
  session_id: 'session-test', mode: 'agent_default', selected_model_id: null,
  default_model_id: 'litellm/example', default_mode: 'fixed', next_turn_model_id: 'litellm/example',
  current_model_name: 'Example', default_model_name: 'Example',
  current_model_thinking: { default: 'medium', levels: ['off', 'low', 'medium', 'high'] },
  available_models: [
    { id: 'example', display_name: 'Example', thinking: { default: 'medium', levels: ['off', 'low', 'medium', 'high'] } },
  ],
  thinking: null, default_thinking: 'low', thinking_supported: true, selection_version: 0, config_version: 7,
  applies_from: 'next_turn', available: true, writable: true, unavailable_reason: null,
}

async function failure(body: unknown, status: number): Promise<{ error: ZooworkError; requests: number }> {
  const { client, calls } = harness(body, status)
  const error = await client.updateSessionModel('a', 's', { ...VERSIONS, thinking: 'high' }).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(ZooworkError)
  return { error: error as ZooworkError, requests: calls.length }
}

test('getSessionModel reads the escaped resource and keeps the response, unknown fields included', async () => {
  const reply = { ...STATE, future_field: { retained: true } }
  const { client, calls } = harness(reply)
  const result = await client.getSessionModel('agent/1', 'session 1')
  expect(calls[0].url).toBe(`${BASE}/agents/agent%2F1/sessions/session%201/model`)
  expect(calls[0].init.method).toBeUndefined()
  expect(calls[0].init.body).toBeUndefined()
  expect(result).toEqual(reply)
  expectTypeOf(result).toEqualTypeOf<SessionModel>()
  expectTypeOf(result.thinking).toEqualTypeOf<ThinkingLevel | null>()
  expectTypeOf(result.available_models).toEqualTypeOf<SessionModelOption[]>()
})

test('a read-only Session is a successful read that says why', async () => {
  const reply = { ...STATE, available: false, writable: false, available_models: [], unavailable_reason: 'task_model_read_only' }
  const { client } = harness(reply)
  expect(await client.getSessionModel('a', 's')).toMatchObject({ writable: false, unavailable_reason: 'task_model_read_only' })
})

test('updateSessionModel PUTs exactly the fields given, without an Idempotency-Key', async () => {
  const updated = { ...STATE, mode: 'override', selected_model_id: 'litellm/example', thinking: 'high', selection_version: 1 }
  const { client, calls } = harness(updated)
  expect(await client.updateSessionModel('agent/1', 'session 1', { ...VERSIONS, model_id: 'example', thinking: 'high' }))
    .toEqual(updated)
  expect(calls[0].url).toBe(`${BASE}/agents/agent%2F1/sessions/session%201/model`)
  expect(calls[0].init.method).toBe('PUT')
  expect(JSON.parse(String(calls[0].init.body))).toEqual({ ...VERSIONS, model_id: 'example', thinking: 'high' })
  const headers = new Headers(calls[0].init.headers)
  expect(headers.get('Content-Type')).toBe('application/json')
  expect(headers.has('Idempotency-Key')).toBe(false)
})

test.each<[string, SessionModelUpdate, string[]]>([
  ['thinking only', { ...VERSIONS, thinking: 'max' }, ['thinking']],
  ['thinking null clears the level and leaves model_id out', { ...VERSIONS, thinking: null }, ['thinking']],
  ['model only leaves thinking out', { ...VERSIONS, model_id: 'example' }, ['model_id']],
  ['an undefined field is omitted, not null', { ...VERSIONS, model_id: undefined, thinking: 'off' }, ['thinking']],
  ['a fixed model with its default thinking', { ...VERSIONS, model_id: 'example', thinking: null }, ['model_id', 'thinking']],
  ['model_id null restores the Agent default', { ...VERSIONS, model_id: null }, ['model_id']],
])('%s', async (_name, update, sent) => {
  const { client, calls } = harness(STATE)
  await client.updateSessionModel('a', 's', update)
  const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>
  expect(Object.keys(body).sort()).toEqual([...Object.keys(VERSIONS), ...sent].sort())
  for (const key of sent) expect(body[key]).toBe(update[key as 'model_id' | 'thinking'])
})

test('version 0 is sent, not dropped', async () => {
  const { client, calls } = harness(STATE)
  await client.updateSessionModel('a', 's', { ...VERSIONS, thinking: null })
  expect(JSON.parse(String(calls[0].init.body))).toEqual({ ...VERSIONS, thinking: null })
})

test('a version conflict is 409 task_model_changed, sent once and never retried', async () => {
  const { error, requests } = await failure(
    { error: { type: 'task_model_changed', message: 'Task model or Agent configuration changed; refresh and retry' } }, 409,
  )
  expect(error).toMatchObject({ status: 409, type: 'task_model_changed', retryable: false })
  expect(requests).toBe(1)
})

test.each([
  [409, 'task_model_read_only'],
  [409, 'session_archived'],
  [409, 'task_model_subscription_bound'],
  [409, 'task_model_unavailable'],
  [400, 'invalid_request'],
  [404, 'session_not_found'],
])('%i %s is not a version conflict and keeps its type', async (status, type) => {
  const { error, requests } = await failure({ error: { type, message: 'synthetic' } }, status)
  expect(error).toMatchObject({ status, type, retryable: false })
  expect(requests).toBe(1)
})

test('a Session with Vault credentials is 403 in both spellings', async () => {
  const { error } = await failure(
    {
      code: 'vault.profile_restricted', detail: 'synthetic',
      error: { type: 'vault_profile_restricted', message: 'synthetic' },
    }, 403,
  )
  expect(error).toMatchObject({ status: 403, type: 'vault_profile_restricted', code: 'vault.profile_restricted' })
  expect(vaultSessionErrorCode(error)).toBe('vault.profile_restricted')
})

test('a gateway failure is not retried either', async () => {
  const { error, requests } = await failure({ code: 'agent.runtime_error', detail: 'synthetic' }, 502)
  expect(error).toMatchObject({ status: 502, retryable: true })
  expect(requests).toBe(1)
})

test('the update type rejects what the service rejects', () => {
  // @ts-expect-error both versions are required.
  const noVersions: SessionModelUpdate = { thinking: 'high' }
  // @ts-expect-error at least one of model_id and thinking is required.
  const empty: SessionModelUpdate = { ...VERSIONS }
  // @ts-expect-error restoring the Agent default cannot set a level.
  const resetWithLevel: SessionModelUpdate = { ...VERSIONS, model_id: null, thinking: 'high' }
  // @ts-expect-error not a public thinking level.
  const unknownLevel: SessionModelUpdate = { ...VERSIONS, thinking: 'xhigh' }
  void [noVersions, empty, resetWithLevel, unknownLevel]
})
