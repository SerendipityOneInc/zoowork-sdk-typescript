/**
 * Webhook verification, offline. No network, no key, no deployed service.
 *
 * `src/__vectors__/webhook-vectors.json` is copied VERBATIM from the Engine repository, at
 * `packages/webhook-signing/test/vectors.json`
 * (SerendipityOneInc/zooclaw-engine, sha256 13374542b8d8a5d7a833a9bb5eac721b3374b165b8225eb90dd122f0adbc5b72),
 * which is also what Engine's own suite, the Python SDK, and the official `standardwebhooks`
 * libraries assert against. It is THE cross-language contract: editing a vector breaks every
 * receiver in every language at once, silently, because each side would still agree with itself.
 * Add vectors; never change or delete one. If a vector fails here, this SDK is wrong — not the
 * vector. Re-copy it (never hand-edit) when Engine adds one.
 *
 * It lives in its own directory rather than in `src/__fixtures__/`, which is reserved for
 * recorded HTTP responses in the recorder's `{ method, path, status, body }` wrapper and is
 * asserted as a closed set by `responses.test.ts`.
 *
 * Every vector is checked three ways so neither side can drift unnoticed:
 *
 *   1. an INDEPENDENT `crypto.subtle.sign` of the §8.1 formula, written out longhand below and
 *      sharing no code with `src/webhooks.ts`,
 *   2. the `expected.webhook-signature` recorded in the JSON,
 *   3. this SDK's own `signWebhook`, and `verifyWebhookSignature` accepting the result.
 */
import { expect, expectTypeOf, test } from 'vitest'
import {
  isKnownWebhookEventType,
  knownWebhookEvent,
  signWebhook,
  unwrapWebhook,
  verifyWebhookSignature,
  WEBHOOK_DEFAULT_MAX_BODY_BYTES,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SCHEDULE_CONFIG_EVENT_TYPES,
  WEBHOOK_SECRET_ENV,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TOLERANCE_SECONDS,
  ZooworkWebhookError,
  type WebhookEvent,
  type WebhookEventFor,
  type WebhookEventType,
  type WebhookRunFinishedData,
  type WebhookSignatureHeaders,
} from './index.js'

// ── the vectors ────────────────────────────────────────────────────────────

interface Vector {
  name: string
  secrets: string[]
  event_id: string
  timestamp: number
  /** A string the test UTF-8 encodes; the signed bytes are those bytes, unmodified. */
  body: string
  /** Present on the tolerance vector: a receiver clock in unix SECONDS and the outcome. */
  verify?: { now: number; result: 'ok' | 'timestamp_out_of_window' }[]
  expected: { 'webhook-signature': string }
}

interface VectorFile {
  signature_version: string
  secret_prefix: string
  secret_bytes: number
  default_tolerance_seconds: number
  vectors: Vector[]
}

/** Loaded as a glob, like `responses.test.ts`, so no `resolveJsonModule` is needed. */
interface GlobbedMeta {
  glob(pattern: string, opts: { eager: true; import: 'default' }): Record<string, VectorFile>
}
const LOADED = (import.meta as unknown as GlobbedMeta).glob('./__vectors__/*.json', { eager: true, import: 'default' })
const CONTRACT = LOADED['./__vectors__/webhook-vectors.json']

/**
 * The §8.1 formula, written out independently of `src/webhooks.ts`: decode `whsec_` base64,
 * HMAC-SHA256 over `UTF8(id + "." + timestamp + ".") || body`, base64 the digest.
 */
async function independentSignature(secret: string, eventId: string, timestamp: number, body: string): Promise<string> {
  const rawKey = Uint8Array.from(atob(secret.slice('whsec_'.length)), (c) => c.charCodeAt(0))
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const encoder = new TextEncoder()
  const prefix = encoder.encode(`${eventId}.${timestamp}.`)
  const bodyBytes = encoder.encode(body)
  const payload = new Uint8Array(prefix.length + bodyBytes.length)
  payload.set(prefix, 0)
  payload.set(bodyBytes, prefix.length)
  const digest = new Uint8Array(await crypto.subtle.sign({ name: 'HMAC' }, key, payload))
  return `v1,${btoa(String.fromCharCode(...digest))}`
}

