# ZooWork TypeScript SDK

This repository is the official TypeScript client for the public ZooWork Managed Agents API.

- Keep the public surface aligned with `zoowork-sdk-python`; API behavior comes from the public gateway contract, not TypeScript-specific invention.
- Treat identifiers and unknown response fields as opaque. Preserve server error codes verbatim in `ZooworkError`.
- Never put API keys, staging credentials, private payloads, or recorded customer data in source, fixtures, logs, or documentation.
- Unit tests and CI are offline. Live staging checks belong under `e2e/` and must be run explicitly before publication.
- The package is ESM-only for Node.js 20+ and has zero runtime dependencies. Do not add a runtime dependency without a concrete public-SDK need.
- Run `pnpm test` and `pnpm build` before committing.
- Publishing a GitHub Release triggers `.github/workflows/release.yml`, which publishes to npm through Trusted Publishing; merging a PR or pushing a tag does not. Do not add a long-lived npm token.
- Do not bump the package version, create a GitHub Release, or publish unless the user explicitly requests a release.
