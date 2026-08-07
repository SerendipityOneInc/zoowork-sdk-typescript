# @zooclaw-agents/sdk

TypeScript SDK for the [ZooClaw Managed Agents](https://github.com/SerendipityOneInc/zooclaw-docs) API. Developer Preview.

Zero runtime dependencies — it uses the platform `fetch`, which you can override for edge runtimes and tests. ESM only, Node 20+.

```bash
npm install @zooclaw-agents/sdk
```

## Quickstart

You need an API key (`zct_...`) issued for your organization. Keep it server-side: it authenticates as your whole organization, not as one end user.

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

> **Wait on `status.desired_state`, never on `status.actual_state`.**
> `actual_state` reports chat-channel connectivity. An API-only agent has no channels,
> so it stays at `activating` forever and `active` is unreachable — a readiness loop
> that polls it never returns. `desired_state` flips to `running` in well under a second.

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

## Documentation

Full guides, the capability matrix, and a porting guide for developers coming from Claude Managed Agents: **[zooclaw-docs](https://github.com/SerendipityOneInc/zooclaw-docs)**.

Runnable examples in [`examples/`](examples):

- [`live-smoke.ts`](examples/live-smoke.ts) — drive one agent through one turn and verify the REST and SSE reads agree.
- [`capability-probe.ts`](examples/capability-probe.ts) — create a throwaway agent, walk the whole lifecycle, and print a verdict per capability.

## License

MIT
