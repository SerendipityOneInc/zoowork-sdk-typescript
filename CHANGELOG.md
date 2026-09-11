# Changelog

All notable changes to `@zoowork-ai/sdk` (formerly `@zooclaw-agents/sdk`). Dates are the
day the behaviour was verified, not the day it was written.

## 0.6.0 — 2026-09-11

### Changed

- **Breaking: `listAgents()` now resolves to an `AgentPage`, not an array.** Read `.data`
  for the current page. The SDK preserves `page`, `page_size`, and `total`, and derives a
  numeric `next_page` (`null` at the end). Existing one-page callers should replace
  `const agents = await zc.listAgents(opts)` with `const { data: agents } = await zc.listAgents(opts)`.
- **Agent lists support automatic and manual pagination.** Use
  `for await (const agent of zc.listAgents(opts))`, or `page.hasNextPage()` /
  `page.getNextPage()`. Resolved pages are async iterable and provide `iterPages()`.
  Later requests preserve the original label filters; early loop exit stops further fetches.
- Missing, invalid, or non-advancing agent pagination metadata now raises an error instead
  of hiding a partial result. The API's fixed 100-item numeric pagination is unchanged.
  Cross-page behavior is verified with synthetic offline HTTP tests; the live release
  smoke covers one Agent/Session turn and cleanup, not a 101-agent pagination walk.

## 0.5.2 — 2026-09-04

### Documentation

- **`SessionRecord` now describes the response fields the API actually returns.**
  `createSession()` returns the legacy `status: "running"` field without `run_status`;
  later reads expose the latest run state through `run_status`, while `status` is nullable
  and is not the run outcome. This changes the JSDoc emitted in the published declaration
  files; runtime code and TypeScript signatures are unchanged.

## 0.5.1 — 2026-08-31

### Added

- **`ZooworkError` keeps the evidence: `contentType`, `bodySnippet`, `cfRay`, `requestId`,
  `retryable`.** A production `postEvents` failure surfaced as `HTTP 502, type: undefined`
  and cost the reporter a day of black-box contrast experiments (2026-08-30,
  `notes/probes/system-message-cold-session-probe.mts`): the edge replaces an origin 502/504
  body wholesale with a branded `text/html` page, so no JSON envelope ever reaches the SDK —
  and 0.5.0 then dropped the only three facts that survived. Now every transport error keeps
  the response `Content-Type`, the first 600 characters of the raw body, and the `cf-ray`
  header (present on JSON errors too, verified 2026-08-31) — the id to quote when reporting
  a gateway failure. `requestId` reads `request_id` from either error envelope once the
  server starts sending one; today it is usually absent. `retryable` is a transport-class
  hint (`408/429/502/503/504`): it says the failure class tends to pass, not that a replay
  is safe — pair it with `idempotency_key` before looping on it.
  SDK-synthesized wait timeouts keep `retryable: false`: they report that the caller's own
  polling budget expired, not that an HTTP 408 came back from the service.

### Changed

- **The fallback error message names what actually came back.** A non-JSON error body used
  to read a bare `HTTP 502`; it now reads
  `HTTP 502 (text/html; charset=UTF-8) [cf-ray a338c539…]`. Messages parsed from a server
  envelope are unchanged — keep matching on `type`/`status`, never on message text.
- **`streamEvents` raises the same enriched envelope** on a non-ok response instead of the
  bare `events stream HTTP <status>` string, so SSE failures are diagnosable the same way.
- **A structured `detail` object no longer stringifies into the message.** The agents-family
  envelope may carry `detail` as an object; it previously became the literal message
  `[object Object]`, now it falls through to the status line and stays readable in
  `bodySnippet`.

## 0.5.0 — 2026-08-28

### Added