function delivery(headers: WebhookSignatureHeaders): Record<string, string> {
  return { ...headers }
}

test('the cross-language vector file is present and describes the contract this SDK implements', () => {
  expect(CONTRACT, `vectors missing — have: ${Object.keys(LOADED).join(', ')}`).toBeDefined()
  expect(CONTRACT.signature_version).toBe('v1')
  expect(CONTRACT.secret_prefix).toBe('whsec_')
  expect(CONTRACT.secret_bytes).toBe(32)
  expect(CONTRACT.default_tolerance_seconds).toBe(WEBHOOK_TOLERANCE_SECONDS)
  expect(CONTRACT.vectors).toHaveLength(5)
})

test('every vector agrees three ways: independent WebCrypto, the recorded JSON, and signWebhook', async () => {
  for (const vector of CONTRACT.vectors) {
    const independent: string[] = []
    for (const secret of vector.secrets) {
      independent.push(await independentSignature(secret, vector.event_id, vector.timestamp, vector.body))
    }
    // Entry order is the secret order: newest first during a rotation window.
    expect(independent.join(' '), vector.name).toBe(vector.expected['webhook-signature'])

    const signed = await signWebhook({
      eventId: vector.event_id,
      timestamp: vector.timestamp,
      body: vector.body,
      secret: vector.secrets,
    })
    expect(signed[WEBHOOK_SIGNATURE_HEADER], vector.name).toBe(vector.expected['webhook-signature'])
    expect(signed[WEBHOOK_ID_HEADER], vector.name).toBe(vector.event_id)
    expect(signed[WEBHOOK_TIMESTAMP_HEADER], vector.name).toBe(String(vector.timestamp))
  }
})

test('every vector verifies under each of its secrets, taken one at a time', async () => {
  for (const vector of CONTRACT.vectors) {
    const headers = {
      [WEBHOOK_ID_HEADER]: vector.event_id,
      [WEBHOOK_TIMESTAMP_HEADER]: String(vector.timestamp),
      [WEBHOOK_SIGNATURE_HEADER]: vector.expected['webhook-signature'],
    }
    // A rotation window signs under every active secret, and a receiver holding only ONE of
    // them still accepts — that is the whole point of the window.
    for (const secret of vector.secrets) {
      expect(
        await verifyWebhookSignature({ headers, rawBody: vector.body, secret, now: vector.timestamp * 1000 }),
        `${vector.name} / single secret`,
      ).toEqual({ eventId: vector.event_id, timestamp: vector.timestamp })
    }
    // And holding all of them accepts once, not once per secret.
    expect(
      await verifyWebhookSignature({
        headers,
        rawBody: vector.body,
        secret: vector.secrets,
        now: vector.timestamp * 1000,
      }),
      `${vector.name} / all secrets`,
    ).toEqual({ eventId: vector.event_id, timestamp: vector.timestamp })
  }
})

test('the non-ASCII vector verifies from raw bytes exactly as it does from the string', async () => {
  const vector = CONTRACT.vectors.find((v) => v.body.includes('café'))
  expect(vector, 'the non-ASCII vector is part of the contract').toBeDefined()
  const nonAscii = vector as Vector
  const headers = {
    [WEBHOOK_ID_HEADER]: nonAscii.event_id,
    [WEBHOOK_TIMESTAMP_HEADER]: String(nonAscii.timestamp),
    [WEBHOOK_SIGNATURE_HEADER]: nonAscii.expected['webhook-signature'],
  }
  const bytes = new TextEncoder().encode(nonAscii.body)
  expect(bytes.byteLength).toBeGreaterThan(nonAscii.body.length) // multi-byte, so the two paths differ
  expect(
    await verifyWebhookSignature({
      headers,
      rawBody: bytes,
      secret: nonAscii.secrets[0],
      now: nonAscii.timestamp * 1000,
    }),
  ).toEqual({ eventId: nonAscii.event_id, timestamp: nonAscii.timestamp })
})

