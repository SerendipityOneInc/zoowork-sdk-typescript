# Response fixtures

Real staging responses, recorded verbatim. Nothing in this directory is hand-authored, and
nothing in it may be edited by hand.

That rule is the whole point. This SDK exists because the API has shapes nobody would guess —
the same event is `snake_case` over REST and `camelCase` over SSE, one agent resource has two
different projections depending on whether you created it or read it, a readiness field means
channel health, a colon must be percent-encoded on one resource family and is rejected on
another. A hand-written fixture encodes the same guess the types encode, so it can only ever
agree with a wrong type. A recorded one disagrees.

## Shape

Each file wraps one response with the request that produced it:

```json
{ "method": "GET", "path": "/agents/agt_.../schedules/surface-probe-schedule", "status": 200, "body": { … } }
```

`body` is the response exactly as it arrived, copied before the SDK parsed or normalized it.
Do not tidy it. `latest_version: "1"` is a string on purpose, `status: null` is null on purpose,
and a key the types promise but the server omits is absent on purpose — those three are
recorded bugs, not typos.

## Provenance

Written by `examples/surface-probe.ts` with recording enabled:

```sh
ZOOCLAW_API_KEY=zct_… ZOOCLAW_RECORD_FIXTURES=1 pnpm exec tsx examples/surface-probe.ts
```

The probe creates its own throwaway agent, skill, schedule and environment, drives the whole
surface, and deletes everything it made. Re-recording rewrites this directory from scratch, so
a re-record is a clean diff of what the server changed.

## Scrubbing

Headers are never captured, so no `Authorization` can reach disk. Agent, computer, session,
skill and environment ids, org and user identifiers, and any e-mail address are rewritten to
stable placeholders that keep the shape of what they replace (`agt_AGENT1000…`,
`00000000-0000-4000-8000-000000000001`, `user1@example.invalid`). The rewrite is a substring
pass over the serialized body, so ids embedded inside other strings go too — a schedule's
fully-qualified `cron/{computer}/{agent}/{id}` and a session's `session_key` both carry one.

This repository is English-only, and a few platform skills ship bilingual descriptions, so a
free-text value containing CJK is replaced whole by `"<non-English text removed>"`. Only prose
is ever affected — every key in these bodies is ASCII, and no id, status or enum value has been
anything else.

Timestamps, hashes, counts, key names, key ORDER, null-versus-absent and string-versus-number
are all left exactly as they arrived.