- **The QR flow now covers WeCom and WeChat, not just Feishu** — gateway PR #3512 shipped
  `/channels/{wecom,weixin}/{setup,poll,setup-cancel}`, and 0.4.x had no way to call them.
  Four platform-taking methods replace the four Feishu-only ones:
  `startChannelSetup(agentId, platform, input?)`, `pollChannelSetup`, `cancelChannelSetup`,
  `waitForChannelSetup`. New types `ChannelSetupInput`, `ChannelSetupSession`,
  `ChannelPollResult`, `GuidedSetupPlatform` (`'feishu' | 'wecom' | 'weixin'`) and
  `AddChannelPlatform`.
- **`startFeishuSetup` / `pollFeishuSetup` / `cancelFeishuSetup` / `waitForFeishuSetup` still
  work** — they now delegate to the platform-taking versions. `FeishuSetupInput` and
  `FeishuPollResult` are aliases of the new names; `FeishuSetupSession` narrows
  `ChannelSetupSession` to the one platform that always answers `verification_uri_complete`.
  Only the message text of a thrown timeout/abort changed (it names `waitForChannelSetup` and
  the platform); `status` and `type` are unchanged.

### Documentation

- **`ChannelPlatform` gains `'weixin'`, and WeChat is no longer described as unbindable.**
  0.3.2–0.4.2 said WeChat "answers `400 channel.weixin_setup_required`, naming a QR flow this
  API does not expose". The flow exists now; that error is a signpost to it, not a dead end.
  `addChannel` still refuses WeChat, so `AddChannelPlatform` is the type that lists what it
  takes.
- **Per-platform shapes, staging-verified 2026-08-28** (`notes/probes/channels-guided-probe.mts`):
  Feishu answers `verification_uri_complete` + `poll_interval: 5`, `expires_in: 600`; WeCom and
  WeChat answer `qrcode_url` with no `poll_interval` and `expires_in: 300`; WeChat's
  `qrcode_url` may be an inline `data:image/…` payload rather than a URL. WeChat reads only
  `dm_policy` and only `'open'`/`'disabled'` — `'allowlist'` is
  `400 channel.allowlist_unsupported` — pins the account to `'default'`, and ignores anything
  else in the body. Cancelled sessions 404 per platform:
  `channel.{feishu,wecom,weixin}_session_not_found`.

## 0.4.2 — 2026-08-25

### Documentation

- **`addChannel` is idempotent, not an upsert — 0.3.4 said the opposite.** Re-posting an
  identical body for the same `platform` + `account` replays the binding you already have and
  answers `201` again; that same pair with a **different** `config` answers
  `409 channel.conflict`. Rotating credentials therefore means `removeChannel` and then a
  fresh `addChannel` — a plain re-add fails. The earlier note came from re-posting the same
  body, where a replay cannot be told apart from an overwrite; the conflict path was measured
  on staging 2026-08-25. No signature or behaviour change.

## 0.4.1 — 2026-08-25

### Internal

- **Trailing slashes are stripped from the base URL by a scan rather than `/\/+$/`.** Same
  output for every input; the regex retried at every start position on a long run of
  slashes, which CodeQL flags as polynomial. Nothing hostile reaches it — the input is the
  caller's own base URL — so this closes an alert rather than a vulnerability.

### Documentation

- **`account` on `addChannel` / `startFeishuSetup` now documents what it actually is.** It
  names a binding and is part of its identity — `updateChannel` and `removeChannel` look a
  binding up by `platform` + `account`, and nothing renames one. The four constraints, all
  staging-verified 2026-08-25:
  - the name is unique per USER across every agent, not per agent;
  - `'default'` is usually taken already by a binding the app made, which this API will not
    adopt — it answers `409 channel.conflict`;
  - the format is `^[a-z0-9][a-z0-9_-]{0,63}$` plus three reserved words, and nothing is
    normalized for you;
  - this SDK cannot pre-check a name, because `listChannels` is scoped to one agent while the
    constraint spans the whole account.
- **`startFeishuSetup` warns that a name clash surfaces after the scan.** Approving the QR
  registers a new app in the Feishu workspace before the binding is written, so a clash costs
  a scan and leaves that app behind; retrying under the same name repeats both.

No runtime change — comments only.

## 0.4.0 — 2026-08-25

