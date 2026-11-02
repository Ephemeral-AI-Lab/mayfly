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
    // Coverage plus the full source scans can exceed the 5s default on a
    // loaded runner; the release branch raises the ceiling to 15s (owner
    // decision, 2026-10-18). Assertions are unchanged.
    testTimeout: 15_000,
    projects: [
      { extends: true, test: { name: 'suite', include: SPECS, exclude: [PERF, '**/node_modules/**'], env: { MAYFLY_UI_VERIFY_MEMO: '1' } } },
      { extends: true, test: { name: 'perf', include: [PERF] } },
    ],
    // Executable package and example source is covered per file. An aggregate
    // percentage cannot hide an untested command or lifecycle owner.
    coverage: {
      provider: 'v8',
      excludeAfterRemap: true,
      include: ['packages/*/src/**/*.ts', 'examples/*/src/**/*.ts', 'packages/host/lib/index.js'],
      // Types-only files carry no executable code.
      exclude: ['packages/*/src/types.ts', 'examples/*/src/types.ts'],
      reportsDirectory: '.artifacts/coverage',
      thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 },
      reporter: ['text-summary', 'json-summary', 'html'],
    },
  },
})
