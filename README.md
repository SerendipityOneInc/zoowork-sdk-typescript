# @zoowork-ai/sdk

TypeScript SDK for the [ZooWork Managed Agents](https://github.com/SerendipityOneInc/zoowork-agents-docs) API. Developer Preview.

Zero runtime dependencies — it uses the platform `fetch`, which you can override for edge runtimes and tests. ESM only, Node 20+.

```bash
npm install @zoowork-ai/sdk
```

## Quickstart

You need an API key (`zct_...`) issued for your organization — create one in the ZooWork App under **Settings → API Keys** (any personal org; enterprise orgs need the admin role), or ask your org admin for one. The secret is shown exactly once at creation. Keep it server-side: it authenticates as your whole organization, not as one end user.

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
const primary = models.find((model) => model.model === 'litellm/gpt-5.6-terra')?.model
if (!primary) throw new Error('Choose a model returned by listModels()')

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

## Configuration

| Option | Environment variable | Default |
|---|---|---|
| `apiKey` | `ZOOWORK_API_KEY` | none - construction throws without one |
| `baseUrl` | `ZOOWORK_BASE_URL` | the public gateway (`DEFAULT_BASE_URL`) |
| `fetch` | - | `globalThis.fetch` |

An explicit option always beats the environment variable.

> **Finding the agent you built in the app.** The first path segment of a ZooWork chat URL
> (`/chat/<32-hex>/sessions/…`) is a *workspace* id, not an `agt_…`. Resolve it with
> `zc.listAgents({ labels: { workspace_id: '<32-hex>' } })`; use the pagination patterns
> below to read one page or traverse every match. Scope is `owner_uid AND org_id` — an agent a *colleague*
> created in your org is fetchable by id but will not appear in your list.

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
import { assistantText, isRunFinished, runOutcome, toolCall } from '@zoowork-ai/sdk'

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

## Bring your own skill

A skill is a zip. One upload creates the skill *and* its first version; `putAgentSkill` attaches it.

```ts
import { readFile } from 'node:fs/promises'

const skill = await zc.uploadSkill(await readFile('market-research.zip'), { scope: 'org' })
await zc.putAgentSkill(agent.agent_id, skill.skill_id)
```

The zip's single top-level directory must be named exactly like the `name` in its `SKILL.md`
frontmatter — `market-research/SKILL.md` declaring `name: market-research`. A mismatch is a 400,
and it is the first one nearly everyone gets. `scope` is `org` or `personal`; the preinstalled
`global` skills are listable but not installable with an API key, so this is the only way to
control what a skill says. `uploadSkillVersion` publishes an update, and agents that installed it
unpinned follow along without another `putAgentSkill`.

`uploadSkillVersion` returns a `SkillVersionRecord` with `version` and `state`, not the
`latest_version` and `status` of the `SkillRecord` returned by `uploadSkill`. This return
contract is source-reviewed, not a new live recording. On initial create, put the description
in the zip's frontmatter: the gateway drops the `description` option. Version uploads can
use that override. A successful create retried under the same name can return `409 skill_exists`;
read back first. Version uploads deduplicate identical content for the same skill, not HTTP keys.

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

`listSessions`, `archiveSession` and `deleteSession` round out the session surface. There is no
`patchSession`: the gateway does not proxy `PATCH` at all (405), so session `metadata` is fixed at
creation time.

`listApprovals` / `resolveApproval` expose the approvals resource — `decision` is one of
`allow-once`, `allow-always`, `deny`. End-to-end approval and turn-budget behavior need
separate verification on the deployment you use.

Approval response fields are source-reviewed, not end-to-end verified: read `requested_at`,
`allowed_decisions` and optional timeout/resolution fields defensively. `signaled: true` means
the resolution was accepted; a returned `status: 'pending'` is not completed execution.

`listEnvironments`, `getEnvironment`, `createEnvironment`, `createEnvironmentVersion`,
`getEnvironmentVersion` and `archiveEnvironment` manage prebuilt sandbox images (apt/npm/pip
packages, files, a build script, and an outbound allowlist). Two facts worth having before you
start: an agent's Environment **freezes on its first sandbox creation** — after that every change
is `409 environment_locked`, and stopping the agent does not clear it — and sandbox networking
defaults to unrestricted unless the Environment declares `networking: { type: 'limited' }`.

Build polling must have a deadline and handle `partial_ready`: some resource classes can be
ready while others are building or failed. `getEnvironmentVersion(id, version, { resourceClass:
'starter' })` selects one class; omitting the option keeps the aggregate read. Re-read the
aggregate before concluding the build is fully ready. These details are source-reviewed.

Channel callers must not use `allow_from` as an access-control list: the public gateway ignores
it. Use supported `dm_policy` settings.

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

## Two helpers

```ts
const agent = await zc.waitUntilRunning(agentId)          // polls desired_state, not actual_state
const events = await zc.listAllEvents(agentId, sessionId) // pages past the silent 500 cap
```

Each wraps a trap that is invisible from the outside: readiness lives in `status.desired_state`,
and `listEvents` truncates at 500 events with nothing in the response to say it did.

## Documentation

Full guides and the capability matrix: **[zoowork-agents-docs](https://github.com/SerendipityOneInc/zoowork-agents-docs)**.

Runnable examples in [`examples/`](examples):

- [`live-smoke.ts`](examples/live-smoke.ts) — drive one agent through one turn and verify the REST and SSE reads agree.
- [`capability-probe.ts`](examples/capability-probe.ts) — create a throwaway agent, walk the whole lifecycle, and print a verdict per capability.

## Release checks (maintainers)

E2E belongs to this SDK's `e2e/` directory and is required before every SDK publish,
not on every PR. Use Node 22.20+ and the SDK's locked development dependencies:

```sh
pnpm install --frozen-lockfile
pnpm test:e2e
```

On a new development machine, only this SDK checkout is needed. The command prepares a
candidate, then asks for a staging API key with input hidden. Submitting the key authorizes
one temporary Agent/Session, one potentially billable model turn and cleanup. It defaults to
the SDK's configured staging endpoint, prints the retained result directory, and never
publishes. Use `--base-url` to explicitly select another staging deployment.

Before a release, choose the final version/changelog **before** running E2E. Only after it
passes, manually run `pnpm release:publish --out-dir DIR --confirm-publish` using the printed
candidate directory. The separate `release:prepare` / `release:check` commands remain available.

Normal `pnpm test` needs no key. Ordinary directory publishing is blocked to prevent
rebuilding an untested candidate. No hosted workflow stores a staging key or runs this E2E.
See [the release and recovery instructions](e2e/README.md) before handling a credential or
publishing; tests and a staging pass alone are not publication permission.

## License

MIT
