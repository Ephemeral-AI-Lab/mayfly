import { defineConfig } from 'vitest/config'

// Source-plane tests: specs import the package under test through relative
// ../src/*.ts paths; every @deepseek-ai/* runtime dependency resolves from
// node_modules (pnpm workspace links + the npm registry).
export default defineConfig({
  test: {
    // Renderer fixtures are reproducible; accessibility specs override these explicitly.
    env: { NO_COLOR: '', TERM: 'xterm-256color', LC_ALL: 'C.UTF-8' },
    include: ['packages/*/tests/**/*.spec.ts', 'examples/*/tests/**/*.spec.ts'],
    // Forked workers avoid Node 24's worker-thread CJS lexer crashes.
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'examples/*/src/**/*.ts'],
      // Types-only files carry no executable code.
      exclude: ['packages/*/src/types.ts', 'examples/*/src/types.ts'],
      thresholds: {
        perFile: true,
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
      reporter: ['text', 'html'],
    },
  },
})
