# @zoowork-ai/sdk: notes for coding assistants

This file ships inside the installed `@zoowork-ai/sdk` package. The installed version is in
`../package.json`.

The docs at https://zoowork.ai/docs describe the newest SDK release, which can be newer than the
copy installed in this project. Before you use a method, field, or option from the docs:

- Check that it exists in the `*.d.ts` files next to this one. They are the source of truth for
  what the installed version supports.
- `../CHANGELOG.md` lists what each release up to the installed one added. Later releases are
  listed at https://raw.githubusercontent.com/SerendipityOneInc/zoowork-sdk-typescript/main/CHANGELOG.md.
- If the docs rely on something the installed version lacks, tell the user which release adds it
  and ask before upgrading. Do not upgrade the SDK without asking. If you work around the gap
  instead, for example with a deprecated method or an untyped value, say so.

**Vault is beta** (`@beta` in the declarations): Vault methods, the Vault fields of
`createSession`, revoke and offboarding. They work only where Vault is enabled for the account or
environment; otherwise they throw `VaultBetaUnavailableError` (404 `service_api.not_found`, or 400
`vault.session_fields_unavailable`). That is not an SDK bug: tell the user Vault is not enabled
rather than working around it. Behaviour and fields may change before general availability.

Server behavior (errors, event streams, schedules, limits) does not depend on the SDK version.
Follow the live docs for it: https://zoowork.ai/docs/llms.txt