### Changed (breaking)

- **Renamed to `@zoowork-ai/sdk`.** The package, exports, and environment variables all
  move from the ZooClaw name to ZooWork, with no compatibility aliases:
  - Install `@zoowork-ai/sdk` instead of `@zooclaw-agents/sdk`.
  - `createZooclawClient` → `createZooworkClient`; `ZooclawClient`, `ZooclawError`,
    `ZooclawAuth`, `ZooclawConfig` → `Zoowork*`.
  - `ZOOCLAW_API_KEY` / `ZOOCLAW_BASE_URL` → `ZOOWORK_API_KEY` / `ZOOWORK_BASE_URL`.
- Server-side identifiers are unchanged: API keys still start with `zct_`, and skill or
  environment names the API returns (e.g. `zooclaw-tts`) are whatever the server says.

## 0.3.4 — 2026-08-25

### Fixed (documentation)

- **`config` keys are documented per platform**, which is what a caller actually needs:
  `slack` takes `{ botToken, appToken }` (socket mode needs the app-level token too),
  `wecom` takes `{ botId, secret }`, `feishu` takes `{ appId, appSecret, domain }` when you
  skip the QR flow. They are camelCase; other keys are stored and ignored.
- **`ChannelPlatform` explains why only Feishu has a QR flow here**, because the two absences
  are different. Slack structurally cannot have one — a Slack app is created by a person and
  its tokens only exist in that person's browser, so guided setup anywhere ends in the same
  two tokens you pass to `addChannel`. WeCom's flow exists in the product but is not exposed
  on this API yet.

## 0.3.3 — 2026-08-25

### Changed

- **`ChannelPlatform` is `'feishu' | 'slack' | 'wecom'`.** 0.3.2 also listed `'mattermost'`,
  which is the deployment's own internal connection rather than something an API caller binds;
  it is filtered out of `listChannels` server-side and does not belong on this surface. The
  type stays widened with `(string & {})`, so nothing that compiled before stops compiling.

## 0.3.2 — 2026-08-25

Probed the platform axis, which 0.3.1 had not: the routes only name Feishu, but `platform`
is a free string and the server knows more than one.

### Added

- **`ChannelPlatform`** — `'feishu' | 'slack' | 'wecom' | 'mattermost'`, widened with
  `(string & {})` so a platform that ships later needs no SDK release.

### Fixed (documentation)

- **Slack and WeCom bind through `addChannel`** — 0.3.1 read as though channels meant Feishu.
- **A Mattermost binding is invisible.** It binds, updates and removes normally, but the server
  filters it out of every `listChannels` response, so an empty list is not proof nothing is bound.
- **WeChat cannot be bound here.** `weixin`/`wechat` answer `400 channel.weixin_setup_required`
  naming a QR flow this API does not expose. Any other platform name answers
  `400 channel.invalid_request`.
- **`addChannel` is an upsert**: the same `platform` + `account` twice answers 201 again and
  overwrites, rather than conflicting.
- **`removeChannel` is idempotent, `updateChannel` is not** — removing an absent binding is
  `200 { ok: true }`; updating one is `404 channel.not_found`.
- `dm_policy: 'pairing'` is rejected with `400 channel.pairing_unsupported`.

## 0.3.1 — 2026-08-25

Channels, verified. 0.3.0 shipped the surface ahead of the deployment; this replaces its
guesses with what staging actually answered on 2026-08-25 (11 recorded fixtures, 10 new
response-contract tests). No signature changed — the corrections are in the docs and the
tests, and two of them would have cost you a debugging session:

### Fixed (documentation and contract, not behaviour)

- **`addChannel`'s 201 means STORED, not WORKING.** Credentials are not validated at bind
  time: bogus ones still answered 201 with `health: 'unknown'` / `status: 'configured'`, and
  only turned `health: 'unhealthy'` / `status: 'error'` moments later. Read the verdict from a
  follow-up `listChannels`.
