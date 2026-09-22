/**
 * Receiving webhooks: the event vocabulary, and Standard Webhooks verification of a raw body.
 *
 * Engine emits plain [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks),
 * so nothing here is invented. Three headers arrive with every POST:
 *
 * ```text
 * webhook-id:        <event id>
 * webhook-timestamp: <unix seconds of THIS send attempt, not of the event>
 * webhook-signature: v1,<base64 HMAC> [v1,<base64 HMAC under the other active secret>]
 *
 * signed_bytes = UTF8(event_id + "." + timestamp + ".") || raw_body
 * signature    = HMAC-SHA256(decoded_secret, signed_bytes)
 * secret       = "whsec_" + base64(32 bytes)
 * ```
 *
 * Two things the shape above decides for you:
 *
 * - **You need the RAW bytes.** `JSON.parse` then `JSON.stringify` does not round-trip a body
 *   byte for byte (key order survives, but whitespace and non-ASCII escaping do not), and the
 *   signature covers bytes. Read the body before any JSON middleware touches it — Express
 *   `express.json()` and most framework body parsers consume it. {@link unwrapWebhook} parses
 *   only after the signature has verified, and never re-serializes.
 * - **The window is checked against `webhook-timestamp`, never against the envelope's
 *   `created_at`.** A retry of a two-hour-old event carries a fresh timestamp and verifies; the
 *   envelope still says when the fact happened.
 *
 * Two `v1,` entries mean a rotation window is open: the sender signs under every active secret,
 * so pass them all (`secret: [newest, previous]`) and any one match accepts.
 *
 * Zero runtime dependencies, so this is WebCrypto (`crypto.subtle`) rather than `node:crypto` —
 * it runs in Node, Deno, Bun, Workers and the browser, and it is why the API is `async`. The
 * comparison is `crypto.subtle.verify`, which is constant-time; this module never compares
 * signatures with `===`.
 *
 * A receiver that would rather not use this SDK can verify the same bytes with the official
 * Standard Webhooks library for its language (npm `standardwebhooks`, PyPI `standardwebhooks`,
 * and the other ports). `src/__vectors__/webhook-vectors.json` is byte-compatible with them.
 */

// ── event vocabulary ───────────────────────────────────────────────────────

/**
 * Event types the deployed Engine delivers, mirrored from its public projection.
 *
 * A type not in this list is NOT an error — see {@link isKnownWebhookEventType}.
 */
export const WEBHOOK_EVENT_TYPES = [
  'run.started',
  'run.finished',
  'run.yielded',
  'approval.requested',
  'approval.resolved',
  'custom_tool.requested',
  'custom_tool.resolved',
  'outcome.evaluated',
  'session.created',
  'session.archived',
  'session.deleted',
  'schedule.dispatched',
  'schedule.dispatch_failed',
  'schedule.skipped',
  'schedule.finished',
  'webhook.test',
] as const

/**
 * Schedule CONFIGURATION changes, as distinct from the fire events above.
 *
 * Declared here so a receiver can write the subscription and the handler now, but the server
 * side ships with Engine E5a and is NOT emitted yet — the projector currently retires such a
 * receipt as `unknown_source`. Do not read a delivered one of these as evidence the feature is
 * live; check the Engine release notes.
 */
export const WEBHOOK_SCHEDULE_CONFIG_EVENT_TYPES = [
  'schedule.created',
  'schedule.updated',
  'schedule.paused',
  'schedule.resumed',
  'schedule.deleted',
] as const

export type WebhookEventType =
  | (typeof WEBHOOK_EVENT_TYPES)[number]
  | (typeof WEBHOOK_SCHEDULE_CONFIG_EVENT_TYPES)[number]

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  ...WEBHOOK_EVENT_TYPES,
  ...WEBHOOK_SCHEDULE_CONFIG_EVENT_TYPES,
])

