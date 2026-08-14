# @zooclaw-agents/sdk

TypeScript SDK for the [ZooClaw Managed Agents](https://github.com/SerendipityOneInc/zoowork-agents-docs) API. Developer Preview.

Zero runtime dependencies — it uses the platform `fetch`, which you can override for edge runtimes and tests. ESM only, Node 20+.

```bash
npm install @zooclaw-agents/sdk
```

## Quickstart

You need an API key (`zct_...`) issued for your organization — create one in the ZooClaw App under **Settings → API Keys** (any personal org; enterprise orgs need the admin role), or ask your org admin for one. The secret is shown exactly once at creation. Keep it server-side: it authenticates as your whole organization, not as one end user.

```ts
import { createZooclawClient } from '@zooclaw-agents/sdk'

const zc = createZooclawClient({ apiKey: process.env.ZOOCLAW_API_KEY })

// Or set ZOOCLAW_API_KEY and pass nothing at all:
// const zc = createZooclawClient()
```

The base URL has a working default, so you do not configure an endpoint. Override it with
`ZOOCLAW_BASE_URL`, or with `baseUrl` on the call, to point at a different deployment.

```ts

// 1. Create an agent. The gateway replaces `ownership` with your key's tenant,
//    and seeds the platform credentials the agent needs to call a model.
const agent = await zc.createAgent({
  resource: { name: 'research-agent', model: { primary: 'litellm/claude-sonnet-5' } },
  ownership: { owner_uid: 'placeholder', org_id: 'placeholder' },
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
| `apiKey` | `ZOOCLAW_API_KEY` | none - construction throws without one |
| `baseUrl` | `ZOOCLAW_BASE_URL` | the public gateway (`DEFAULT_BASE_URL`) |
| `fetch` | - | `globalThis.fetch` |

An explicit option always beats the environment variable.

> **Finding the agent you built in the app.** The first path segment of a ZooClaw chat URL
> (`/chat/<32-hex>/sessions/…`) is a *workspace* id, not an `agt_…`. Resolve it with
> `zc.listAgents({ labels: { workspace_id: '<32-hex>' } })`; a bare `zc.listAgents()` lists
> everything your key can see. Scope is `owner_uid AND org_id` — an agent a *colleague*
> created in your org is fetchable by id but will not appear in your list.

> **Wait on `status.desired_state`, never on `status.actual_state`.**
> `actual_state` reports chat-channel connectivity. An API-only agent has no channels,
> so it stays at `activating` forever and `active` is unreachable — a readiness loop
> that polls it never returns. `desired_state` flips to `running` in well under a second.
> `await zc.waitUntilRunning(agentId)` is that loop, written correctly.

## Streaming a turn

`run.finished` ends a turn; assistant text arrives on `agent.assistant`.

```ts
import { assistantText, isRunFinished, runOutcome, toolCall } from '@zooclaw-agents/sdk'

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
- **It resumes.** Every frame carries a durable `seq`. After a dropped connection, restart with `{ after: lastSeq }` and the server replays from there — nothing lost, nothing duplicated.
- **REST and SSE spell the same event differently** (`event_type` vs `eventType`, and neither has a top-level `type`). The SDK normalizes both into one `SessionEvent`; you only ever read `eventType`.

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
`allow-once`, `allow-always`, `deny`. Note that human-in-the-loop is not usable end to end yet: an
agent parked on an approval spends its whole turn budget waiting.

`listEnvironments`, `getEnvironment`, `createEnvironment`, `createEnvironmentVersion`,
`getEnvironmentVersion` and `archiveEnvironment` manage prebuilt sandbox images (apt/npm/pip
packages, files, a build script, and an outbound allowlist). Two facts worth having before you
start: an agent's Environment **freezes on its first sandbox creation** — after that every change
is `409 environment_locked`, and stopping the agent does not clear it — and sandbox networking
defaults to unrestricted unless the Environment declares `networking: { type: 'limited' }`.

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

Full guides and the capability matrix: **[zooclaw-docs](https://github.com/SerendipityOneInc/zoowork-agents-docs)**.

Runnable examples in [`examples/`](examples):

- [`live-smoke.ts`](examples/live-smoke.ts) — drive one agent through one turn and verify the REST and SSE reads agree.
- [`capability-probe.ts`](examples/capability-probe.ts) — create a throwaway agent, walk the whole lifecycle, and print a verdict per capability.

## License

MIT
