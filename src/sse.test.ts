/**
 * SSE frame parser. Its own file, because it is plumbing: `streamEvents` is only as correct as
 * this is, and every failure mode below (a dropped `id:`, a split `data:`, a last frame with no
 * trailing blank line) silently loses events rather than throwing.
 *
 * Fed from `new Response(text).body`, i.e. a real `ReadableStream<Uint8Array>` decoded by a real
 * `TextDecoder` — the same path the live stream takes.
 */
import { expect, test } from 'vitest'
import { createZooworkClient, isRunFinished, parseSSE } from './index.js'

test('breaking a session stream at run.finished cancels its body and releases the reader', async () => {
  let cancelled = 0
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('id: pse1:1\ndata: {"seq":1,"event_type":"run.finished","payload":{"status":"succeeded"}}\n\n'))
      // Session streams remain open after a turn; the consumer owns cancellation.
    },
    cancel() { cancelled++ },
  })
  const client = createZooworkClient({ apiKey: 'zwp_live_' + 'X'.repeat(43),
    fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  })
  for await (const event of client.streamEvents('agt_SYNTHETIC', 'SYNTHETIC_SESSION')) {
    if (isRunFinished(event)) break
  }
  expect(cancelled).toBe(1)
  expect(body.locked).toBe(false)
})

const stream = (text: string): ReadableStream<Uint8Array> => new Response(text).body as ReadableStream<Uint8Array>

const collect = async (text: string): Promise<unknown[]> => {
  const out: unknown[] = []
  for await (const m of parseSSE(stream(text))) out.push(m)
  return out
}

test('parseSSE keeps the id line — dropping it would freeze the resume cursor', async () => {
  // `id:` carries the durable seq. `streamEvents` resumes from it, so a parser that discards
  // unknown fields would reconnect at 0 and replay the whole session.
  expect(await collect('id: 12\nevent: message\ndata: {"seq":12}\n\n')).toEqual([{ event: 'message', id: '12', data: { seq: 12 } }])
})

test('parseSSE joins multi-line data with a newline before parsing it as JSON', async () => {
  // One JSON document split across frames by the server's writer, not two events.
  expect(await collect('event: a\ndata: {"x":\ndata: 1}\n\n')).toEqual([{ event: 'a', data: { x: 1 } }])
  // Non-JSON stays a string, and keeps the newline the wire put in it.
  expect(await collect('event: a\ndata: one\ndata: two\n\n')).toEqual([{ event: 'a', data: 'one\ntwo' }])
})

test('parseSSE strips CR on CRLF wires and skips comment keepalives', async () => {
  expect(await collect(': keepalive\r\nevent: a\r\ndata: {"x":1}\r\n\r\n')).toEqual([{ event: 'a', data: { x: 1 } }])
  // A comment alone flushes nothing — no empty frame reaches the caller.
  expect(await collect(': keepalive\n\n')).toEqual([])
})

test('parseSSE emits the final frame even with no trailing blank line', async () => {
  // How a stream ends when the server closes it on idle. Dropping this loses the last event, which
  // on this API is usually `run.finished` — the one the caller is waiting for.
  expect(await collect('event: a\ndata: {"x":1}\n\nevent: b\ndata: tail\n')).toEqual([
    { event: 'a', data: { x: 1 } },
    { event: 'b', data: 'tail' },
  ])
})

test('parseSSE emits a complete final event with no terminating newline', async () => {
  expect(await collect('event: b\ndata: {"seq":13}')).toEqual([{ event: 'b', data: { seq: 13 } }])
})

test('parseSSE accepts CR and split CRLF and ignores IDs containing NUL', async () => {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('\ufeffid: opaque:1\r'))
      controller.enqueue(encoder.encode('\nid: bad\0id\rdata: {"seq":1}\r\rdata: tail'))
      controller.close()
    },
  })
  const messages = []
  for await (const message of parseSSE(body)) messages.push(message)
  expect(messages).toEqual([
    { event: 'message', id: 'opaque:1', data: { seq: 1 } },
    { event: 'message', data: 'tail' },
  ])
})

test('parseSSE defaults the event name to message and resets fields between frames', async () => {
  expect(await collect('data: {"a":1}\n\nevent: named\ndata: {"b":2}\n\ndata: {"c":3}\n\n')).toEqual([
    { event: 'message', data: { a: 1 } },
    { event: 'named', data: { b: 2 } },
    // `named` and any id must NOT leak into the following frame.
    { event: 'message', data: { c: 3 } },
  ])
  expect(await collect('id: 7\ndata: {"a":1}\n\ndata: {"b":2}\n\n')).toEqual([
    { event: 'message', id: '7', data: { a: 1 } },
    { event: 'message', data: { b: 2 } },
  ])
})