/**
 * Whether this SDK release knows a type.
 *
 * Engine adds event types within a schema version, so a receiver MUST tolerate one it has never
 * seen: acknowledge it with 2xx and ignore it. Failing an unknown type only makes the sender
 * retry it, and after that, dead-letter it.
 */
export function isKnownWebhookEventType(type: string): type is WebhookEventType {
  return KNOWN_EVENT_TYPES.has(type)
}

/**
 * Attribution and origin, prepended to every event's `data` by the sender.
 *
 * `resource_access` is `internal_only` when the underlying Session is Engine's own rather than
 * one you created through the public API; such a Session is not readable through the public API,
 * so a lookup after the event would 404. `org_id`/`owner_uid` are the credential the endpoint
 * belongs to — compare them if one process serves several tenants.
 */
export interface WebhookEventAttribution {
  org_id: string
  owner_uid: string
  /** Absent only on an owner-scope `webhook.test`, which belongs to no agent. */
  agent_id?: string
  session_origin?: 'api' | 'schedule' | 'channel' | 'internal'
  run_origin?: 'api' | 'channel' | 'none'
  resource_access?: 'public' | 'internal_only'
}

/** One schedule fire folded into a run event's summary. */
export interface WebhookScheduleRunRef {
  schedule_id: string
  fired_at: string
}

/** What a yielded run is waiting for. */
export interface WebhookWaitingOnRef {
  kind: 'child_session' | 'async_tool'
  id: string
}

/** Fields the three run events share. */
export interface WebhookRunEventData extends WebhookEventAttribution {
  session_id: string
  run_id: string
  turn?: number
  /** `public_session_events.id` of the input that started this run — an inbound event id, not a
   * public event id, and absent when nothing inbound triggered the run (a schedule fire). */
  origin_event_id?: string
  /** `pse1:<seq>` cursor of this fact's session-event projection; feed it to `streamEvents`. */
  event_cursor?: string
  /** The fires this run served. `schedule_runs_complete: false` means the list was truncated to
   * keep the envelope under its 16 KiB ceiling — read the schedule's runs for the rest. */
  schedule_runs?: WebhookScheduleRunRef[]
  schedule_runs_complete?: false
}

export interface WebhookRunStartedData extends WebhookRunEventData {
  trigger?: string
  parent_run_id?: string
}

export interface WebhookRunFinishedData extends WebhookRunEventData {
  status?: 'succeeded' | 'failed' | 'aborted'
  terminal_outcome?: string
  output_type?: string
  error_class?: string
  failure_stage?: string
}

/**
 * A run that stopped to wait, not a run that ended.
 *
 * Only a SUCCESSFUL yield becomes `run.yielded`; a failed or aborted turn stays `run.finished`
 * whatever it was waiting for. So the two are exclusive, and neither implies the other follows.
 */
export interface WebhookRunYieldedData extends WebhookRunEventData {
  waiting_on?: WebhookWaitingOnRef[]
  waiting_on_complete?: false
}

export interface WebhookApprovalEventData extends WebhookEventAttribution {
  approval_id: string
  session_id: string
  run_id: string
  event_cursor?: string
}

export interface WebhookApprovalRequestedData extends WebhookApprovalEventData {
  tool_call_id?: string
  tool_name?: string
  timeout_at?: string
}

export interface WebhookApprovalResolvedData extends WebhookApprovalEventData {
  /** `expired` is a timeout; a cancellation reads as `denied`. */
  status?: 'approved' | 'denied' | 'expired'
}

export interface WebhookCustomToolEventData extends WebhookEventAttribution {
  /** The custom-tool call id — `custom_tool_use_id` when you post the result back. */
  call_id: string
  session_id: string
  run_id: string
  event_cursor?: string
}

export interface WebhookCustomToolRequestedData extends WebhookCustomToolEventData {
  tool_call_id?: string
  tool_name?: string
  timeout_at?: string
}

export interface WebhookCustomToolResolvedData extends WebhookCustomToolEventData {
  status?: 'completed' | 'timeout' | 'cancelled'
}

