/**
 * SSE frame parser. Its own file, because it is plumbing: `streamEvents` is only as correct as
 * this is, and every failure mode below (a dropped `id:`, a split `data:`, a last frame with no
 * trailing blank line) silently loses events rather than throwing.
 *
 * Fed from `new Response(text).body`, i.e. a real `ReadableStream<Uint8Array>` decoded by a real
 * `TextDecoder` — the same path the live stream takes.
 */
import { expect, test } from 'vitest'
import { parseSSE } from './index.js'

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

test('parseSSE discards a last line that has no newline of its own', async () => {
  // The boundary the test above stops one character short of, pinned because it is a real data
  // loss and not an obvious one: line splitting is on `\n`, so a stream cut mid-line leaves that
  // line in the buffer and only the completed lines flush. Matches the EventSource rule that an
  // incomplete final line is discarded — but it means `data:` truncated by a dropped connection
  // arrives EMPTY rather than not at all. Resume from the last seq you saw; do not trust a tail.
  expect(await collect('event: b\ndata: tail')).toEqual([{ event: 'b', data: '' }])
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