- **`waitForFeishuSetup` does not return a terminal status for a session that stopped
  existing.** A cancelled session answers `404 channel.feishu_session_not_found`, which the
  helper surfaces as a thrown `ZooclawError` — 0.3.0's docs implied every ending came back as
  a value. Whether natural expiry takes this path or reports `status: 'expired'` is still
  unobserved; handle both.
- Three distinct 404 codes documented (`channel.feishu_session_not_found` /
  `channel.not_found` / `service_api.not_found`), plus the tell for a deployment that lacks
  the routes entirely: the engine passthrough envelope `{error:{type:'not_found'}}` instead of
  this family's `{code, detail}`.
- Observed defaults recorded: `expires_in: 600`, `poll_interval: 5`; `enabled: false` moves
  `status` to `'disabled'` and resets `health`; `brand: 'lark'` really does switch the URI host
  to `open.larksuite.com`.

## 0.3.0 — 2026-08-25

The surface, published the day the gateway release reached staging. Verified in 0.3.1.

### Added

- **Channels.** Bind chat platforms to an API-created agent: `listChannels`, `addChannel`
  (explicit platform config), `updateChannel`, `removeChannel`, and the Feishu/Lark QR device
  flow — `startFeishuSetup` / `pollFeishuSetup` / `cancelFeishuSetup` plus `waitForFeishuSetup`,
  which drives the poll loop at the server's suggested interval, returns every terminal
  outcome (`success` / `expired` / `denied` / `error`) instead of throwing on the human ones,
  and bounds in-flight polls the way `waitUntilRunning` does. New types: `AgentChannel`,
  `AddChannelInput`, `UpdateChannelInput`, `FeishuSetupInput`, `FeishuSetupSession`,
  `FeishuPollResult`. On gateway deployments without the channels release every route here
  answers 404.
- `deleteAgent` doc: it is a soft delete, and on channel-capable gateways a successful delete
  best-effort disables the agent's bound channels (cleanup failures never gate the delete).

## 0.2.1 — 2026-08-25

### Changed

- **`DEFAULT_BASE_URL` now points at the production API** (`https://clawapi.ecap.gsmo.ai/service/v1`).
  A client with no `baseUrl` and no `ZOOCLAW_BASE_URL` — the recommended setup — now reaches
  production, which is where API keys are issued. Verified end to end on 2026-08-25: create →
  start → session → a real model turn → replay, all against production with a production key.
  If you were relying on the previous default while pointing at another deployment, set
  `ZOOCLAW_BASE_URL` (or pass `baseUrl`) explicitly.

## 0.2.0 — 2026-08-19

Everything below was verified against staging on 2026-08-19: input echo with the
`processedAt` lifecycle, cursor pagination, `pse1:` stream resume, idempotent retry dedup,
full-object receipts, and `max_tokens` visibly capping a reply.

### Added

- **Unified event history.** The events read surface now carries your own inputs
  (`user.message`, `user.interrupt`, `user.tool_confirmation`, `system.message`) alongside
  engine events — the log alone renders the whole conversation: `listAllEvents` follows the
  server's `next_cursor`/`has_more` pagination (and still walks `after` against servers
  without it), `listEvents`/`streamEvents` accept `cursor`, `listEventsPage` returns one page
  with its pagination fields for hand-paging, streamed events carry a `cursor` resume token,
  and events expose `id` and `processedAt`. `PUBLIC_INPUT_EVENT_TYPES` is exported next to
  `SESSION_EVENT_TYPES`. Passing `after` anywhere selects the deprecated engine-only lane.
- **Event-level idempotency on `postEvents`** — give each event an `idempotency_key` and
  timeout retries stop double-delivering; accepted events come back as full event objects
  (`PostEventReceipt`).
- **`resource.model.max_tokens`** — output-token cap per model request, passed through on
  create and config PUT and enforced by the platform.

## 0.1.0 — 2026-08-17

**Breaking.** A trim, not a feature release: four pieces of `createAgent`'s surface either
raced the platform or answered 404, so they are gone rather than documented. The minor bump is
the surface change; nothing new was added.

### Removed