export interface WebhookOutcomeEvaluatedData extends WebhookEventAttribution {
  session_id: string
  run_id: string
  event_cursor?: string
  /** 1-based evaluation round of this run. */
  iteration: number
  verdict: 'satisfied' | 'failed' | 'needs_revision' | 'evaluator_error'
  /** Present only when the verdict was assumed rather than graded (always with
   * `verdict: 'needs_revision'`). */
  skipped?: true
  grader_type?: string
  schedule_id?: string
}

export interface WebhookSessionCreatedData extends WebhookEventAttribution {
  session_id: string
  parent_session_id?: string
}

export interface WebhookSessionArchivedData extends WebhookEventAttribution {
  session_id: string
  archived_at?: string
}

export interface WebhookSessionDeletedData extends WebhookEventAttribution {
  session_id: string
  deleted_at?: string
}

/** Fields every schedule FIRE event shares. `fired_at` identifies the fire. */
export interface WebhookScheduleFireData extends WebhookEventAttribution {
  schedule_id: string
  fired_at: string
  job_kind?: string
}

export interface WebhookScheduleDispatchedData extends WebhookScheduleFireData {
  dispatch_mode?: string
  session_id?: string
}

export interface WebhookScheduleDispatchFailedData extends WebhookScheduleFireData {
  error_class?: string
}

export interface WebhookScheduleSkippedData extends WebhookScheduleFireData {
  reason?: string
}

export interface WebhookScheduleFinishedData extends WebhookScheduleFireData {
  result?: string
  exit_code?: number
  reason?: string
  session_id?: string
  run_id?: string
}

/**
 * A schedule's configuration changed. See {@link WEBHOOK_SCHEDULE_CONFIG_EVENT_TYPES}: declared,
 * not yet delivered.
 */
export interface WebhookScheduleConfigData extends WebhookEventAttribution {
  schedule_id: string
  /** Monotonic per schedule; the ordering to trust, since deliveries can overtake each other. */
  resource_version?: number
  enabled?: boolean
  changed_fields?: string[]
}

export interface WebhookTestData extends WebhookEventAttribution {
  endpoint_id: string
}

/** Each known type's `data` shape. */
export interface WebhookEventDataByType {
  'run.started': WebhookRunStartedData
  'run.finished': WebhookRunFinishedData
  'run.yielded': WebhookRunYieldedData
  'approval.requested': WebhookApprovalRequestedData
  'approval.resolved': WebhookApprovalResolvedData
  'custom_tool.requested': WebhookCustomToolRequestedData
  'custom_tool.resolved': WebhookCustomToolResolvedData
  'outcome.evaluated': WebhookOutcomeEvaluatedData
  'session.created': WebhookSessionCreatedData
  'session.archived': WebhookSessionArchivedData
  'session.deleted': WebhookSessionDeletedData
  'schedule.dispatched': WebhookScheduleDispatchedData
  'schedule.dispatch_failed': WebhookScheduleDispatchFailedData
  'schedule.skipped': WebhookScheduleSkippedData
  'schedule.finished': WebhookScheduleFinishedData
  'webhook.test': WebhookTestData
  'schedule.created': WebhookScheduleConfigData
  'schedule.updated': WebhookScheduleConfigData
  'schedule.paused': WebhookScheduleConfigData
  'schedule.resumed': WebhookScheduleConfigData
  'schedule.deleted': WebhookScheduleConfigData
}

/**
 * A known type's `data`, left open at the edges.
 *
 * The named fields are what the server sends today; a field a later Engine release adds reads
 * back as `unknown` instead of failing to compile. Nothing is ever removed or repurposed within
 * a `schema_version`, so a field that IS named stays what it says.
 */
export type WebhookEventData<T extends WebhookEventType> = WebhookEventDataByType[T] & Record<string, unknown>

/**
 * The delivered envelope, as received.
 *
 * `type` is typed loosely on purpose: a type this release does not know arrives as its raw
 * string rather than as an error. Narrow with {@link knownWebhookEvent} before switching.
 */
