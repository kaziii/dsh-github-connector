import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

// tsconfig.base.json has no include, which vite-tsconfig-paths treats as
// match-all, so its paths map applies to every test file (same facade setup
// as the dsh monorepo).
export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
  test: {
    // *.e2e.ts suites (real-API smoke tests, self-skipping without a token)
    // run through a dedicated config once a network-facing package exists.
    include: ['packages/*/*/tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      // Coverage measures OUR runtime source; types-only modules carry no
      // executable code (dsh monorepo convention).
      include: ['packages/*/*/src/**/*.ts'],
      exclude: ['packages/*/*/src/types.ts'],
      // 100% or it doesn't merge (dsh docs/testing.md). Per-file so a
      // well-covered big file can't subsidize a bare one.
      thresholds: {
        perFile: true,
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
      reporter: ['text'],
    },
  },
})
