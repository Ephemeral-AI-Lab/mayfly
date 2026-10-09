// The stale-row check of the retained renders (roadmap slice 1.12): runs the suites with MAYFLY_UI_VERIFY_MEMO=1, so
// every retained-row hit paints again and throws when the rows differ. A row that reads something the surface epoch does
// not track fails here instead of showing stale on a screen. The work-budget workloads are left out: they count paints,
// and this mode paints on purpose.
// Run: pnpm run test:retained [-- <vitest filters>]

import { spawnSync } from 'node:child_process'
import { root } from './smoke-lib.mjs'

const filters = process.argv.slice(2).filter(argument => argument !== '--')
const result = spawnSync('pnpm', ['exec', 'vitest', 'run', ...filters, '--exclude', '**/tests/perf/**', '--exclude', '**/node_modules/**', '--reporter=dot', '--silent=passed-only'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, MAYFLY_UI_VERIFY_MEMO: '1' },
})
process.exit(result.status ?? 1)