test('the tolerance vector pins ±300s inclusive against an injected clock', async () => {
  const vector = CONTRACT.vectors.find((v) => v.verify !== undefined)
  expect(vector, 'the tolerance vector is part of the contract').toBeDefined()
  const boundary = vector as Vector
  const headers = {
    [WEBHOOK_ID_HEADER]: boundary.event_id,
    [WEBHOOK_TIMESTAMP_HEADER]: String(boundary.timestamp),
    [WEBHOOK_SIGNATURE_HEADER]: boundary.expected['webhook-signature'],
  }
  expect(boundary.verify).toHaveLength(4) // +300, +301, -300, -301
  for (const step of boundary.verify ?? []) {
    const input = { headers, rawBody: boundary.body, secret: boundary.secrets[0], now: step.now * 1000 }
    const label = `${boundary.name} @ ${step.now}`
    if (step.result === 'ok') {
      expect(await verifyWebhookSignature(input), label).toEqual({
        eventId: boundary.event_id,
        timestamp: boundary.timestamp,
      })
    } else {
      await expect(verifyWebhookSignature(input), label).rejects.toMatchObject({ code: step.result })
    }
  }
})

// ── a synthetic delivery to attack ─────────────────────────────────────────

const SECRET = 'whsec_AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA='
const OTHER_SECRET = 'whsec_oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr8='
const EVENT_ID = 'whe_01K5QZ6W4X8B3T2V9J7R1M0P6A'
const SENT_AT = 1790035200
const NOW = SENT_AT * 1000

/** An envelope with awkward spacing, so re-serializing it would change the bytes. */
const ENVELOPE = `{"object":"event","id":"${EVENT_ID}",  "type":"run.finished","schema_version":1,\n "created_at":"2026-09-22T00:00:00Z","data":{"org_id":"org_1","owner_uid":"user_1","agent_id":"agt_1","session_id":"api:sess_1","run_id":"run_1","status":"succeeded"}}`

async function sealed(body: string = ENVELOPE, secret: string | readonly string[] = SECRET) {
  return delivery(await signWebhook({ eventId: EVENT_ID, timestamp: SENT_AT, body, secret }))
}

test('a good delivery verifies and unwraps to its envelope without being re-serialized', async () => {
  const headers = await sealed()
  expect(await verifyWebhookSignature({ headers, rawBody: ENVELOPE, secret: SECRET, now: NOW })).toEqual({
    eventId: EVENT_ID,
    timestamp: SENT_AT,
  })

  const event = await unwrapWebhook({ headers, rawBody: ENVELOPE, secret: SECRET, now: NOW })
  expect(event.object).toBe('event')
  expect(event.id).toBe(EVENT_ID)
  expect(event.type).toBe('run.finished')
  expect(event.schema_version).toBe(1)
  expect(event.created_at).toBe('2026-09-22T00:00:00Z')
  expect(event.data.status).toBe('succeeded')
  // The whitespace above survives a verify → parse pass, which a parse → re-stringify → verify
  // pass could not: the signature is over bytes.
  expect(JSON.stringify(event)).not.toBe(ENVELOPE)
})

test('a rotation window accepts a double-signed delivery from either side', async () => {
  const headers = await sealed(ENVELOPE, [OTHER_SECRET, SECRET])
  expect(headers[WEBHOOK_SIGNATURE_HEADER].split(' ')).toHaveLength(2)
  for (const secret of [SECRET, OTHER_SECRET, [SECRET], [OTHER_SECRET, SECRET]] as const) {
    expect(await verifyWebhookSignature({ headers, rawBody: ENVELOPE, secret, now: NOW })).toMatchObject({
      eventId: EVENT_ID,
    })
  }
})

test('one flipped body byte, or the wrong secret, is a signature_mismatch', async () => {
  const headers = await sealed()
  const tampered = new TextEncoder().encode(ENVELOPE)
  tampered[tampered.length - 3] ^= 0x01
  await expect(verifyWebhookSignature({ headers, rawBody: tampered, secret: SECRET, now: NOW })).rejects.toMatchObject({
    code: 'signature_mismatch',
  })
  await expect(
    verifyWebhookSignature({ headers, rawBody: ENVELOPE, secret: OTHER_SECRET, now: NOW }),
  ).rejects.toMatchObject({ code: 'signature_mismatch' })
})

