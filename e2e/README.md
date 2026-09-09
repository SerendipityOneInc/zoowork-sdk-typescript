# Local SDK release

This directory owns the SDK's release checks. It is not a coding-agent skill or a hosted
workflow. Run from this SDK checkout with Node 22.20+ and locked development dependencies;
the published SDK still supports Node 20+. Normal `pnpm test` is offline and needs no key.

## Every release

Choose the final version and changelog first. Use a new private candidate directory outside
all Git repositories; its parent must already exist.

```sh
pnpm release:prepare --out-dir /absolute/private/new-candidate
```

Preparation runs SDK tests and the offline runner tests/types, compiles a clean build, checks
pack contents, and installs the tarball into an isolated consumer. It does not use API/npm
credentials or the network. Missing dependencies/cache entries are a failure, not a pass.

Provide a staging public URL and a key for an isolated test organization. Authorize one
temporary Agent/Session, one potentially billable model turn and cleanup. An assistant must
have that live-test authorization; merely finding a key or a confirmation flag is not consent.
Use a secret manager, secure stdin pipe (`--api-key-stdin`) or a hidden local prompt feeding
`ZOOWORK_API_KEY`. Never put the key in command arguments, files, Git, screenshots or logs;
do not search historical conversations, unrelated files or environment dumps for credentials.

```sh
pnpm release:check --out-dir /absolute/private/new-candidate \
  --base-url https://your-staging-host/service/v1 --confirm-staging
```

The smoke checks the model catalog, agent readiness, one successful streamed turn, matching
REST history and cleanup. It is not full API coverage or production compatibility evidence.
`--model ID` selects a catalog model; otherwise the first entry is used. The run is bounded
to 180 seconds plus a separate 60-second cleanup reserve. No schedules, uploads or environments
are created. Requests are pinned to the supplied HTTPS origin and public prefix; redirects
and the SDK's default production endpoint are refused. Do not substitute broad example probes.

Only after reviewing the results, version, registry and deployment compatibility, manually run:

```sh
pnpm release:publish --out-dir /absolute/private/new-candidate --confirm-publish
```

This verifies the successful live result, complete cleanup, unchanged source/runner/installed
package and exact tarball **before** invoking npm. It does not rebuild, rerun the live test or
change versions. It uses normal local npm authentication/2FA, without forwarding the staging
key to npm. `pnpm release:verify --out-dir DIR` performs the same verification without publishing.
If code/version/package or the intended backend deployment changes, prepare and test a new
candidate. No automatic paid retries; a live failure or incomplete cleanup blocks publication.

Ordinary directory `npm publish` / `pnpm publish` is refused by `prepublishOnly` to avoid
rebuilding a different package. The manual release command publishes the
[already-built tarball](https://docs.npmjs.com/cli/v11/commands/npm-publish/) with scripts disabled.
This is a local release guard, not an unbypassable security boundary: someone with registry
credentials can bypass local scripts. Never intentionally skip the E2E requirement.

## Results and recovery

All records stay in the private candidate directory, outside Git:

- `manifest.json`: source/version, tarball and runner hashes, completed offline checks.
- `live-started.json`: unique run ID, endpoint and bounds. Its existence prevents automatic
  reuse; never delete it just to force another attempt.
- `live-result.json`: safe phase/status, temporary resource IDs and cleanup steps.
- `result.json`: the live/cleanup verdict bound to this package and run.

Records do not contain raw API bodies/headers, prompts or model replies. Verification checks
consistency; it is not cryptographic proof of records created by another person or process.
Unavailable or contradictory evidence is not a pass.

Cleanup deletes this run's session, stops and soft-deletes its agent, and checks a 404.
Soft deletion is not a purge of historical records. Cleanup runs on normal errors/cancellation,
but a killed process, host shutdown or network outage can interrupt it.

Recover only IDs recorded for this run. For ambiguous Agent creation, match the exact
`sdk_e2e_run` label and generated name; for Session creation, inspect only that newly created
Agent and match `metadata.run_id`. Do not delete by a loose name prefix or enumerate/delete
the organization. If ownership or cleanup authority is uncertain, ask the maintainer.
Finish recovery before starting another live run. Never edit failure records into success.
