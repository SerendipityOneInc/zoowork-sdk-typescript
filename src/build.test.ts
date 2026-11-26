import { expect, expectTypeOf, test, vi } from 'vitest'
import {
  type AgentRevisionList,
  type AgentRevisionSummary,
  type BuildQuickCommand,
  type BuildApply,
  type BuildRunApply,
  createZooworkClient,
  type ZooworkClient,
  ZooworkError,
} from './index.js'

const baseUrl = 'https://api.test/service/v1'
const apiKey = 'zwp_synthetic'
const receipt = {
  agent_id: 'a', config_version: 2, mode: 'build', build_session_id: 's', working_revision_id: 'r1',
} as const

const cases: {
  name: string
  method: string
  path: string
  key?: string
  body?: unknown
  call: (client: ZooworkClient) => Promise<unknown>
  response: unknown
}[] = [
  {
    name: 'create with options', method: 'POST', path: '/agents', key: 'create-1',
    body: { mode: 'build', name: 'Quote agent', intent: '', model: 'model' },
    call: (c) => c.createBuildAgent({ name: 'Quote agent', intent: '', model: 'model' }, 'create-1'),
    response: receipt,
  },
  {
    name: 'create with defaults', method: 'POST', path: '/agents', key: 'create-2',
    body: { mode: 'build' }, call: (c) => c.createBuildAgent({}, 'create-2'), response: receipt,
  },
  {
    name: 'summary', method: 'GET', path: '/agents/a%20b/build', call: (c) => c.getBuild('a b'),
    response: {
      name: 'Quote agent', description: '', avatar_url: null,
      quick_commands: [{ name: 'Quote', prompt: 'Draft a quote' } satisfies BuildQuickCommand],
      working_revision_id: 'r2', effective_revision_id: null,
      apply: { state: 'pending', config_version: 3, phase: null, blockers: [] }, future: { field: true },
    },
  },
  {
    name: 'open session', method: 'POST', path: '/agents/a%20b/build-session',
    call: (c) => c.openBuildSession('a b'), response: { session_id: 's', working_revision_id: 'r2' },
  },
  {
    name: 'superseded result', method: 'GET', path: '/agents/a%20b/build-session/runs/run%3F1',
    call: (c) => c.getBuildRun('a b', 'run?1'),
    response: {
      run_id: 'run?1', change: 'committed', revision_id: 'r1', working_revision_id: 'r2',
      effective_revision_id: 'r2',
      apply: { state: 'superseded', config_version: 3, phase: null, blockers: [] } satisfies BuildRunApply,
    },
  },
  {
    name: 'conflicted result', method: 'GET', path: '/agents/a%20b/build-session/runs/run2',
    call: (c) => c.getBuildRun('a b', 'run2'),
    response: { run_id: 'run2', change: 'conflict', working_revision_id: 'r2', effective_revision_id: null },
  },
  {
    name: 'retry apply', method: 'POST', path: '/agents/a%20b/build/apply', key: 'apply-1',
    call: (c) => c.retryBuildApply('a b', 'apply-1'),
    response: {
      state: 'blocked', config_version: 3, phase: null,
      blockers: [{ code: 'agent_revision.environment_rebuild_required', acknowledgeable: true }],
    } satisfies BuildApply,
  },
  {
    name: 'retry without confirmation', method: 'POST', path: '/agents/a%20b/build/apply', key: 'apply-false',
    call: (c) => c.retryBuildApply('a b', 'apply-false', { confirm_rebuild: false }),
    response: { state: 'pending', config_version: 3, phase: null, blockers: [] } satisfies BuildApply,
  },
  {
    name: 'confirm rebuild', method: 'POST', path: '/agents/a%20b/build/apply', key: 'rebuild-1',
    body: { confirm_rebuild: true, expected_revision_id: 'r2', expected_config_version: 3 },
    call: (c) => c.retryBuildApply('a b', 'rebuild-1', {
      confirm_rebuild: true, expected_revision_id: 'r2', expected_config_version: 3,
    }),
    response: { state: 'in_progress', config_version: 4, phase: 'preparing', blockers: [] } satisfies BuildApply,
  },
  {
    name: 'revision list', method: 'GET', path: '/agents/a%20b/revisions',
    call: (c) => c.listRevisions('a b'),
    response: {
      revisions: [
        {
          revision_id: 'r2', parent_revision_id: 'r1', commit_message: 'Update quote format',
          created_at: '2026-11-25T09:00:00Z', validation_passed: true,
        },
        {
          revision_id: 'r1', parent_revision_id: null, commit_message: 'Create agent',
          created_at: '2026-11-25T08:00:00Z', validation_passed: true,
        },
      ],
    } satisfies AgentRevisionList,
  },
  {
    name: 'revision diff', method: 'GET', path: '/agents/a%20b/revisions/r%3F2/diff',
    call: (c) => c.getRevisionDiff('a b', 'r?2'),
    response: { revision_id: 'r?2', parent_revision_id: 'r1', unified_diff: '+New source\n' },
  },
]

