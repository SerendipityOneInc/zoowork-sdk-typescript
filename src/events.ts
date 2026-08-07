/**
 * Session event normalization.
 *
 * The wire presents the SAME event in two different shapes depending on where you read it:
 *
 *   REST  GET /events        → { seq, run_id, turn, event_type, payload, created_at }
 *   SSE   GET /events/stream → { seq, runId, turn, eventType, payload, createdAt, version, engine, sessionId }
 *
 * Neither carries a top-level `type`. `normalizeEvent` absorbs both shapes once, so callers
 * switch on a single field. Verified against staging 2026-08-05.
 *
 * The vocabulary is SESSION_EVENT_TYPES mirrored from the API. Unknown
 * types pass through unchanged rather than throwing — the API is Developer Preview and may
 * add types within a version.
 */

/** SESSION_EVENT_TYPES, mirrored from the API. */
export const SESSION_EVENT_TYPES = [
  'run.started',
  'run.finished',
  'chat.delta',
  'chat.final',
  'chat.aborted',
  'chat.error',
  'agent.lifecycle',
  'agent.assistant',
  'agent.thinking',
  'agent.tool',
  'agent.item',
  'agent.plan',
  'agent.approval',
  'agent.command_output',
  'agent.patch',
  'agent.compaction',
  'agent.error',
  'attachment.created',
  'message.outbound',
] as const

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number]

/** A durable session event, normalized across the REST and SSE shapes. */
export interface SessionEvent {
  /** Durable per-session sequence. Use as the `after` cursor when resuming. */
  seq: number
  eventType: SessionEventType | string
  payload: Record<string, unknown>
  runId?: string
  turn?: number
  createdAt?: string
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object'
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** Accepts either wire shape (and an SSE `id:` line as the seq fallback). */
export function normalizeEvent(raw: unknown, sseId?: string): SessionEvent {
  const r = isObj(raw) ? raw : {}
  let seq = typeof r.seq === 'number' ? r.seq : -1
  if (seq < 0 && sseId !== undefined) {
    const n = Number(sseId)
    if (Number.isFinite(n)) seq = n
  }
  const turn = typeof r.turn === 'number' ? r.turn : undefined
  return {
    seq,
    eventType: str(r.eventType) ?? str(r.event_type) ?? '',
    payload: isObj(r.payload) ? r.payload : {},
    ...(str(r.runId) ?? str(r.run_id) ? { runId: (str(r.runId) ?? str(r.run_id))! } : {}),
    ...(turn !== undefined ? { turn } : {}),
    ...(str(r.createdAt) ?? str(r.created_at) ? { createdAt: (str(r.createdAt) ?? str(r.created_at))! } : {}),
  }
}

/**
 * A run ends with `run.finished`. Its `payload.status` is `succeeded` | `failed` | `aborted`.
 *
 * Note that a run can finish `succeeded` even when individual tool calls errored — an
 * `agent.tool` event with `payload.isError === true` does not fail the run. Do not infer
 * turn success from the absence of tool errors.
 */
export function isRunFinished(e: SessionEvent): boolean {
  return e.eventType === 'run.finished'
}

export function runOutcome(e: SessionEvent): 'succeeded' | 'failed' | 'aborted' | undefined {
  if (!isRunFinished(e)) return undefined
  const s = e.payload.status
  return s === 'succeeded' || s === 'failed' || s === 'aborted' ? s : undefined
}

/**
 * Text of one chat message — the `{ role, content }` shape that appears both as an
 * `agent.assistant` event's `payload.message` and as a transcript row's `entry.message`.
 *
 * `content` is normally an array of blocks; only `{ type: 'text', text }` blocks carry
 * text (tool-call blocks don't), and one message may hold several. A plain string is
 * accepted too — that is how write-side `user.message` content comes back.
 */
export function messageText(message: unknown): string {
  if (!isObj(message)) return ''
  const c = message.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c.map((b) => (isObj(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('')
}

/**
 * Assistant text for an `agent.assistant` event; '' for every other event type.
 *
 * The text lives at `payload.message.content[]` — see `messageText`.
 */
export function assistantText(e: SessionEvent): string {
  if (e.eventType !== 'agent.assistant') return ''
  return messageText(e.payload.message)
}

/** Reasoning text for an `agent.thinking` event; '' for every other type. */
export function thinkingText(e: SessionEvent): string {
  if (e.eventType !== 'agent.thinking') return ''
  return typeof e.payload.text === 'string' ? e.payload.text : ''
}

export interface ToolCall {
  phase: 'start' | 'end' | 'blocked'
  toolName: string
  toolCallId: string
  args?: Record<string, unknown>
  isError?: boolean
  resultPreview?: string
}

/**
 * Tool activity for an `agent.tool` event; undefined for every other type.
 *
 * One tool call produces TWO events sharing a `toolCallId`: `phase: 'start'` carries `args`,
 * `phase: 'end'` carries `isError` and `resultPreview`. Pair them by `toolCallId` — they are
 * NOT adjacent in the stream when calls run concurrently.
 *
 * `phase: 'blocked'` is a third state (see the Events reference): the call is waiting on an
 * approval and has NOT run. Treat it as pending, not as an end — the matching `agent.approval`
 * event carries the request, and an `end` still follows once it resolves.
 */
export function toolCall(e: SessionEvent): ToolCall | undefined {
  if (e.eventType !== 'agent.tool') return undefined
  const p = e.payload
  const phase = p.phase === 'end' ? 'end' : p.phase === 'blocked' ? 'blocked' : 'start'
  return {
    phase,
    toolName: typeof p.toolName === 'string' ? p.toolName : '',
    toolCallId: typeof p.toolCallId === 'string' ? p.toolCallId : '',
    ...(isObj(p.args) ? { args: p.args } : {}),
    ...(typeof p.isError === 'boolean' ? { isError: p.isError } : {}),
    ...(typeof p.resultPreview === 'string' ? { resultPreview: p.resultPreview } : {}),
  }
}