test('an unknown signature version is skipped, not rejected — but alone it matches nothing', async () => {
  const headers = await sealed()
  const v1Entry = headers[WEBHOOK_SIGNATURE_HEADER]
  // A future v2 alongside v1 must not break a v1 receiver.
  expect(
    await verifyWebhookSignature({
      headers: { ...headers, [WEBHOOK_SIGNATURE_HEADER]: `v2,${'A'.repeat(11)}= ${v1Entry}` },
      rawBody: ENVELOPE,
      secret: SECRET,
      now: NOW,
    }),
  ).toMatchObject({ eventId: EVENT_ID })
  // Only non-v1 entries: nothing to compare, so it fails closed as a mismatch — never as a pass.
  await expect(
    verifyWebhookSignature({
      headers: { ...headers, [WEBHOOK_SIGNATURE_HEADER]: v1Entry.replace('v1,', 'v2,') },
      rawBody: ENVELOPE,
      secret: SECRET,
      now: NOW,
    }),
  ).rejects.toMatchObject({ code: 'signature_mismatch' })
})

test('a malformed signature header is invalid_header, not a mismatch', async () => {
  const headers = await sealed()
  const cases: [string, string][] = [
    ['no version separator', 'deadbeef'],
    ['empty version', ',AQID'],
    ['empty value', 'v1,'],
    ['v1 that is not base64', 'v1,not base64!!'],
    ['v1 that decodes to 31 bytes', `v1,${btoa('x'.repeat(31))}`],
    ['v1 that decodes to 33 bytes', `v1,${btoa('x'.repeat(33))}`],
  ]
  for (const [label, value] of cases) {
    await expect(
      verifyWebhookSignature({
        headers: { ...headers, [WEBHOOK_SIGNATURE_HEADER]: value },
        rawBody: ENVELOPE,
        secret: SECRET,
        now: NOW,
      }),
      label,
    ).rejects.toMatchObject({ code: 'invalid_header' })
  }
})

test('each of the three headers is required, and a repeated one is refused rather than picked', async () => {
  const headers = await sealed()
  for (const name of [WEBHOOK_ID_HEADER, WEBHOOK_TIMESTAMP_HEADER, WEBHOOK_SIGNATURE_HEADER]) {
    const missing = { ...headers }
    delete missing[name]
    await expect(
      verifyWebhookSignature({ headers: missing, rawBody: ENVELOPE, secret: SECRET, now: NOW }),
      `missing ${name}`,
    ).rejects.toMatchObject({ code: 'missing_header' })

    // Node hands a repeated header over as an array. Choosing one would be a guess about which
    // send this is, so it is invalid_header.
    await expect(
      verifyWebhookSignature({
        headers: { ...headers, [name]: [headers[name], headers[name]] },
        rawBody: ENVELOPE,
        secret: SECRET,
        now: NOW,
      }),
      `repeated ${name}`,
    ).rejects.toMatchObject({ code: 'invalid_header' })

    await expect(
      verifyWebhookSignature({ headers: { ...headers, [name]: '' }, rawBody: ENVELOPE, secret: SECRET, now: NOW }),
      `empty ${name}`,
    ).rejects.toMatchObject({ code: 'invalid_header' })
  }
})

test('the timestamp header must be a bare non-negative integer', async () => {
  const headers = await sealed()
  for (const value of ['17900352.5', '-1790035200', '+1790035200', '01790035200', '1790035200 ', '1e9', 'now']) {
    await expect(
      verifyWebhookSignature({
        headers: { ...headers, [WEBHOOK_TIMESTAMP_HEADER]: value },
        rawBody: ENVELOPE,
        secret: SECRET,
        now: NOW,
      }),
      value,
    ).rejects.toMatchObject({ code: 'invalid_header' })
  }
})

test('the clock window is checked against webhook-timestamp, and is overridable', async () => {
  const headers = await sealed()
  const input = { headers, rawBody: ENVELOPE, secret: SECRET }
  await expect(verifyWebhookSignature({ ...input, now: (SENT_AT + 301) * 1000 })).rejects.toMatchObject({
    code: 'timestamp_out_of_window',
  })
  // Widening the tolerance is the caller's call; the signature still has to match.
  expect(
    await verifyWebhookSignature({ ...input, now: (SENT_AT + 301) * 1000, toleranceSeconds: 301 }),
  ).toMatchObject({ eventId: EVENT_ID })
  await expect(
    verifyWebhookSignature({ ...input, now: (SENT_AT + 1) * 1000, toleranceSeconds: 0 }),
  ).rejects.toMatchObject({ code: 'timestamp_out_of_window' })
})

