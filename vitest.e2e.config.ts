import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

// Real-API smoke suites (*.e2e.ts). Every suite self-skips without its token,
// so this config is safe to run keyless; no coverage thresholds apply because
// the keyless spec suites already enforce per-file 100%.
export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
  test: {
    include: ['packages/*/*/tests/**/*.e2e.ts'],
    // Real network calls: one at a time, with room for slow answers.
    testTimeout: 30_000,
  },
})