test('Build public record types have the documented fields', () => {
  expectTypeOf<BuildQuickCommand>().toEqualTypeOf<{ name: string; prompt: string }>()
  expectTypeOf<AgentRevisionSummary>().toEqualTypeOf<{
    revision_id: string
    parent_revision_id: string | null
    commit_message: string
    created_at: string
    validation_passed: boolean
  }>()
})

test.each(cases)('Build wire contract for $name', async ({ method, path, key, body, call, response }) => {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const request = new Request(url, init)
    expect(request.url).toBe(baseUrl + path)
    expect(request.method).toBe(method)
    expect(request.headers.get('Authorization')).toBe('Bearer ' + apiKey)
    expect(request.headers.get('Idempotency-Key')).toBe(key ?? null)
    expect(request.headers.has('If-Match')).toBe(false)
    expect(request.headers.get('Content-Type')).toBe(body === undefined ? null : 'application/json')
    if (body === undefined) expect(await request.text()).toBe('')
    else expect(await request.json()).toEqual(body)
    return Response.json(response, { status: path === '/agents' ? 201 : 200 })
  })
  expect(await call(createZooworkClient({ apiKey, baseUrl, fetch }))).toEqual(response)
  expect(fetch).toHaveBeenCalledOnce()
})

test('Build writes require idempotency keys before HTTP', async () => {
  const fetch = vi.fn()
  const client = createZooworkClient({ apiKey, baseUrl, fetch })
  // @ts-expect-error Build creation requires an idempotency key.
  await expect(client.createBuildAgent({})).rejects.toThrow('idempotencyKey')
  // @ts-expect-error Build apply requires an idempotency key.
  await expect(client.retryBuildApply('a')).rejects.toThrow('idempotencyKey')
  for (const key of ['', ' \t ']) {
    await expect(client.createBuildAgent({}, key)).rejects.toThrow('idempotencyKey')
    await expect(client.retryBuildApply('a', key)).rejects.toThrow('idempotencyKey')
  }
  expect(fetch).not.toHaveBeenCalled()
})

test.each(['false', 1, null])('Build confirmation rejects non-boolean %s before HTTP', async (confirm) => {
  const fetch = vi.fn()
  const client = createZooworkClient({ apiKey, baseUrl, fetch })
  await expect(client.retryBuildApply('a', 'once', {
    // @ts-expect-error Exercise plain JavaScript inputs at runtime.
    confirm_rebuild: confirm, expected_revision_id: 'r1', expected_config_version: 4,
  })).rejects.toThrow(TypeError)
  expect(fetch).not.toHaveBeenCalled()
})

test.each<[number, string, (client: ZooworkClient) => Promise<unknown>]>([
  [404, 'agent.build_run_not_found', (c) => c.getBuildRun('a', 'r')],
  [409, 'agent.build_not_enabled', (c) => c.getBuild('a')],
  [400, 'agent.invalid_idempotency_key', (c) => c.retryBuildApply('a', 'k'.repeat(201))],
  [400, 'agent.build_attachments_unsupported', (c) => c.postEvents('a', 's', [
    { type: 'user.message', content: 'text', attachments: [{ artifact_id: 'art_1' }] },
  ])],
  [409, 'agent.build_managed_configuration', (c) => c.updateAgent('a', { name: 'Name' })],
])('Build server error %i %s passes through', async (status, code, call) => {
  const fetch = async () => Response.json({ code, detail: 'Synthetic gateway error' }, { status })
  const result = call(createZooworkClient({ apiKey, baseUrl, fetch }))
  await expect(result).rejects.toBeInstanceOf(ZooworkError)
  await expect(result).rejects.toMatchObject({ status, code })
})