test('a body over the ceiling is refused before any header is even read', async () => {
  const oversize = 'x'.repeat(WEBHOOK_DEFAULT_MAX_BODY_BYTES + 1)
  await expect(
    verifyWebhookSignature({ headers: {}, rawBody: oversize, secret: SECRET, now: NOW }),
  ).rejects.toMatchObject({ code: 'body_too_large' })
  const headers = await sealed()
  await expect(
    verifyWebhookSignature({ headers, rawBody: ENVELOPE, secret: SECRET, now: NOW, maxBodyBytes: 16 }),
  ).rejects.toMatchObject({ code: 'body_too_large' })
  // Exactly at the ceiling is allowed; the signature is what then decides.
  await expect(
    verifyWebhookSignature({
      headers,
      rawBody: 'x'.repeat(WEBHOOK_DEFAULT_MAX_BODY_BYTES),
      secret: SECRET,
      now: NOW,
    }),
  ).rejects.toMatchObject({ code: 'signature_mismatch' })
})

test('a secret of the wrong shape is invalid_secret, and is caught before the body is measured', async () => {
  const headers = await sealed()
  const bad = [
    'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=', // no whsec_ prefix
    'whsec_', // nothing to decode
    `whsec_${btoa('x'.repeat(31))}`, // 31 bytes
    `whsec_${btoa('x'.repeat(33))}`, // 33 bytes
    'whsec_not base64!!',
  ]
  for (const secret of bad) {
    await expect(
      verifyWebhookSignature({ headers, rawBody: ENVELOPE, secret, now: NOW }),
      secret.slice(0, 12),
    ).rejects.toMatchObject({ code: 'invalid_secret' })
  }
  await expect(verifyWebhookSignature({ headers, rawBody: ENVELOPE, secret: [], now: NOW })).rejects.toMatchObject({
    code: 'invalid_secret',
  })
  // Cheapest check first: a bad secret wins over an oversize body.
  await expect(
    verifyWebhookSignature({
      headers,
      rawBody: 'x'.repeat(WEBHOOK_DEFAULT_MAX_BODY_BYTES + 1),
      secret: 'nope',
      now: NOW,
    }),
  ).rejects.toMatchObject({ code: 'invalid_secret' })
})

