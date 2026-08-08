/**
 * Event normalization. The same event arrives in two spellings (REST snake_case, SSE camelCase)
 * and callers are promised one shape, so both wire shapes are pinned here. The frame parser those
 * events come out of has its own file, `sse.test.ts`.
 *
 * Imported through `./index.js`, the published entry point, so a helper that stops being exported
 * fails a test instead of a consumer's build.
 */
import { expect, test } from 'vitest'
import { assistantText, isRunFinished, messageText, normalizeEvent, runOutcome, thinkingText, toolCall } from './index.js'

test('normalizeEvent folds the REST and SSE spellings into one shape', () => {
  const rest = normalizeEvent({ seq: 4, event_type: 'agent.assistant', payload: { a: 1 }, run_id: 'r1', turn: 2, created_at: 't1' })
  const sse = normalizeEvent({ seq: 4, eventType: 'agent.assistant', payload: { a: 1 }, runId: 'r1', turn: 2, createdAt: 't1' })
  expect(rest).toEqual(sse)
  expect(rest).toEqual({ seq: 4, eventType: 'agent.assistant', payload: { a: 1 }, runId: 'r1', turn: 2, createdAt: 't1' })
})

test('normalizeEvent falls back to the SSE id line for seq, and defaults the rest', () => {
  expect(normalizeEvent({ eventType: 'x' }, '9').seq).toBe(9)
  expect(normalizeEvent({ eventType: 'x' }, 'not-a-number').seq).toBe(-1)
  const empty = normalizeEvent(null)
  expect(empty).toEqual({ seq: -1, eventType: '', payload: {} })
})

test('run outcome reads only run.finished', () => {
  const finished = normalizeEvent({ seq: 1, eventType: 'run.finished', payload: { status: 'failed' } })
  expect(isRunFinished(finished)).toBe(true)
  expect(runOutcome(finished)).toBe('failed')
  const other = normalizeEvent({ seq: 2, eventType: 'agent.tool', payload: { status: 'failed' } })
  expect(isRunFinished(other)).toBe(false)
  expect(runOutcome(other)).toBeUndefined()
  expect(runOutcome(normalizeEvent({ seq: 3, eventType: 'run.finished', payload: { status: 'weird' } }))).toBeUndefined()
})

test('messageText concatenates text blocks and ignores tool blocks', () => {
  expect(messageText({ role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'tool_use', name: 'x' }, { type: 'text', text: 'b' }] })).toBe('ab')
  expect(messageText({ role: 'user', content: 'plain' })).toBe('plain')
  expect(messageText(undefined)).toBe('')
})

test('assistantText / thinkingText are typed to their own event', () => {
  const assistant = normalizeEvent({ seq: 1, eventType: 'agent.assistant', payload: { message: { content: [{ type: 'text', text: 'hi' }] } } })
  expect(assistantText(assistant)).toBe('hi')
  expect(thinkingText(assistant)).toBe('')
  const thinking = normalizeEvent({ seq: 2, eventType: 'agent.thinking', payload: { text: 'hmm' } })
  expect(thinkingText(thinking)).toBe('hmm')
  expect(assistantText(thinking)).toBe('')
})

test('toolCall pairs by toolCallId and keeps `blocked` distinct from `end`', () => {
  const start = toolCall(normalizeEvent({ seq: 1, eventType: 'agent.tool', payload: { phase: 'start', toolName: 'bash', toolCallId: 'c1', args: { cmd: 'ls' } } }))
  expect(start).toEqual({ phase: 'start', toolName: 'bash', toolCallId: 'c1', args: { cmd: 'ls' } })
  const end = toolCall(normalizeEvent({ seq: 2, eventType: 'agent.tool', payload: { phase: 'end', toolName: 'bash', toolCallId: 'c1', isError: true, resultPreview: 'boom' } }))
  expect(end).toEqual({ phase: 'end', toolName: 'bash', toolCallId: 'c1', isError: true, resultPreview: 'boom' })
  expect(toolCall(normalizeEvent({ seq: 3, eventType: 'agent.tool', payload: { phase: 'blocked', toolName: 'bash', toolCallId: 'c1' } }))?.phase).toBe('blocked')
  expect(toolCall(normalizeEvent({ seq: 4, eventType: 'chat.final', payload: {} }))).toBeUndefined()
})
