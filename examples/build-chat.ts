/** Single-customer loopback demo. Run with pnpm exec tsx examples/build-chat.ts. */
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { assistantText, createZooworkClient, runOutcome, toolCall, ZooworkError } from '../src/index.js'

const host = '127.0.0.1'
const port = 18082
const origin = `http://${host}:${port}`
const sdk = createZooworkClient() // Reads ZOOWORK_API_KEY on the server.
const page = await readFile(new URL('./build-chat.html', import.meta.url))
const sessions = new Map<string, Set<string>>()

class RequestError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}

function json(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(body))
}

async function input(request: IncomingMessage) {
  if (request.headers['content-type'] !== 'application/json') {
    throw new RequestError(415, 'json_required')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > 64_000) throw new RequestError(413, 'body_too_large')
    chunks.push(chunk)
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const key = body.request_id
    if (typeof key === 'string' && key.trim() && key.length <= 200) return { body, key }
  } catch {
    // Invalid JSON or a non-object body.
  }
  throw new RequestError(400, 'invalid_body')
}

function requiredText(value: unknown, limit: number): string {
  if (typeof value === 'string' && value.trim() && value.length <= limit) return value
  throw new RequestError(400, 'invalid_body')
}

async function stream(request: IncomingMessage, response: ServerResponse, agent: string, session: string) {
  const abort = new AbortController()
  response.once('close', () => abort.abort())
  response.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no',
  })
  response.flushHeaders()
  // EventSource supplies this header on reconnection. Pass it through as an opaque cursor.
  const cursor = request.headers['last-event-id']
  try {
    for await (const event of sdk.streamEvents(agent, session, {
      cursor: typeof cursor === 'string' ? cursor : undefined, signal: abort.signal,
    })) {
      const kind = event.eventType
      const row = { kind, run_id: event.runId }
      const text = assistantText(event)
      const tool = toolCall(event)
      const data = text ? { ...row, text }
        : tool ? { ...row, tool: tool.toolName, phase: tool.phase }
        : kind === 'run.finished' ? { ...row, status: runOutcome(event) }
        : kind === 'run.started' ? row : undefined
      if (data) {
        const id = event.cursor ? `id: ${event.cursor}\n` : ''
        const frame = `${id}data: ${JSON.stringify(data)}\n\n`
        if (!response.write(frame)) await once(response, 'drain', { signal: abort.signal })
      }
    }
  } finally {
    // Ending the stream lets EventSource reconnect from its last delivered ID.
    response.end()
  }
}

createServer(async (request, response) => {
  try {
    if (request.headers.host !== `${host}:${port}` ||
        (request.headers.origin && request.headers.origin !== origin)) {
      throw new RequestError(403, 'invalid_origin')
    }
    const path = new URL(request.url!, origin).pathname
    const method = request.method
    if (method === 'GET' && path === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(page)
      return
    }
    if (method === 'POST' && path === '/api/agents') {
      const { body, key } = await input(request)
      const name = requiredText(body.name, 128)
      const { agent_id, build_session_id } = await sdk.createBuildAgent({ name }, key)
      if (!sessions.has(agent_id)) sessions.set(agent_id, new Set())
      sessions.get(agent_id)!.add(build_session_id)
      return json(response, { agent_id, build_session_id })
    }

    const [, , , agentPart, resource, sessionPart, action] = path.split('/')
    const agent = decodeURIComponent(agentPart ?? '')
    const knownSessions = sessions.get(agent)
    if (!path.startsWith('/api/agents/') || !knownSessions) throw new RequestError(404, 'unknown_agent')
    if (method === 'POST' && resource === 'tasks' && sessionPart === undefined) {
      const { key } = await input(request)
      const { session_id } = await sdk.createSession(agent, {}, key)
      knownSessions.add(session_id)
      return json(response, { session_id })
    }
    if (method === 'GET' && resource === 'runs' && sessionPart && action === undefined) {
      const outcome = await sdk.getBuildRun(agent, decodeURIComponent(sessionPart))
      return json(response, {
        change: outcome.change,
        apply_state: outcome.change === 'committed' ? outcome.apply.state : null,
      })
    }
    const session = decodeURIComponent(sessionPart ?? '')
    if (resource !== 'sessions' || !knownSessions.has(session)) throw new RequestError(404, 'unknown_session')
    if (method === 'POST' && action === 'messages') {
      const { body, key } = await input(request)
      const content = requiredText(body.text, 8000)
      await sdk.postEvents(agent, session, [{ type: 'user.message', content, idempotency_key: key }])
      return json(response, { accepted: true })
    }
    if (method === 'GET' && action === 'stream') return await stream(request, response, agent, session)
    throw new RequestError(404, 'unknown_route')
  } catch (error) {
    if (response.headersSent || response.destroyed) return response.end()
    if (error instanceof RequestError) return json(response, { detail: error.code }, error.status)
    if (error instanceof ZooworkError) {
      return json(response, { detail: error.code ?? 'platform_request_failed' }, error.status || 502)
    }
    return json(response, { detail: 'platform_request_failed' }, 502)
  }
}).listen(port, host, () => console.log(origin))
