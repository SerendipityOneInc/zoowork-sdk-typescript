# @zoowork-ai/sdk

TypeScript SDK for the [ZooWork Managed Agents](https://zoowork.ai/docs/) API. Developer Preview.

Zero runtime dependencies — it uses the platform `fetch`, which you can override for edge runtimes and tests. ESM only, Node 20+.

```bash
npm install @zoowork-ai/sdk
```

## Quickstart

Create a Project API key in [ZooWork Platform](https://platform.zoowork.ai). The secret is shown once. Save it as `ZOOWORK_API_KEY` on your server. Agent and Session access is scoped to the key's Project. Initialize Organization billing and bind owner credentials; sign in and rebind when the API requests it.

```ts
import { createZooworkClient } from '@zoowork-ai/sdk'

const zc = createZooworkClient({ apiKey: process.env.ZOOWORK_API_KEY })

// Or set ZOOWORK_API_KEY and pass nothing at all:
// const zc = createZooworkClient()
```

The base URL has a working default, so you do not configure an endpoint. Override it with
`ZOOWORK_BASE_URL`, or with `baseUrl` on the call, to point at a different deployment.

```ts
// 1. Create an agent. Ownership is derived from your key, so `resource` is all you
//    send. Select a model returned by this deployment instead of relying on a
//    remembered id or on a server default that can rotate.
const models = await zc.listModels()
const primary = models.find(
  (model) => model.selectable !== false && model.model === 'litellm/gpt-5.6-terra',
)?.model
if (!primary) throw new Error('Choose a selectable model returned by listModels()')

const agent = await zc.createAgent({
  resource: { name: 'research-agent', model: { primary } },
})

// 2. Start it. Without this, createSession() returns 409 agent_not_running.
await zc.startAgent(agent.agent_id)

// 3. Open a session with the first message already in it.
const session = await zc.createSession(agent.agent_id, {
  initial_events: [{ type: 'user.message', content: 'What can you do?' }],
})
```

`listModels()` can include a model whose retirement has started. Check `selectable !== false`
before using a catalog row in a new Agent or config. A non-selectable choice returns
`409 model_not_selectable`; `expired_fallback_to` names the reviewed replacement when present.

Agent resources also accept `userTimezone`, a named IANA timezone used for prompt and message
time context, and `include_global_skills: false` to disable automatic global Skills while keeping
explicitly listed Skills. An explicit `skills: []` also opts out. Schedule timezones are configured
separately.

## Configuration

| Option | Environment variable | Default |
|---|---|---|
| `apiKey` | `ZOOWORK_API_KEY` | none - construction throws without one |
| `baseUrl` | `ZOOWORK_BASE_URL` | the public gateway (`DEFAULT_BASE_URL`) |
| `fetch` | - | `globalThis.fetch` |

An explicit option always beats the environment variable.

> **Wait on `status.desired_state`, never on `status.actual_state`.**
> `actual_state` reports chat-channel connectivity. An API-only agent has no channels,
> but its projection depends on the channel-status capability: a GET can report `active`
> with zero channel counts and a `status_message` saying health was not verified when that
> capability is unsupported, while a transient health lookup failure remains `activating`.
> List and GET can therefore briefly disagree. None of these values is readiness, and
> `running` is not an `actual_state` value. Use `await zc.waitUntilRunning(agentId)`; it
> correctly polls `desired_state`.

## Listing agents and pagination

`listAgents()` returns an awaitable, async-iterable request. Use `for await` to traverse all
matching agents; the SDK requests each next page only as you consume the results:

```ts
for await (const agent of zc.listAgents({ labels: { project: 'research' } })) {
  console.log(agent.agent_id)
  // break when you have enough; later pages will not be fetched.
}
```

For a single page, `await` the request and read `.data`. The page preserves `page`,
`page_size`, and `total`, and exposes `next_page` (`null` when there are no more results):

```ts
const page = await zc.listAgents()
console.log(page.data, page.total, page.next_page)

if (page.hasNextPage()) {
  const next = await page.getNextPage() // retains the original label filters
  console.log(next.data)
}
```

You can also use `for await (const agent of page)` to iterate from an already-fetched page,
or `for await (const batch of page.iterPages())` to process one page at a time.
`getNextPage()` rejects if there is no next page; errors fetching later pages reject iteration.

The API uses **numeric pages starting at 1**, with a fixed page size of 100. The SDK derives
`next_page` from the returned `page`, `page_size`, and `total`; it is a number, not an opaque
cursor. To resume explicitly, use `zc.listAgents({ page: nextPage, labels: originalLabels })`.
There is no configurable `limit`. Pagination is not a snapshot: concurrent additions or
deletions can shift results between pages.

**Migration from the array return:** replace `const agents = await zc.listAgents(opts)` with
`const { data: agents } = await zc.listAgents(opts)` to keep reading one page, or switch to
`for await` to read every match. Missing or invalid pagination metadata now raises an error
instead of silently returning an empty or apparently complete array.

## Streaming a turn

`run.finished` ends a turn; assistant text arrives on `agent.assistant`.

```ts
import { assistantText, customToolUse, isRunFinished, runOutcome, toolCall } from '@zoowork-ai/sdk'

for await (const ev of zc.streamEvents(agent.agent_id, session.session_id)) {
  process.stdout.write(assistantText(ev)) // '' for every non-assistant event

  const call = toolCall(ev) // present only on agent.tool; pair start/end by toolCallId
  if (call?.phase === 'start') console.log(`\n[tool] ${call.toolName}`)

  if (isRunFinished(ev)) {
    console.log(`\n-> ${runOutcome(ev)}`) // succeeded | failed | aborted
    break
  }
}
```

Three things worth knowing before you write that loop:

- **The stream is session-scoped and does not close when a turn ends.** The server closes it after an idle period. Break on `isRunFinished(ev)` yourself, or you block until that timeout.
- **Save the opaque cursor.** After consuming an event, retain `ev.cursor` and resume with `{ cursor }`. Do not derive it from `seq` or mix it with `after`: `after` selects the deprecated event lane, which omits user-input events. The SDK sends the cursor in the query; do not rely on a raw `Last-Event-ID` header passing through the public gateway.
- **The default unified REST and SSE wire formats use snake_case.** Older event formats differ; the SDK normalizes both into `SessionEvent`, where you read `eventType`. Keep the cursor unchanged.

For API sessions, `user.message` can carry `actor: { ref: 'customer-42' }`, including in
`initial_events`. This source-reviewed field selects per-user memory attribution. Your server
must authenticate the user and authorize the session; `actor.ref` does neither. It does not
isolate the shared agent's sandbox files or erase a session's previous context. Omit `actor`
to use the owner; IM sessions reject it. See the field's SDK comment for input constraints.

## Agent Skills

New Agents receive global Skills by default. Use `listAgentSkills(agentId)` to inspect attached Skills. At create time, `resource.skills` accepts a catalog name or `skill_id`; `include_global_skills: false` or an explicit empty list opts out of automatic Skills. Root Skill uploads are unavailable to Project keys. Keep source changes in your application; use persona documents for standing instructions and Session messages for text task data.

## Schedules, wake and exec

```ts
await zc.createSchedule(agent.agent_id, {
  schedule_id: 'daily-report',
  schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Singapore' },
  payload: { kind: 'agentTurn', message: 'Generate the daily report.' },
})

await zc.wake(agent.agent_id, { text: 'Review the pending deployment.' }) // at the next heartbeat

const { exit_code, stdout } = await zc.exec(agent.agent_id, ['bash', '-lc', 'pwd'])
```

- **Schedules outlive their agent.** `stopAgent` and `deleteAgent` leave them running; list and
  delete them yourself. Also available: `getSchedule`, `updateSchedule`, `triggerSchedule`,
  `listScheduleRuns`.
- **`updateSchedule` must omit `sessionTarget`.** It is immutable, and echoing it back from a
  `getSchedule` result — the obvious thing to do — is a 400. The types refuse it for you.
- **An interval uses `{ kind: 'every', everyMs: 60_000 }`.** Optional `anchorMs` aligns it.
  The earlier `every` type was incorrect; migrate explicitly, without guessing string units.
  This correction and optional `ScheduleRun.session_id` are source-reviewed. Use that session
  link only when present; it is not a run-success indicator.
- **`exec` resolves on a failed command.** A non-zero exit is still HTTP 200: check `exit_code`,
  don't wait for a rejection. It runs in `/workspace` and needs an agent-scope sandbox.
- **A cron job can carry an outcome gate.** `payload.outcome` says what "done" looks like — a
  sandbox `command` whose exit 0 means satisfied, or an LLM `rubric` graded in a fresh context.
  The run evaluates and revises itself up to `maxIterations` (1–5), and under the default
  `publish: 'after_satisfied'` a result that failed evaluation is not announced. An agent-level
  default lives at `resource.outcome`; a job's own `outcome` overrides it, and an explicit
  `null` opts the job out. Cron fires only — heartbeats and interactive sessions never evaluate.

## Sessions, approvals, environments

`listSessions` keeps the legacy numeric-page contract. Use `listSessionPage` for the filtered
cursor lane: it starts with `sls1:0`, accepts channel/surface/runtime/archive filters, and returns
`next_cursor` plus a `list_cursor` on each row. Cursors are opaque and bound to the same filters.
Pass `{ includeDeleted: true }` to include deletion tombstones for reconciliation; returned rows
then carry `deleted` and the page carries `includes_deleted: true`. This flag is part of the cursor
scope, so do not reuse a cursor created without it.
`archiveSession` and `deleteSession` round out the session surface. There is no
`patchSession`: the gateway does not proxy `PATCH` at all (405), so session `metadata` is fixed at
creation time.

An application-executed tool is declared in `resource.custom_tools`. When
`customToolUse(ev)?.phase === 'requested'`, execute the named operation and call
`resolveCustomToolCall`; `listCustomToolCalls` recovers pending work after a restart. You may also
post a typed `user.custom_tool_result` event to the owning session. The run reports
`awaiting_approval` while paused, so use `pending_custom_tool_calls` to distinguish this wait from
a normal approval. These contracts are source-reviewed and need deployment verification.

```ts
const call = customToolUse(ev)
if (call?.phase === 'requested') {
  await zc.resolveCustomToolCall(agentId, call.callId, {
    content: [{ type: 'json', value: { price: 42 } }],
    resolvedBy: 'pricing-service',
  })
}
```

`listApprovals` / `resolveApproval` expose the approvals resource — `decision` is one of
`allow-once`, `allow-always`, `deny`. End-to-end approval and turn-budget behavior need
separate verification on the deployment you use.

Approval response fields are source-reviewed, not end-to-end verified: read `requested_at`,
`allowed_decisions` and optional timeout/resolution fields defensively. `signaled: true` means
the resolution was accepted; a returned `status: 'pending'` is not completed execution.

Platform uses its managed Environment. Root Environment administration and Channel binding return `404 service_api.not_found` for Project keys. An exported method does not expand a key's permissions.

## Artifacts and the system prompt

```ts
const { artifacts, has_more } = await zc.listArtifacts(agent.agent_id)
const { url } = await zc.downloadArtifact(agent.agent_id, artifacts[0].artifact_id)

const { declaration, effective } = await zc.getSystemPrompt(agent.agent_id)
```

Artifacts are published by the agent's own `artifact_publish` tool during a turn — there is no
API for publishing from outside the loop. This surface lists what the agent published,
re-resolves an access URL (`downloadArtifact` mints a fresh one; the URL is a revocable bearer
capability, so treat it like a secret), and deletes. These routes demand `owner_uid`/`org_id`
selectors; the SDK derives both from the agent's own projection and caches them, at the cost of
one extra GET on first use.

`getSystemPrompt` answers the pinned template version and the rendered result;
`previewSystemPrompt` assembles the exact prompt for a given set of runtime facts without
touching any session. The pin is set at create time and never follows a later platform
activation on its own — moving it is one explicit call, `upgradeSystemPrompt`, which takes
the agent's current `config_version` as a CAS (`409 config_version_changed` on a stale one)
and answers the new pin plus the version bump it cost.

## Receiving webhooks

Verification needs the **raw request bytes**. `express.json()` and most framework body parsers
consume them, and a `JSON.parse` → `JSON.stringify` round trip does not reproduce them byte for
byte, so read the body before anything else touches it. The example requires your
application to supply `acceptOnce`, an atomic durable insert plus work-item enqueue, before it
returns 204. A worker processes that item separately:

```ts
import { createServer } from 'node:http'
import { knownWebhookEvent, unwrapWebhook, ZooworkWebhookError } from '@zoowork-ai/sdk'

createServer(async (req, res) => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const rawBody = Buffer.concat(chunks)

  let event
  try {
    // Defaults to ZOOWORK_WEBHOOK_SECRET, or pass `secret: [newest, previous]` explicitly.
    event = await unwrapWebhook({ headers: req.headers, rawBody })
  } catch (error) {
    if (error instanceof ZooworkWebhookError) {
      console.warn('rejected webhook', error.code) // never carries the secret, signature or body
      res.writeHead(400).end()
      return
    }
    throw error
  }

  // Validate identity, then atomically persist the event and a durable work item.
  // Implement acceptOnce with a unique webhook-id; a duplicate is successful too.
  if (event.id !== req.headers['webhook-id']) { res.writeHead(400).end(); return }
  try { await acceptOnce(event.id, event) } catch { res.writeHead(503).end(); return }
  res.writeHead(204).end()

  // Dispatch this switch in the durable worker.
  const known = knownWebhookEvent(event)
  if (!known) return // keep unknown events accepted without side effects
  switch (known.type) {
    case 'run.finished':
      console.log(known.data.run_id, known.data.status)
      break
    case 'approval.requested':
      console.log(known.data.approval_id, known.data.tool_name)
      break
  }
}).listen(3000)
```

`verifyWebhookSignature` is the same check without the parse, for a handler that wants the bytes.
Both are `async`: the HMAC is WebCrypto (`crypto.subtle`), which is how this SDK verifies
signatures with no runtime dependency and still runs in Workers, Deno and the browser.

### Rotating the secret without a deploy

`ZOOWORK_WEBHOOK_SECRET` accepts **several secrets**, separated by whitespace or commas. During a
rotation window the sender signs under every active key, so a receiver that lists both accepts
whichever one signed a given delivery:

```sh
ZOOWORK_WEBHOOK_SECRET="whsec_<new> whsec_<previous>"   # commas work too
```

Splitting is unambiguous because a secret is `whsec_` plus standard base64 of 32 bytes — no comma,
no whitespace. The Python SDK reads the variable the same way, so one deployment's configuration
serves both. A `secret` you pass explicitly is never split: a string is one secret, and several go
in an array.

Four more things worth knowing:

- **The clock window is checked against the `webhook-timestamp` header, not the envelope's
  `created_at`.** A retry of an old event carries a fresh timestamp and verifies; `created_at`
  still says when the fact happened. The default tolerance is ±300s.
- **A body over 16 KiB is refused before it is hashed** — the sender's own envelope ceiling.
- **Unknown event types are normal.** New types ship within a schema version, and a receiver that
  fails one only makes the sender retry it and then dead-letter it. Acknowledge and ignore.
- **A repeated `webhook-id`, `webhook-timestamp` or `webhook-signature` header is rejected**, not
  resolved to one of its values: choosing would be a guess about which send arrived. The Python
  SDK rejects it too.
- **`unwrapWebhook` checks six fields and no more** — `object`, `id`, `type`, `schema_version`,
  `created_at`, `data` — so a field or event type a later API release adds is not a reason to
  drop a delivery. `schema_version` must be a number with an **integer value**: `1` and `1.0` both
  pass, since JSON has one numeric type and they are the same number, while `1.5` is rejected with
  `invalid_payload`. The Python SDK reaches the same verdict on the same envelope.

`ZooworkWebhookError.code` is the contract to match on — `invalid_secret`, `body_too_large`,
`missing_header`, `invalid_header`, `timestamp_out_of_window`, `signature_mismatch`,
`invalid_payload` — and those strings are identical in the Python SDK. The class shape is not: here
it extends `Error`, while the Python SDK makes it a subclass of its own `ZooworkError` carrying a
400. Match on `code`, and do not port `instanceof` checks between the two.

You do not have to use this SDK to verify. ZooWork emits plain
[Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks), so the official
library for any language works with the same `whsec_` secret and the same raw body — npm
[`standardwebhooks`](https://www.npmjs.com/package/standardwebhooks), PyPI
[`standardwebhooks`](https://pypi.org/project/standardwebhooks/), or another of the ports. The
fixed vectors in [`src/__vectors__/webhook-vectors.json`](src/__vectors__/webhook-vectors.json)
are copied verbatim from Engine and are byte-compatible with all of them.

## Two helpers

```ts
const agent = await zc.waitUntilRunning(agentId)          // polls desired_state, not actual_state
const events = await zc.listAllEvents(agentId, sessionId) // pages past the silent 500 cap
```

Each wraps a trap that is invisible from the outside: readiness lives in `status.desired_state`,
and `listEvents` truncates at 500 events with nothing in the response to say it did.

## Documentation

Full guides and the capability matrix: **[zoowork-agents-docs](https://zoowork.ai/docs/)**.

Runnable examples in [`examples/`](examples):

- [`live-smoke.ts`](examples/live-smoke.ts) — drive one agent through one turn and verify the REST and SSE reads agree.
- [`capability-probe.ts`](examples/capability-probe.ts) — create a throwaway agent, walk the whole lifecycle, and print a verdict per capability.

## Testing and publishing (maintainers)

Testing and publishing are independent commands. After cloning this repository on a new
machine, install its locked development dependencies:

```sh
pnpm install --frozen-lockfile
```

Run staging E2E explicitly when you want to verify the SDK (Node 22.20+):

```sh
pnpm test:e2e
```

The command prepares an isolated test package, prints individual offline cases and timed live
steps, and asks for a staging API key with input hidden. Submitting the key authorizes one
temporary Agent/Session, one potentially billable model turn and cleanup. JSON reports remain
in its printed private directory. The test never publishes. Normal `pnpm test` is offline
and needs no key. See [E2E and recovery instructions](e2e/README.md) for scope and options.

Publishing runs through [`.github/workflows/release.yml`](.github/workflows/release.yml). Configure
the npm package's Trusted Publisher once with organization `SerendipityOneInc`, repository
`zoowork-sdk-typescript`, workflow `release.yml`, and direct publish permission. No npm token or
repeated `npm login` is needed after that.

For each release, merge the intended version and changelog, then publish a GitHub Release whose
tag is exactly `v<package version>` — for example, `v0.7.0`. The workflow verifies that match,
runs the offline test and build gates, and publishes the public package with npm OIDC. A mismatched
tag fails before publication, and an existing npm version cannot be overwritten.

The release workflow does not run live E2E or read a staging key. Run `pnpm test:e2e` separately
before creating the GitHub Release when live verification is required. Use
`npm publish --dry-run` locally to inspect the package without uploading it.

## License

MIT

## Developer API helpers

These helpers require an SDK release that includes them. Check the installed declarations before using an example; use the documented HTTP endpoint if the installed release lacks the method.

```ts
const usage = await zc.getUsage({ range: '7d', view: 'both' })
const endpoint = await zc.createAgentWebhook(agentId, {
  url: 'https://receiver.example/webhook', event_types: ['run.finished'],
}, 'register-hook-v1')
// Save signing_secret securely when present; an idempotent replay can return null.
const hooks = await zc.listAgentWebhooks(agentId) // hooks.webhooks
const output = await zc.getRunOutput(agentId, sessionId, runId)
const approvals = await zc.listApprovalPage(agentId, { sessionId })
```

Direct workspace Files and the database viewer are not supported production workflows.
Supply text in Session messages, ask the Agent to create and publish Artifacts, and download
those through the Artifact API. The Agent can use `agent_db` and return query results in its
reply. Method presence is not production availability. Usage stays within the current key scope. Page helpers retain `next_cursor` and `has_more`; replay cursors
verbatim. `getApproval` and `getCustomToolCall` read terminal as well as pending actions.

Agent webhook methods include get/update/delete, `rotateAgentWebhookSecret`, `testAgentWebhook`,
`getAgentWebhookEvent`, delivery list/detail and single/batch redelivery. Pass a stable idempotency
key to create, rotation, test and redelivery. A 202 receipt confirms queuing; query delivery
records to learn the result. SDK writes do not retry automatically.

`createSession` accepts `runtime_mode: 'active'` to pin the current active configuration at
creation. Omit it to resolve active configuration on later turns. `idle_compaction` preserves
false, null and omission. MCP tool overrides accept `requireConfirmation?: boolean`.
Production `updateAgent` currently rejects `expected_config_version` with
`400 invalid_declared_key`. Omit it for ordinary last-write-wins updates; serialize competing
writes in your application. A GET followed by PUT is not atomic. Ownership-only changes do not
increment the configuration version. The separate `upgradeSystemPrompt` precondition remains supported.

## Current production behavior

- Manual Schedule execution requires `enabled: true`, which also enables automatic firings.
  A disabled Schedule can return `triggered: true` and still be skipped. The receipt is not a
  run result; run rows can lack status/session linkage.
- Approval waiting is `agent.approval` / `requested`; `resolved` ends the approval wait.
  `agent.tool` / `blocked` ends a call without execution, with no later `end`. Reasons include
  policy denial, approval denial/timeout/cancellation, or interruption; inspect the event
  payload's `deniedReason`.
- Save each processed stream cursor with its Session ID. Pass it when reading a subsequent
  turn in that Session. No cursor means replay from the beginning, including old `run.finished`.
  REST events and post-event receipts do not supply a cursor; the last REST page has a null
  continuation token. There is no current-tail helper. Without a saved cursor, replay and
  reconstruct state or deliberately start a new conversation; do not synthesize a cursor from seq.
- First Agent deletion succeeds with 204; repeated deletion returns 404 through the public API.
  For cleanup retries, interpret 404 as absence only for a known Agent with unchanged key scope.
  Other-tenant or inaccessible resources also return 404.
- Invalid Usage parameters can return either `400 usage.invalid_query` or 422 with no business
  error type. Correct the parameters rather than retrying unchanged. Match status as well as type.

See the [public guides](https://zoowork.ai/docs/) for supported workflows. These notes do not
change SDK transport behavior or make unavailable endpoints usable.
