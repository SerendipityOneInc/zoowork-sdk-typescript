import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    /**
     * `src/` ONLY, and that exclusion is load-bearing.
     *
     * `examples/` holds staging probes, not tests. They require a real `ZOOWORK_API_KEY` and they
     * create, drive and delete real agents, sessions, skills, schedules and Environments inside a
     * live tenant. Nothing in there may ever be picked up by `pnpm test` or by CI — a default glob
     * that wandered into `examples/` would bill a customer's org and mutate their data to run a
     * unit-test suite.
     */
    include: ['src/**/*.test.ts'],
    exclude: ['examples/**', 'dist/**', 'node_modules/**'],
  },
})