export interface WebhookEvent {
  object: 'event'
  /** `whe_...`; also the `webhook-id` header, and the idempotency key for your own handler —
   * a retry redelivers the SAME id. */
  id: string
  type: WebhookEventType | (string & {})
  /**
   * Envelope contract version, `1` today. A bump is announced; additive fields are not.
   *
   * Always an INTEGER value — {@link unwrapWebhook} rejects anything else, so a receiver may
   * compare it or switch on it without rounding first.
   */
  schema_version: number
  /** When the FACT happened, ISO-8601. Not when this attempt was sent — that is the
   * `webhook-timestamp` header, which {@link verifyWebhookSignature} returns. */
  created_at: string
  data: Record<string, unknown>
}

/** One envelope narrowed to a single known type. */
export type WebhookEventFor<T extends WebhookEventType> = Omit<WebhookEvent, 'type' | 'data'> & {
  type: T
  data: WebhookEventData<T>
}

/** Every known type as one discriminated union — `switch (event.type)` narrows `event.data`. */
export type KnownWebhookEvent = { [T in WebhookEventType]: WebhookEventFor<T> }[WebhookEventType]

/**
 * The envelope as a discriminated union, or `undefined` when this release does not know its type.
 *
 * `undefined` is the forward-compatible path, not a failure: acknowledge the delivery anyway.
 *
 * The value is the same object, re-typed — nothing is copied, normalized or validated. The
 * narrowing is on `type` alone; the `data` shape is the contract's, asserted rather than checked,
 * exactly as the rest of this SDK types API responses. That is sound because the body arrived
 * signed: verification already established that Engine wrote it.
 */
export function knownWebhookEvent(event: WebhookEvent): KnownWebhookEvent | undefined {
  return isKnownWebhookEventType(event.type) ? (event as KnownWebhookEvent) : undefined
}

// ── signature verification ─────────────────────────────────────────────────

const WEBHOOK_SECRET_PREFIX = 'whsec_'
const WEBHOOK_SECRET_BYTES = 32
const WEBHOOK_SIGNATURE_VERSION = 'v1'
/** Default clock tolerance, in seconds, in EITHER direction and inclusive. */
export const WEBHOOK_TOLERANCE_SECONDS = 300
/** The sender's envelope ceiling. A receiver refuses a larger body without hashing it. */
export const WEBHOOK_DEFAULT_MAX_BODY_BYTES = 16 * 1024
/**
 * Environment variable read when `secret` is omitted.
 *
 * Holds one secret, or several separated by whitespace or commas for a rotation window. The
 * Python SDK reads it identically, so one deployment's configuration serves both.
 */
export const WEBHOOK_SECRET_ENV = 'ZOOWORK_WEBHOOK_SECRET'

export const WEBHOOK_ID_HEADER = 'webhook-id'
export const WEBHOOK_TIMESTAMP_HEADER = 'webhook-timestamp'
export const WEBHOOK_SIGNATURE_HEADER = 'webhook-signature'

const SIGNATURE_BYTES = 32
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/
const TIMESTAMP_PATTERN = /^(?:0|[1-9][0-9]*)$/

export type WebhookErrorCode =
  | 'invalid_secret'
  | 'body_too_large'
  | 'missing_header'
  | 'invalid_header'
  | 'timestamp_out_of_window'
  | 'signature_mismatch'
  | 'invalid_payload'

/**
 * Every verification and unwrap failure.
 *
 * Match on {@link ZooworkWebhookError.code}, never on the message. The message names the failing
 * check and at most a header name — never a secret, a signature value, or body bytes — so it is
 * safe to log and to forward to your own error reporting.
 *
 * Separate from `ZooworkError`, which carries the HTTP `status` of an API call the SDK made.
 * Nothing here is an HTTP response; a receiver decides its own status, and the right one is
 * usually 400 for a bad signature and 2xx for anything it means to ignore.
 *
 * Cross-language note: the `code` strings are the contract and are identical in the Python SDK.
 * The class shape is not — there this is a subclass of that SDK's `ZooworkError`, carrying a 400
 * and `retryable=False`, which suits an exception hierarchy built around one base error. Match on
 * `code`, and do not port `instanceof` checks between the two.
 */