- **`resource.warm`** — pre-warming the agent-scope sandbox at create races the platform's
  credential injection (verified 2026-08-16, `zooclaw-engine#791`): the sandbox can come up
  before the built-in-skill credentials land, and the env snapshot never refreshes, leaving
  those skills permanently broken in that sandbox. Removing the parameter makes the race
  unreachable instead of documenting it. `createAgent` also strips `warm` at runtime, so a JS
  caller bypassing the types cannot resurrect it.
- **`resource.onboarding`** — the interactive onboarding interview is never what an API caller
  wants. `createAgent` now always sends `onboarding: false`, and strips a caller-supplied value
  at runtime alongside `warm`.
- **`putCredential()` / `listCredentials()`** — both answer 404 through the gateway. The
  platform seeds model credentials itself at create; there is no supported way to store your
  own or your end users' third-party credentials, so the methods no longer imply one.

### Changed

- **`createAgent(input)` takes `ownership` as optional.** The gateway derives the tenant
  anchors from your API key, so `{ resource }` is the whole input. The field is kept for
  callers that reach the engine without the gateway.
- **`AgentResource` no longer carries an `[k: string]: unknown` index signature.** Unknown
  fields are a type error now instead of passing silently — which is how `warm` and
  `onboarding` would otherwise have kept compiling after removal.

## 0.0.6 — 2026-08-14

Three engine surfaces that landed this week — the system-prompt pin, the artifacts control
plane, and outcome-gated cron — plus one new wire field. Everything below was driven live
through the `/service/v1` gateway on 2026-08-14 and is pinned by re-recorded fixtures.

### Added

- **`getSystemPrompt(agentId)` / `previewSystemPrompt(agentId, input)` /
  `upgradeSystemPrompt(agentId, input)`** — the pin as declared and the rendered template in
  effect; deterministic assembly of the exact prompt for given runtime facts, without touching
  a session (13 `slot_hashes`, `transcript` always `[]`); and the one write that moves the pin.
  `resource.system_prompt` is typed on `AgentResource` (`{source:'platform',version}` |
  `{source:'custom',base_version,template}`): a fresh create pins the active platform version
  on its own, the pin never follows later activations on its own, and on PUT the section is
  REPLACE-ON-WRITE like `tool_policy`. `upgradeSystemPrompt` is a real CAS —
  `expected_config_version` must be current or the answer is `409 config_version_changed`
  (both directions recorded as fixtures). The route uses the `{id}:verb` grammar, which the
  gateway blocked until fix #3387 landed the same day this shipped — on older gateway
  deployments this one method answers a gateway 404.
- **`listArtifacts` / `getArtifact` / `downloadArtifact` / `deleteArtifact`** — the control
  plane over what the agent's own in-loop `artifact_publish` tool produced (publishing from
  outside the loop still does not exist). These routes demand `owner_uid`+`org_id` selectors
  and the gateway does not inject them, so the SDK derives both from the agent's own projection
  and caches them per agent — the first artifact call costs one extra GET. `listArtifacts`
  returns the page VERBATIM (`{artifacts, page, has_more}`): unlike `listEvents`, this list
  says when it truncated, and flattening it away would have re-created that bug. The colon in
  `:download` goes RAW on the wire — this family matches the literal colon, the opposite of
  the environments family's `%3A`.
- **`OutcomeConfig`** on `SchedulePayload.outcome` and `AgentResource.outcome` — the
  evaluate-revise-finalize gate for unattended cron fires (`command` or `rubric` evaluator,
  `maxIterations` 1–5, `publish: after_satisfied | always | never`). Stored verbatim, no
  defaults injected; a job-level value overrides the agent default and an explicit `null` opts
  the job out. Cron fires only.
- **`EnvironmentVersionRecord.base_template_ref`** — new on the wire this week: the exact
  base-image build a version layers on.

### Changed

- Response fixtures re-recorded against staging 2026-08-14. Count-pinned assertions
  (global skill catalog, org environment list) now assert against the recording instead of a
  number that drifts.

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
