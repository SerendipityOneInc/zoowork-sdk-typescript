# Changelog

All notable changes to `@zooclaw-agents/sdk`. Dates are the day the behaviour was verified against
staging, not the day it was written.

## 0.0.5 — 2026-08-10

### Added

- **`listAgents(opts?)`** — `GET /agents` with `label.*` filters and `page`, unwrapping `{agents}`.
  `{ labels: { workspace_id: '…' } }` resolves a ZooClaw chat-URL workspace id to its agent — the
  missing "get your agent_id with nothing but your key" step.
  Scope is the engine's `owner_uid AND org_id`, so an agent a colleague created in your org is
  fetchable by id but absent from your list. Page size is fixed at 100 by the engine.
  Verified against staging on 2026-08-10, the day the gateway opened collection-level `GET /agents`
  (it had answered `404 service_api.not_found` until then — FEEDBACK #16).

## 0.0.4 — 2026-08-07

The Developer Preview surface goes from "agents and sessions" to the whole management plane, and
**eight response types are corrected against real recorded staging responses**. If you read any of
the fields in the table below, read that section before upgrading — the corrections are the point of
this release, and one of them was an infinite loop.

Still a patch bump: the version stays in 0.0.x until the first formal release, so the number does
not signal stability. Treat the response-shape section as breaking regardless of what the number says.

### Response shapes corrected

Every one of these was found by driving the real API, not by reading a spec. Each row is what the
SDK's type promised, what the server actually sends, and what it cost the caller.

**1. `ScheduleRecord` had `schedule` and `sessionTarget`. The server sends neither.**
The read shape and the write shape are different documents. The cadence you sent as
`schedule: { kind: 'cron', expr }` reads back at `scheduleSpec.cronExpressions[0]`; the target you
sent as `sessionTarget: 'isolated'` reads back at `execution.kind`; and `scheduleId` is the
fully-qualified `cron/{computer_id}/{agent_id}/{schedule_id}` — the id you chose is `name`.
_Caller impact:_ `record.schedule.expr` was `undefined`, and passing `record.scheduleId` back to
`getSchedule` built a path that could not resolve.

**2. `updateSchedule` promised a `getSchedule` → `PUT` round trip and stripped only one field.**
The real body is refused for **six**: `execution`, `originMetadata`, `creatorPrincipalRef`,
`contextSnapshot` and `sessionTarget` are `400`, and `scheduleSpec` is worse (see 3). All six are now
`never` in `ScheduleUpdate` and stripped at runtime, so the obvious JavaScript round trip works.
_Caller impact:_ read-modify-write on a schedule was a `400 invalid_request`.

**3. `scheduleSpec` on a `PUT` is a SILENT NO-OP.**
`{ scheduleSpec, enabled: false }` answers **HTTP 200**, applies `enabled`, and leaves the cadence
exactly as it was. To change the cadence send `schedule: { kind: 'cron', expr, tz }` — the input
vocabulary. _Caller impact:_ a successful-looking update that quietly did not change the schedule.

**4. `ScheduleRun`'s fields were invented.**
`runs[]` is ONE array with TWO row shapes, discriminated by `source`: `run_projection` rows carry
`fired_at` / `status` / `consecutive_errors` (the outcome), `temporal` rows carry `scheduled_at` /
`taken_at` / `workflow_id` / `temporal_run_id` (the dispatch). Rows are grouped by source, not sorted
by time. **Neither shape carries `session_id`** — there is no walk from a fire to the session it
created; match `channel: 'cron'` and the `session_key` prefix instead.
_Caller impact:_ `run.status` was `undefined` on half the rows and `runs[0]` was not the latest fire.

**5. `EnvironmentRecord.state` and `.ownership` do not exist.**
Lifecycle is `status` (`active` / `archived`) and the tenant is flat: `scope` + `org_id`. The record
also gained `latest_ready_version`, and the two version numbers are not the same number:
`latest_version` is `1` the instant you create an Environment while version 1 is still `queued`;
`latest_ready_version` is `null` until a build lands. **Pin `latest_ready_version`.**
_Caller impact:_ `env.state` and `env.ownership.org_id` were `undefined`, and pinning
`latest_version` on an agent answered `409 environment_not_ready`.

**6. `EnvironmentVersionRecord.state` does not exist — the field is `status`.**
The JSDoc told callers to poll `getEnvironmentVersion` until `state === 'ready'`. `state` is
permanently `undefined`, so that loop compares `undefined` to `'ready'` for as long as the process
lives. _Caller impact:_ **an infinite loop** — the same class of bug as the `actual_state` trap this
SDK was written to prevent. Also note `e2b_build_id` is populated while a version is still
`building`, so it is not a readiness signal either. `status === 'ready'` is.

**7. `SessionRecord` had no `run_status`, and `status` is not the outcome.**
`listSessions` rows carry `run_status` (`succeeded`, `running`, …) and have **no `status` key at
all**; `getSession` returns `status: null` for the very same session, alongside its own `run_status`.
`status` is now typed `string | null`. _Caller impact:_ **this is the one correction that affects
published 0.0.3 consumers** — `session.status` was typed `string | undefined`, and reading it got
`null` from a read and `undefined` from a list row, never an outcome.

**8. `SkillRecord.ownership` required both fields as strings.**
An `org`-scope skill answers `owner_uid: null` (it belongs to the org, not a person), and a `global`
catalog row answers **both** fields as `null`. `SkillRecord.ownership` is now deliberately looser
than `Ownership`. In the same response, `latest_version` comes back as the **string `"1"`** from the
multipart create while other surfaces spell it as a number — compare loosely, or `Number()` it.
_Caller impact:_ `ownership.owner_uid` was typed non-null and was `null`, and `latest_version === 1`
was `false`.

### Platform behaviour you have to know

These are not SDK bugs and cannot be typed away. They are how the platform behaves.

- **`scheduleSpec` on a `PUT` is accepted, answers 200, and is ignored** (see 3). The response of a
  no-op update is byte-identical to the response of a real one; only a follow-up `getSchedule` can
  tell you which you got.
- **`triggerSchedule` on a DISABLED schedule answers `triggered: true`** while the run projection
  records `status: "skipped"`. `triggered` means the fire was dispatched, never that the turn ran.
  The outcome is only in `listScheduleRuns`, on the `run_projection` row.

### Added

- **Schedules** — `listSchedules`, `createSchedule`, `getSchedule`, `updateSchedule`,
  `deleteSchedule`, `triggerSchedule`, `listScheduleRuns`. Schedules outlive their agent: delete them
  yourself before deleting the agent.
- **Environments** — `listEnvironments`, `getEnvironment`, `createEnvironment`,
  `createEnvironmentVersion`, `getEnvironmentVersion`, `archiveEnvironment`. `archiveEnvironment`
  percent-encodes the colon in `{id}:archive`; a raw `:` is a 404, which is the whole reason the
  method exists.
- **Skill registry** — `uploadSkill`, `uploadSkillVersion`, `listSkills`, `deleteSkill`. The zip's
  single top-level directory name must equal the `name` in `SKILL.md`'s frontmatter; `scope` may only
  be `org` or `personal`.
- **Sessions** — `listSessions`, `archiveSession`, `deleteSession`, and `listAllEvents`, which pages
  `listEvents` to the end. `listEvents` truncates at 500 with nothing in the response to say so.
- **Readiness** — `waitUntilRunning`, which polls `status.desired_state` and never `actual_state`.
  `actual_state` is chat-channel health; an API-only agent parks at `activating` forever.
- **Approvals** — `listApprovals`, `resolveApproval`. The route answers, but no real pending approval
  has ever been produced, so `ApprovalRecord`'s field names are unverified. Read defensively.
- **Automation and operations** — `wake`, `exec`. A non-zero `exec` exit is still HTTP 200: the
  promise resolves, check `exit_code`.
- **MCP** — `McpServerDeclaration` on `AgentResource.mcp`. Unauthenticated remote servers only;
  `credential` is accepted and stored but unusable through the gateway.

### Fixed

- **`ZooclawError.type` was `undefined` for every agent-family error.** There are two error
  envelopes: most families answer `{ error: { type, message } }`, the agents family answers
  `{ code, detail }`. Only the first was parsed, so an agent `404` reached callers as
  `type: undefined` with the message `HTTP 404`. Both are parsed now, and the codes are surfaced
  verbatim — note the vocabularies differ (`not_found` vs `service_api.not_found`).
- `createEnvironment`'s doc comment told callers to poll for `state: 'ready'`. See correction 6.

### Tests

`pnpm test` is now the whole gate, and it runs the type checker before the suite — about half of what
this SDK guarantees is type-level, and reintroducing a wrong response type fails `tsc` rather than an
assertion.

- `src/__fixtures__/` — 55 REAL recorded staging responses, scrubbed of ids and credentials but
  otherwise byte-faithful, down to `latest_version: "1"` being a string. Never hand-authored: a
  hand-written fixture encodes the same guess the type does, so it can only agree with a wrong type.
- `src/responses.test.ts` — every fixture replayed through the method that returns it. Asserts
  declared fields, absent fields, `null` versus missing, and — for each record type — that the SDK
  declares nothing no recorded response has ever carried. All eight corrections above are red under
  that check if reintroduced.
- Tests now import through `src/index.ts`, the published entry point, and `src/index.test.ts` pins
  the export set, so a symbol missing from the entry point is a failing test rather than a broken
  consumer.
- `src/sse.test.ts` — the frame parser split into its own file.
- CI on push and pull request: Node 24, `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm build`.
  The staging probes in `examples/` are excluded from the test glob and never run in CI — they need a
  real API key and mutate a live tenant.

## 0.0.3 — 2026-08-05

Initial public release: agents, sessions, durable events and the SSE stream.