export class ZooworkWebhookError extends Error {
  code: WebhookErrorCode
  constructor(code: WebhookErrorCode, message: string) {
    super(message)
    this.name = 'ZooworkWebhookError'
    this.code = code
  }
}

/** fetch `Headers`, or anything else with a case-insensitive `get`. */
export interface WebhookHeaderSource {
  get(name: string): string | null | undefined
}

/**
 * Node `IncomingHttpHeaders` (lower-cased keys, arrays for repeated headers), a plain object in
 * any casing, or a `Headers`-like source.
 */
export type WebhookHeaders =
  | Readonly<Record<string, string | readonly string[] | undefined>>
  | WebhookHeaderSource

export interface VerifyWebhookInput {
  headers: WebhookHeaders
  /** The bytes exactly as received. A string is UTF-8 encoded; never pass re-serialized JSON. */
  rawBody: Uint8Array | string
  /**
   * The endpoint's `whsec_` secret, or every active secret during a rotation window (order does
   * not matter). A string here is always ONE secret; it is never split.
   *
   * Omitted, it defaults to {@link WEBHOOK_SECRET_ENV} — which MAY list several secrets separated
   * by whitespace or commas, so a rotation needs a configuration change rather than a code
   * change. That variable exists only where `process.env` does, so in a browser, Workers or Deno
   * pass the secret explicitly.
   */
  secret?: string | readonly string[]
  /** Receiver clock in MILLISECONDS, for tests and for replaying a captured delivery. */
  now?: number
  /** Defaults to {@link WEBHOOK_TOLERANCE_SECONDS}. Widen it only for a known-skewed clock. */
  toleranceSeconds?: number
  /** Defaults to {@link WEBHOOK_DEFAULT_MAX_BODY_BYTES}. */
  maxBodyBytes?: number
}

export interface VerifiedWebhook {
  /** `webhook-id`, which equals the envelope's `id`. Deduplicate your handler on it. */
  eventId: string
  /** `webhook-timestamp`, unix SECONDS of this send attempt. */
  timestamp: number
}

export interface SignWebhookInput {
  eventId: string
  /** Unix SECONDS. */
  timestamp: number
  body: Uint8Array | string
  /** One entry per secret; a rotation window double-signs. */
  secret: string | readonly string[]
}

/** The three headers a sender sets. */
export type WebhookSignatureHeaders = {
  [WEBHOOK_ID_HEADER]: string
  [WEBHOOK_TIMESTAMP_HEADER]: string
  [WEBHOOK_SIGNATURE_HEADER]: string
}

const utf8 = new TextEncoder()

/**
 * Read an environment variable without assuming a Node runtime — `process` is a ReferenceError,
 * not `undefined`, in a browser.
 */
function readEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  const value = proc?.env?.[name]
  return value === undefined || value === '' ? undefined : value
}

