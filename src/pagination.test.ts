import { expect, test } from 'vitest'
import { createZooworkClient, ZooworkError } from './index.js'

// Synthetic HTTP responses; no live API calls or recorded fixtures.
function harness(respond: (page: number, call: number) => unknown | Response) {
  const calls: URL[] = []
  const client = createZooworkClient({
    apiKey: 'zct_test_key',
    baseUrl: 'https://api.test/service/v1',
    fetch: async (input, init) => {
      const url = new URL(input)
      calls.push(url)
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer zct_test_key')
      const body = respond(Number(url.searchParams.get('page') ?? 1), calls.length)
      return body instanceof Response ? body : Response.json(body)
    },
  })
  return { client, calls }
}

function response(page: number, total: number, pageSize = 2) {
  const start = (page - 1) * pageSize
  return {
    page, page_size: pageSize, total,
    agents: Array.from({ length: Math.max(0, Math.min(pageSize, total - start)) }, (_, i) => ({
      agent_id: `agt_${start + i + 1}`,
    })),
  }
}

test('await listAgents returns one page with metadata and explicit next-page navigation', async () => {
  const { client, calls } = harness(page => response(page, 3))
  const first = await client.listAgents()
  expect(first.data.map(agent => agent.agent_id)).toEqual(['agt_1', 'agt_2'])
  expect(first).toMatchObject({ page: 1, page_size: 2, total: 3, next_page: 2 })
  expect(first.hasNextPage()).toBe(true)
  expect(calls).toHaveLength(1)

  const last = await first.getNextPage()
  expect(last.data.map(agent => agent.agent_id)).toEqual(['agt_3'])
  expect(last.next_page).toBeNull()
  expect(last.hasNextPage()).toBe(false)
  await expect(last.getNextPage()).rejects.toThrow('No next page')
  expect(calls).toHaveLength(2)
})

test('for await on the list request fetches all pages, preserving filters and the starting page', async () => {
  const { client, calls } = harness(page => response(page, 7))
  const opts = { page: 2, labels: { workspace_id: 'workspace one', pack_id: 'pack&two' } }
  const request = client.listAgents(opts)
  // Mutating the caller's options must not change a walk that has already started.
  opts.page = 99
  opts.labels.workspace_id = 'other workspace'
  const ids: string[] = []
  for await (const agent of request) ids.push(agent.agent_id)
  expect(ids).toEqual(['agt_3', 'agt_4', 'agt_5', 'agt_6', 'agt_7'])
  expect(calls.map(url => url.searchParams.get('page'))).toEqual(['2', '3', '4'])
  for (const url of calls) {
    expect(url.pathname).toBe('/service/v1/agents')
    expect(url.searchParams.get('label.workspace_id')).toBe('workspace one')
    expect(url.searchParams.get('label.pack_id')).toBe('pack&two')
  }
})

test('the resolved page is also iterable and reuses the first response', async () => {
  const { client, calls } = harness(page => response(page, 3))
  const request = client.listAgents()
  const first = await request
  expect(await request).toBe(first)
  const ids: string[] = []
  for await (const agent of first) ids.push(agent.agent_id)
  expect(ids).toEqual(['agt_1', 'agt_2', 'agt_3'])
  expect(calls).toHaveLength(2)
})

test('breaking iteration does not request the next page', async () => {
  const { client, calls } = harness(page => response(page, 5))
  for await (const agent of client.listAgents()) {
    expect(agent.agent_id).toBe('agt_1')
    break
  }
  expect(calls).toHaveLength(1)
})

test('the 101st agent is reachable after the fixed 100-item API page', async () => {
  const { client, calls } = harness(page => response(page, 101, 100))
  const ids: string[] = []
  for await (const agent of client.listAgents()) ids.push(agent.agent_id)
  expect(ids).toHaveLength(101)
  expect(ids.at(-1)).toBe('agt_101')
  expect(calls.map(url => url.searchParams.get('page'))).toEqual([null, '2'])
  expect(calls.every(url => !url.searchParams.has('limit'))).toBe(true)
})

test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'invalid starting page %s rejects without an HTTP request', async page => {
    const { client, calls } = harness(value => response(value, 3))
    await expect(client.listAgents({ page })).rejects.toThrow(RangeError)
    expect(calls).toHaveLength(0)
  },
)

test.each([0, 2, 4])('pagination stops without an extra empty fetch when total is %i', async total => {
  const { client, calls } = harness(page => response(page, total))
  const ids: string[] = []
  for await (const agent of client.listAgents()) ids.push(agent.agent_id)
  expect(ids).toHaveLength(total)
  expect(calls).toHaveLength(Math.max(1, Math.ceil(total / 2)))
})

test('iterPages yields page objects and exposes the last cursor as null', async () => {
  const { client, calls } = harness(page => response(page, 5))
  const first = await client.listAgents()
  const pages = []
  for await (const page of first.iterPages()) pages.push({ page: page.page, next: page.next_page })
  expect(pages).toEqual([{ page: 1, next: 2 }, { page: 2, next: 3 }, { page: 3, next: null }])
  expect(calls).toHaveLength(3)
})

test('a later-page HTTP error rejects iteration instead of returning partial success', async () => {
  const { client, calls } = harness(page => page === 1 ? response(1, 3) : Response.json(
    { code: 'service_api.forbidden', detail: 'Forbidden' }, { status: 403 },
  ))
  const seen: string[] = []
  const walk = async () => {
    for await (const agent of client.listAgents()) seen.push(agent.agent_id)
  }
  await expect(walk()).rejects.toMatchObject({ status: 403, type: 'service_api.forbidden' })
  expect(seen).toEqual(['agt_1', 'agt_2'])
  expect(calls).toHaveLength(2)
})

test('a rejected first page supports both Promise error handling and asynchronous iteration', async () => {
  const { client, calls } = harness(() => Response.json({ code: 'unauthorized' }, { status: 401 }))
  const request = client.listAgents()
  await expect(request).rejects.toBeInstanceOf(ZooworkError)
  const walk = async () => { for await (const _agent of request) { /* consume */ } }
  await expect(walk()).rejects.toMatchObject({ status: 401 })
  expect(calls).toHaveLength(1)
})

test.each([
  {},
  { agents: [] },
  { ...response(1, 0), page_size: 0 },
  { ...response(1, 0), total: -1 },
  { ...response(1, 0), agents: null },
])('missing or invalid pagination metadata fails visibly: %j', async body => {
  const { client } = harness(() => body)
  await expect(client.listAgents()).rejects.toThrow('Invalid agent list pagination')
})

test('a server that repeats a page fails instead of repeating agents indefinitely', async () => {
  const { client, calls } = harness(() => response(1, 4))
  const walk = async () => { for await (const _agent of client.listAgents()) { /* consume */ } }
  await expect(walk()).rejects.toThrow('Invalid agent list pagination')
  expect(calls).toHaveLength(2)
})
