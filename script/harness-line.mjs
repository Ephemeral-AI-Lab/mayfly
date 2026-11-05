// Single source for the pinned harness line: prints the Host manifest's exact
// Harness peer (the same read smoke-lib.mjs performs), so CI and scripts never
// carry a second version literal. Exits 1 when the pin is missing.

import { harnessLine } from './smoke-lib.mjs'

if (harnessLine === undefined) {
  console.error('harness-line: the @deepseek-ai/dsh-session peer is missing from packages/host/package.json')
  process.exit(1)
}
console.log(harnessLine)