function decodeBase64(encoded: string): Uint8Array | undefined {
  if (!BASE64_PATTERN.test(encoded)) return undefined
  let binary: string
  try {
    binary = atob(encoded)
  } catch {
    return undefined // wrong length for base64; atob is the only length check there is
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** The raw HMAC key behind a `whsec_` secret; rejects anything but the exact format. */
function decodeSecret(secret: string): Uint8Array {
  if (typeof secret !== 'string' || !secret.startsWith(WEBHOOK_SECRET_PREFIX)) {
    throw new ZooworkWebhookError('invalid_secret', `webhook secret must start with ${WEBHOOK_SECRET_PREFIX}`)
  }
  const key = decodeBase64(secret.slice(WEBHOOK_SECRET_PREFIX.length))
  if (!key || key.byteLength !== WEBHOOK_SECRET_BYTES) {
    throw new ZooworkWebhookError('invalid_secret', `webhook secret must decode to ${WEBHOOK_SECRET_BYTES} bytes`)
  }
  return key
}

/**
 * Every secret to try, from the argument or from the environment.
 *
 * The ENVIRONMENT variable may hold several secrets separated by whitespace or commas, so a
 * receiver can sit through a rotation window by changing its configuration rather than its code.
 * Splitting is unambiguous because a secret is `whsec_` plus standard base64 of 32 bytes, an
 * alphabet that contains neither a comma nor whitespace. The Python SDK reads the variable the
 * same way, so one deployment's env works for both.
 *
 * An explicitly passed `secret` is taken exactly as given and is never split — a string is one
 * secret, and several go in an array.
 */
function resolveSecrets(secret: string | readonly string[] | undefined): Uint8Array[] {
  if (secret === undefined) {
    const configured = readEnv(WEBHOOK_SECRET_ENV)
    const fromEnv = configured === undefined ? [] : configured.split(/[\s,]+/).filter((entry) => entry.length > 0)
    if (fromEnv.length === 0) {
      throw new ZooworkWebhookError(
        'invalid_secret',
        `no webhook secret: pass secret, or set ${WEBHOOK_SECRET_ENV} to one secret, or to several separated by whitespace or commas (it needs a runtime with process.env)`,
      )
    }
    return fromEnv.map(decodeSecret)
  }
  const secrets = typeof secret === 'string' ? [secret] : secret
  if (secrets.length === 0) {
    throw new ZooworkWebhookError('invalid_secret', 'at least one webhook secret is required')
  }
  return secrets.map(decodeSecret)
}

function toBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === 'string' ? utf8.encode(value) : value
}

/** `UTF8(eventId + "." + timestamp + ".")` followed by the body bytes, unmodified. */
function signedPayload(eventId: string, timestamp: number, body: Uint8Array): Uint8Array {
  const prefix = utf8.encode(`${eventId}.${timestamp}.`)
  const payload = new Uint8Array(prefix.byteLength + body.byteLength)
  payload.set(prefix, 0)
  payload.set(body, prefix.byteLength)
  return payload
}

/**
 * Re-state a byte array as something `crypto.subtle` accepts.
 *
 * TypeScript 5.7 made `Uint8Array` generic over its buffer, and `BufferSource` admits only the
 * `ArrayBuffer` instantiation — a `Uint8Array` whose buffer type is still open (which is what a
 * caller's `rawBody` is) does not fit, although WebCrypto reads it perfectly well. Every array
 * that reaches `crypto.subtle` below was allocated in this module, so this asserts nothing that
 * is not already true; it exists so the assertion is written down once rather than four times.
 */
function bufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource
}

function hmacKey(raw: Uint8Array, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bufferSource(raw), { name: 'HMAC', hash: 'SHA-256' }, false, [usage])
}

function readHeader(headers: WebhookHeaders, name: string): string | readonly string[] | undefined {
  if (typeof (headers as WebhookHeaderSource).get === 'function') {
    return (headers as WebhookHeaderSource).get(name) ?? undefined
  }
  const record = headers as Readonly<Record<string, string | readonly string[] | undefined>>
  const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === name)
  return key === undefined ? undefined : record[key]
}

function requireHeader(headers: WebhookHeaders, name: string): string {
  const value = readHeader(headers, name)
  if (value === undefined) {
    throw new ZooworkWebhookError('missing_header', `${name} header is missing`)
  }
  // A repeated header arrives as an array. Picking one would be a guess about which send this
  // is, so a duplicate is refused rather than resolved. The Python SDK refuses it too, on the
  // same reasoning — this is deliberate shared behavior, not an implementation accident.
  if (typeof value !== 'string' || value.length === 0) {
    throw new ZooworkWebhookError('invalid_header', `${name} header must be a single non-empty value`)
  }
  return value
}

