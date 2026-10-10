import { defineConfig } from 'vitest/config'

// Source-plane tests: specs import the package under test through relative
// ../src/*.ts paths; every @deepseek-ai/* runtime dependency resolves from
// node_modules (pnpm workspace links + the npm registry).
//
// One run covers both checks the gate needs (roadmap Phase 2b): the `suite`
// project paints every retained-row hit again and fails on a difference
// (MAYFLY_UI_VERIFY_MEMO), so a row that reads state the surface epoch does not
// track fails a test instead of showing stale; the `perf` project counts the
// work budgets, which that mode would inflate on purpose.
const SPECS = ['packages/*/tests/**/*.spec.ts', 'examples/*/tests/**/*.spec.ts']
const PERF = 'packages/mayfly/tests/perf/**/*.spec.ts'

export default defineConfig({
  test: {
    // Forked workers avoid Node 24's worker-thread CJS lexer crashes.
    pool: 'forks',
    projects: [
      { extends: true, test: { name: 'suite', include: SPECS, exclude: [PERF, '**/node_modules/**'], env: { MAYFLY_UI_VERIFY_MEMO: '1' } } },
      { extends: true, test: { name: 'perf', include: [PERF] } },
    ],
    // A report with a repository-wide floor (D25): each metric's value when the per-file gate went (statements 99.74,
    // branches 99.48, functions 99.81, lines 99.92), rounded down to a whole percent. The full tier runs it.
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'examples/*/src/**/*.ts'],
      // Types-only files carry no executable code.
      exclude: ['packages/*/src/types.ts', 'examples/*/src/types.ts'],
      reportsDirectory: '.artifacts/coverage',
      thresholds: { statements: 99, branches: 99, functions: 99, lines: 99 },
      reporter: ['text-summary', 'json-summary', 'html'],
    },
  },
})