test('no secret and no environment variable is a named error, not a silent pass', async () => {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  expect(env, 'this test needs a runtime with process.env').toBeDefined()
  const saved = env?.[WEBHOOK_SECRET_ENV]
  const headers = await sealed()
  try {
    delete env?.[WEBHOOK_SECRET_ENV]
    const failure = await verifyWebhookSignature({ headers, rawBody: ENVELOPE, now: NOW }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(ZooworkWebhookError)
    expect((failure as ZooworkWebhookError).code).toBe('invalid_secret')
    expect((failure as ZooworkWebhookError).message).toContain(WEBHOOK_SECRET_ENV)

    if (env) env[WEBHOOK_SECRET_ENV] = SECRET
    expect(await verifyWebhookSignature({ headers, rawBody: ENVELOPE, now: NOW })).toMatchObject({ eventId: EVENT_ID })
  } finally {
    if (env) {
      if (saved === undefined) delete env[WEBHOOK_SECRET_ENV]
      else env[WEBHOOK_SECRET_ENV] = saved
    }
  }
})

test('no error message leaks the secret, the signature or the body', async () => {
  const headers = await sealed()
  const failure = await verifyWebhookSignature({ headers, rawBody: ENVELOPE, secret: OTHER_SECRET, now: NOW }).then(
    () => undefined,
    (error: unknown) => error as ZooworkWebhookError,
  )
  expect(failure).toBeInstanceOf(ZooworkWebhookError)
  const message = (failure as ZooworkWebhookError).message
  expect(message).not.toContain(OTHER_SECRET)
  expect(message).not.toContain(headers[WEBHOOK_SIGNATURE_HEADER])
  expect(message).not.toContain('org_1')
})

test('header sources: fetch Headers, a mixed-case record, and Node IncomingHttpHeaders', async () => {
  const signed = await signWebhook({ eventId: EVENT_ID, timestamp: SENT_AT, body: ENVELOPE, secret: SECRET })
  const expected = { eventId: EVENT_ID, timestamp: SENT_AT }

  const fetchHeaders = new Headers(signed)
  expect(await verifyWebhookSignature({ headers: fetchHeaders, rawBody: ENVELOPE, secret: SECRET, now: NOW })).toEqual(
    expected,
  )

  // A record in whatever casing an upstream proxy chose.
  const mixedCase = {
    'Webhook-Id': signed[WEBHOOK_ID_HEADER],
    'WEBHOOK-TIMESTAMP': signed[WEBHOOK_TIMESTAMP_HEADER],
    'webhook-Signature': signed[WEBHOOK_SIGNATURE_HEADER],
  }
  expect(await verifyWebhookSignature({ headers: mixedCase, rawBody: ENVELOPE, secret: SECRET, now: NOW })).toEqual(
    expected,
  )

  // Node's `IncomingMessage.headers`: lower-cased keys, and `string[]` for a repeated header
  // (which `set-cookie` always is) sitting alongside the ones we read.
  const incoming: Record<string, string | string[] | undefined> = {
    ...signed,
    'content-type': 'application/json',
    'set-cookie': ['a=1', 'b=2'],
    'x-absent': undefined,
  }
  expect(await verifyWebhookSignature({ headers: incoming, rawBody: ENVELOPE, secret: SECRET, now: NOW })).toEqual(
    expected,
  )
})

// ── unwrap ─────────────────────────────────────────────────────────────────

test('a verified body that is not an envelope is invalid_payload', async () => {
  const bodies: [string, string][] = [
    ['not JSON at all', 'not json'],
    ['truncated JSON', '{"object":"event"'],
    ['a JSON array', '[{"object":"event"}]'],
    ['a JSON scalar', '"event"'],
    ['null', 'null'],
    ['wrong object tag', '{"object":"webhook","id":"a","type":"run.started","schema_version":1,"created_at":"t","data":{}}'],
    ['non-string id', '{"object":"event","id":1,"type":"run.started","schema_version":1,"created_at":"t","data":{}}'],
    ['missing type', '{"object":"event","id":"a","schema_version":1,"created_at":"t","data":{}}'],
    ['non-number schema_version', '{"object":"event","id":"a","type":"run.started","schema_version":"1","created_at":"t","data":{}}'],
    ['missing created_at', '{"object":"event","id":"a","type":"run.started","schema_version":1,"data":{}}'],
    ['data is an array', '{"object":"event","id":"a","type":"run.started","schema_version":1,"created_at":"t","data":[]}'],
  ]
  for (const [label, body] of bodies) {
    const headers = await sealed(body)
    await expect(
      unwrapWebhook({ headers, rawBody: body, secret: SECRET, now: NOW }),
      label,
    ).rejects.toMatchObject({ code: 'invalid_payload' })
  }
})

test('unwrap verifies BEFORE it parses: a bad signature over garbage is a signature failure', async () => {
  const headers = await sealed('not json')
  await expect(
    unwrapWebhook({ headers, rawBody: 'also not json', secret: SECRET, now: NOW }),
  ).rejects.toMatchObject({ code: 'signature_mismatch' })
})

// ── the event vocabulary ───────────────────────────────────────────────────

test('the event vocabulary is the one Engine publishes, and the two lists are disjoint', () => {
  expect(WEBHOOK_EVENT_TYPES).toEqual([
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
  ])
  // Declared for receivers to handle, but not emitted until Engine E5a ships the server side.
  expect(WEBHOOK_SCHEDULE_CONFIG_EVENT_TYPES).toEqual([
    'schedule.created',
    'schedule.updated',
    'schedule.paused',
    'schedule.resumed',
    'schedule.deleted',
  ])
  const overlap = WEBHOOK_EVENT_TYPES.filter((type) => (WEBHOOK_SCHEDULE_CONFIG_EVENT_TYPES as readonly string[]).includes(type))
  expect(overlap).toEqual([])
  for (const type of [...WEBHOOK_EVENT_TYPES, ...WEBHOOK_SCHEDULE_CONFIG_EVENT_TYPES]) {
    expect(isKnownWebhookEventType(type)).toBe(true)
  }
})

test('an event type this release has never heard of passes through instead of throwing', async () => {
  const body = '{"object":"event","id":"whe_future","type":"billing.invoiced","schema_version":1,"created_at":"2026-09-22T00:00:00Z","data":{"org_id":"org_1","owner_uid":"user_1","invoice_id":"in_1"}}'
  const headers = await sealed(body)
  const event = await unwrapWebhook({ headers, rawBody: body, secret: SECRET, now: NOW })
  // The raw type and data survive; only the discriminator declines to name it.
  expect(event.type).toBe('billing.invoiced')
  expect(event.data.invoice_id).toBe('in_1')
  expect(isKnownWebhookEventType(event.type)).toBe(false)
  expect(knownWebhookEvent(event)).toBeUndefined()
})

test('knownWebhookEvent narrows a known type to its data shape', async () => {
  const headers = await sealed()
  const event = await unwrapWebhook({ headers, rawBody: ENVELOPE, secret: SECRET, now: NOW })
  const known = knownWebhookEvent(event)
  expect(known).toBe(event) // re-typed, not copied
  if (known?.type !== 'run.finished') throw new Error(`expected run.finished, got ${String(known?.type)}`)
  expect(known.data.run_id).toBe('run_1')
  // Assignability is the assertion: the narrowed `data` IS the run.finished shape.
  const data: WebhookRunFinishedData = known.data
  expect(data.status).toBe('succeeded')
  expect(data.org_id).toBe('org_1')
})

// ── type level ─────────────────────────────────────────────────────────────

test('the envelope and its per-type narrowing are pinned at the type level', () => {
  expectTypeOf<WebhookEvent['object']>().toEqualTypeOf<'event'>()
  expectTypeOf<WebhookEvent['schema_version']>().toEqualTypeOf<number>()
  expectTypeOf<WebhookEventFor<'webhook.test'>['type']>().toEqualTypeOf<'webhook.test'>()
  expectTypeOf<WebhookEventFor<'outcome.evaluated'>['data']['iteration']>().toEqualTypeOf<number>()
  expectTypeOf<WebhookEventFor<'outcome.evaluated'>['data']['verdict']>().toEqualTypeOf<
    'satisfied' | 'failed' | 'needs_revision' | 'evaluator_error'
  >()
  expectTypeOf<WebhookEventFor<'session.archived'>['data']['archived_at']>().toEqualTypeOf<string | undefined>()
  expectTypeOf<WebhookEventFor<'schedule.dispatched'>['data']['fired_at']>().toEqualTypeOf<string>()

  // A field a later Engine release adds reads back as `unknown`, so it compiles.
  expectTypeOf<WebhookEventFor<'run.finished'>['data']['field_added_next_quarter']>().toEqualTypeOf<unknown>()

  // An unknown type is a string, not a compile error — a receiver can hold one.
  const future: WebhookEvent = {
    object: 'event',
    id: 'whe_future',
    type: 'billing.invoiced',
    schema_version: 1,
    created_at: '2026-09-22T00:00:00Z',
    data: {},
  }
  expect(future.type).toBe('billing.invoiced')
  expectTypeOf<WebhookEventType>().toExtend<WebhookEvent['type']>()

  // @ts-expect-error a narrowed envelope pins its own discriminant.
  const mismatchedType: WebhookEventFor<'webhook.test'> = { ...future, type: 'run.started', data: { org_id: 'o', owner_uid: 'u', endpoint_id: 'wep_1' } }
  // @ts-expect-error webhook.test data always names the endpoint it was sent to.
  const missingField: WebhookEventFor<'webhook.test'> = { ...future, type: 'webhook.test', data: { org_id: 'o', owner_uid: 'u' } }
  // @ts-expect-error a type outside the vocabulary cannot be narrowed to.
  const notAType: WebhookEventFor<'billing.invoiced'> = future
  void mismatchedType
  void missingField
  void notAType
})