/**
 * The `v1` signatures in the header.
 *
 * Every entry must be `<version>,<value>`; a `v1` value must be base64 of 32 bytes. Another
 * version is skipped, not rejected — a future `v2` alongside `v1` must not break a `v1`
 * receiver. A header carrying ONLY non-`v1` entries therefore yields nothing to compare, and
 * verification ends as `signature_mismatch`.
 */
function parseSignatureHeader(header: string): Uint8Array[] {
  const signatures: Uint8Array[] = []
  for (const entry of header.split(' ')) {
    if (entry.length === 0) continue
    const separator = entry.indexOf(',')
    if (separator <= 0 || separator === entry.length - 1) {
      throw new ZooworkWebhookError('invalid_header', `${WEBHOOK_SIGNATURE_HEADER} entry must be <version>,<base64>`)
    }
    if (entry.slice(0, separator) !== WEBHOOK_SIGNATURE_VERSION) continue
    const decoded = decodeBase64(entry.slice(separator + 1))
    if (!decoded || decoded.byteLength !== SIGNATURE_BYTES) {
      throw new ZooworkWebhookError(
        'invalid_header',
        `${WEBHOOK_SIGNATURE_HEADER} ${WEBHOOK_SIGNATURE_VERSION} entry must decode to ${SIGNATURE_BYTES} bytes`,
      )
    }
    signatures.push(decoded)
  }
  return signatures
}

/**
 * Verify a delivery and return what its headers asserted.
 *
 * Checks run cheapest-first and fail closed: the secrets decode, the body is within its ceiling,
 * the three headers are present and well-formed, the timestamp is inside the tolerance, and only
 * then is every `v1` entry compared against every secret with `crypto.subtle.verify` (a
 * constant-time comparison). Any one match accepts. The body is never parsed here — an
 * unverified body is not yet data. Throws {@link ZooworkWebhookError} on every failure.
 */
