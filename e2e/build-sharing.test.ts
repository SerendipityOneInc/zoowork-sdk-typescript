import assert from 'node:assert/strict'
import test from 'node:test'
import { trackUpdate } from '../examples/build-sharing.js'
import { createZooworkClient, ZooworkError, type InstalledAgentUpdateStatus } from '../src/index.js'

const confirmation = {
  target_source_revision_id: 'published',
  expected_local_revision_id: 'local',
  confirm_rebuild: true,
  expected_config_version: 2,
}
const blocked: InstalledAgentUpdateStatus = {
  source_revision_id: 'old',
  active_revision_id: 'local',
  state: 'needs_retry',
  apply: { state: 'blocked', config_version: 2, phase: null, blockers: [] },
}

for (const [status, code] of [
  [503, 'agent_environment.building'],
  [409, 'agent_revision.changed'],
  [503, 'agent.unavailable'],
] as const) {
  test(`the sharing example handles ${status} ${code}`, async () => {
    const requests: string[] = []
    const signal = AbortSignal.timeout(10_000)
    const installer = createZooworkClient({
      apiKey: 'zwp_synthetic',
      baseUrl: 'https://api.test/service/v1',
      fetch: async (_, init) => {
        const method = init?.method ?? 'GET'
        requests.push(method)
        if (method === 'POST') {
          assert.equal(new Headers(init?.headers).get('Idempotency-Key'), 'original')
          assert.deepEqual(JSON.parse(String(init?.body)), confirmation)
        }
        if (requests.length === 1) return Response.json({ code, detail: 'Update unavailable' }, { status })
        return Response.json(method === 'POST'
          ? { ...blocked, apply: { ...blocked.apply, state: 'in_progress', phase: 'preparing' } }
          : { ...blocked, apply: { ...blocked.apply, state: 'applied' } })
      },
    })
    const run = trackUpdate(installer, 'copy', blocked, signal, () =>
      installer.updateInstalledAgent('copy', confirmation, 'original'))

    if (code === 'agent_environment.building') {
      assert.equal((await run).apply.state, 'applied')
      assert.deepEqual(requests, ['POST', 'POST', 'GET'])
    } else {
      await assert.rejects(run, (error) =>
        error instanceof ZooworkError && error.status === status && error.code === code)
      assert.deepEqual(requests, ['POST'])
    }
  })
}

test('the sharing example stops retrying at the total timeout', async () => {
  const installer = { getUpdateStatus: async () => assert.fail('must not poll before acceptance') }
  let submissions = 0
  const run = trackUpdate(installer, 'copy', blocked, AbortSignal.timeout(25), async () => {
    submissions++
    throw new ZooworkError(503, 'Still building', undefined, { code: 'agent_environment.building' })
  })
  await assert.rejects(run, { name: 'AbortError' })
  assert.equal(submissions, 1)
})
