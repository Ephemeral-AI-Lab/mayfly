import { defineConfig } from 'vitest/config'

// Source-plane tests: specs import the package under test through relative
// ../src/*.ts paths; every @deepseek-ai/* runtime dependency resolves from
// node_modules (pnpm workspace links + the npm registry).
//
// One project paints every retained-row hit again and fails on a difference
// (MAYFLY_UI_VERIFY_MEMO), so a row that reads state the surface epoch does not
// track fails a test instead of showing stale. Coverage is a report only.
const SPECS = ['packages/*/tests/**/*.spec.ts', 'examples/*/tests/**/*.spec.ts']

export default defineConfig({
  test: {
    // Forked workers avoid Node 24's worker-thread CJS lexer crashes.
    pool: 'forks',
    include: SPECS,
    exclude: ['**/node_modules/**'],
    env: { MAYFLY_UI_VERIFY_MEMO: '1' },
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'examples/*/src/**/*.ts'],
      // Types-only files carry no executable code.
      exclude: ['packages/*/src/types.ts', 'examples/*/src/types.ts'],
      reportsDirectory: '.artifacts/coverage',
      reporter: ['text-summary', 'json-summary', 'html'],
    },
  },
})