export async function verifyWebhookSignature(input: VerifyWebhookInput): Promise<VerifiedWebhook> {
  const secrets = resolveSecrets(input.secret)

  const maxBodyBytes = input.maxBodyBytes ?? WEBHOOK_DEFAULT_MAX_BODY_BYTES
  const body = toBytes(input.rawBody)
  if (body.byteLength > maxBodyBytes) {
    throw new ZooworkWebhookError('body_too_large', `webhook body exceeds ${maxBodyBytes} bytes`)
  }

  const eventId = requireHeader(input.headers, WEBHOOK_ID_HEADER)
  const rawTimestamp = requireHeader(input.headers, WEBHOOK_TIMESTAMP_HEADER)
  const signatureHeader = requireHeader(input.headers, WEBHOOK_SIGNATURE_HEADER)
  if (!TIMESTAMP_PATTERN.test(rawTimestamp) || !Number.isSafeInteger(Number(rawTimestamp))) {
    throw new ZooworkWebhookError('invalid_header', `${WEBHOOK_TIMESTAMP_HEADER} must be a non-negative integer`)
  }
  const timestamp = Number(rawTimestamp)
  const signatures = parseSignatureHeader(signatureHeader)

  const tolerance = input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS
  if (!Number.isSafeInteger(tolerance) || tolerance < 0) {
    throw new TypeError('toleranceSeconds must be a non-negative integer of seconds')
  }
  const nowMs = input.now ?? Date.now()
  if (!Number.isFinite(nowMs)) {
    throw new TypeError('now must be a finite number of milliseconds')
  }
  if (Math.abs(Math.floor(nowMs / 1000) - timestamp) > tolerance) {
    throw new ZooworkWebhookError(
      'timestamp_out_of_window',
      `${WEBHOOK_TIMESTAMP_HEADER} is more than ${tolerance}s from this clock`,
    )
  }

  const payload = signedPayload(eventId, timestamp, body)
  for (const secret of secrets) {
    const key = await hmacKey(secret, 'verify')
    for (const signature of signatures) {
      if (await crypto.subtle.verify({ name: 'HMAC' }, key, bufferSource(signature), bufferSource(payload))) {
        return { eventId, timestamp }
      }
    }
  }
  throw new ZooworkWebhookError('signature_mismatch', 'no webhook signature matched the configured secrets')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Verify a delivery and hand back its envelope.
 *
 * Verification runs FIRST; the body is parsed only once it is authenticated, and it is never
 * re-serialized. The structural check is deliberately minimal — `object`, `id`, `type`,
 * `schema_version`, `created_at`, `data` — because Engine adds fields and event types within a
 * schema version, and rejecting one of those would drop a valid delivery. An unrecognized
 * `type` passes straight through; narrow it with {@link knownWebhookEvent}.
 *
 * `schema_version` IS required, although it is the one field a receiver rarely reads: Engine's
 * projector emits it unconditionally, so an envelope without it is not an envelope, and admitting
 * one would leave {@link WebhookEvent} lying about its own type. It must be a number with an
 * INTEGER VALUE — `1` and `1.0` both pass, since JSON has a single numeric type and they are the
 * same number, while `1.5` is rejected because no release could mean it. The Python SDK checks the
 * same six fields and reaches the same verdict on the same envelope.
 *
 * Throws {@link ZooworkWebhookError} with `invalid_payload` when the body is not an envelope,
 * and with the verification codes before that.
 */
export async function unwrapWebhook(input: VerifyWebhookInput): Promise<WebhookEvent> {
  await verifyWebhookSignature(input)
  const text = typeof input.rawBody === 'string' ? input.rawBody : new TextDecoder().decode(input.rawBody)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ZooworkWebhookError('invalid_payload', 'webhook body is not JSON')
  }
  if (!isRecord(parsed)) {
    throw new ZooworkWebhookError('invalid_payload', 'webhook body is not a JSON object')
  }
  const { object, id, type, schema_version: schemaVersion, created_at: createdAt, data } = parsed
  if (
    object !== 'event' ||
    typeof id !== 'string' ||
    typeof type !== 'string' ||
    // An integer VALUE, not merely a number. JSON has one numeric type, so `1` and `1.0` are the
    // same number and both pass, while `1.5` is not a version this or any release could mean.
    // `Number.isInteger` also rejects a string `"1"` and the Infinity a JSON overflow literal
    // parses to; the `typeof` is kept for the reader, not for the check.
    !(typeof schemaVersion === 'number' && Number.isInteger(schemaVersion)) ||
    typeof createdAt !== 'string' ||
    !isRecord(data)
  ) {
    throw new ZooworkWebhookError('invalid_payload', 'webhook body is not a webhook event envelope')
  }
  return parsed as unknown as WebhookEvent
}

/**
 * Sign a body the way Engine does — the sender's side of the contract.
 *
 * Exported for your own tests: a receiver can build a delivery it controls, rather than pointing
 * its handler at staging to get one. Engine signs real deliveries; nothing here needs to.
 */
export async function signWebhook(input: SignWebhookInput): Promise<WebhookSignatureHeaders> {
  if (!Number.isSafeInteger(input.timestamp) || input.timestamp < 0) {
    throw new TypeError('webhook timestamp must be a non-negative integer of unix seconds')
  }
  const secrets = resolveSecrets(input.secret)
  const payload = signedPayload(input.eventId, input.timestamp, toBytes(input.body))
  const entries: string[] = []
  for (const secret of secrets) {
    const key = await hmacKey(secret, 'sign')
    const signature = await crypto.subtle.sign({ name: 'HMAC' }, key, bufferSource(payload))
    entries.push(`${WEBHOOK_SIGNATURE_VERSION},${encodeBase64(new Uint8Array(signature))}`)
  }
  return {
    [WEBHOOK_ID_HEADER]: input.eventId,
    [WEBHOOK_TIMESTAMP_HEADER]: String(input.timestamp),
    [WEBHOOK_SIGNATURE_HEADER]: entries.join(' '),
  }
}
