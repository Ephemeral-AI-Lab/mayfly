/**
 * What the import graph cannot see: the inputs that escalate to the full gate, the non-code inputs of each check, the
 * entry script that runs each check (a change that reaches it through the graph selects the check), and the files no
 * check reads. Every tracked file is a graph node, a data target, or matched here; `claimed-files.test.mjs` holds the
 * repository to that. @module script/verify/inputs
 */

/** Inputs every check depends on: a change to one runs the full gate. */
export const GLOBAL = [
  { pattern: /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig(?:\.[^/]+)?\.json|tsdown\.config\.ts|vitest\.config\.ts|\.oxlintrc\.json)$/u, reason: 'repository configuration' },
  { pattern: /^script\/package-contract\.mjs$/u, reason: 'the package and build contract' },
  { pattern: /^script\/scenarios\/split-release-policy\.json$/u, reason: 'the exact published-reference release decisions' },
  { pattern: /^\.github\/workflows\//u, reason: 'a CI workflow' },
  { pattern: /^packages\/host\/(?:cordis\.patch\.yml|presets\/)/u, reason: 'the shipped Host composition contract' },
]

/**
 * The checks a change can select. `inputs` are the paths the check reads that are not code; `entry` is the script that
 * runs it, so a change the graph carries to that script selects the check too.
 */
export const CHECKS = {
  agentDocs: { entry: 'script/check-agent-docs.mjs', inputs: [/(?:^|\/)AGENTS\.md$/u, /\/SKILL\.md$/u, /^\.agents\//u, /^docs\/skills\//u, /\/mayfly-skills-plan\.md$/u] },
  diagrams: { entry: 'script/sync-diagrams.mjs', inputs: [/^docs\/diagrams\//u, /^README(?:\.zh)?\.md$/u, /^docs\/mayfly-architecture\.md$/u] },
  checkLib: { entry: 'script/check-lib-exports.mjs', inputs: [/^(?:packages|examples)\/[^/]+\/(?:package\.json|tsconfig\.json)$/u, /^packages\/ui\/src\//u, /^script\/(?:clean-lib|prune-types)\.mjs$/u] },
  examples: { entry: 'script/check-examples.mjs', inputs: [/^examples\//u, /^packages\/ui\/src\//u] },
  pack: { entry: 'script/check-pack.mjs', inputs: [/^packages\/[^/]+\/package\.json$/u, /^packages\/host\/(?:cordis\.patch\.yml|presets\/)/u, /^packages\/ui\/src\//u, /^script\/(?:release-packages|release-preflight|registry-release)\.mjs$/u] },
  smoke: { entry: 'script/split-parity.mjs', inputs: [/^script\/install-dev\.sh$/u] },
}

/** Reads the scanner cannot see (a path joined at run time), as `[reader, read]`: a change to `read` reaches `reader`. */
export const DATA_READS = [
  ['script/scenarios/split-release-review.mjs', 'script/scenarios/split-release-policy.json'],
  // The agent-doc scanner walks instruction files rather than importing them.
  ...['AGENTS.md', 'packages/ui/AGENTS.md', 'packages/mayfly/AGENTS.md', 'packages/host/AGENTS.md', 'packages/cli/AGENTS.md', 'examples/AGENTS.md'].map(file => ['script/check-agent-docs.mjs', file]),
  // The preset spec reads the shipped Host composition by path.
  ['packages/host/tests/presets.spec.ts', 'packages/host/presets/'],
  ['packages/host/tests/presets.spec.ts', 'packages/host/cordis.patch.yml'],
  // The type fixtures compile with tsc against the declarations every source file of the contract emits.
  ['packages/ui/tests/types.spec.ts', 'packages/ui/tests/tsconfig.json'],
  ['packages/ui/tests/types.spec.ts', 'packages/ui/tests/ui.compile.ts'],
  ['packages/ui/tests/types.spec.ts', 'packages/ui/src/'],
  // The guard specs read whole source trees and import nothing from them, so any edit under a tree they scan reaches them.
  ['packages/mayfly/tests/core/keyboard-boundary.spec.ts', 'packages/mayfly/src/interaction/'],
  ['packages/mayfly/tests/core/keyboard-boundary.spec.ts', 'packages/mayfly/src/transcript/'],
  ['packages/mayfly/tests/components/layering.spec.ts', 'packages/mayfly/src/components/'],
  ['packages/mayfly/tests/core/business-rendering-drift.spec.ts', 'packages/mayfly/src/'],
  ['packages/mayfly/tests/core/business-rendering-drift.spec.ts', 'packages/ui/src/'],
  ['packages/mayfly/tests/core/business-rendering-drift.spec.ts', 'packages/cli/src/'],
  ['packages/mayfly/tests/frontend/architecture-boundary.spec.ts', 'packages/mayfly/src/'],
  ['packages/mayfly/tests/frontend/architecture-boundary.spec.ts', 'packages/ui/src/'],
  ['packages/mayfly/tests/locale-catalog.spec.ts', 'packages/mayfly/src/'],
]

/**
 * Product sources that run in the shipped Host or TUI: a change to one runs the real Host/TUI split smoke and needs
 * the dedicated runtime-profile acceptance.
 */
export const RUNTIME_SOURCE = /^packages\/(?:mayfly|host|ui|cli)\/src\//u

/**
 * Files nothing in the gate reads: prose, history, the design sketch, scripts a person runs, and the Website with its
 * screenshots, which only a release checks (`shots:check`, `website:build`).
 */
export const INERT = [
  // The split deployment's TUI launcher: a documented dev convenience no check reads.
  /^script\/mayfly-tui\.sh$/u,
  /^LICENSE$/u,
  /^website\//u,
  /^\.gitignore$/u,
  /^docs\//u,
  /^(?:packages|examples)\/[^/]+\/(?:README(?:\.zh)?\.md|LICENSE|THIRD-PARTY-NOTICES\.md|\.gitignore|CHANGELOG\.md)$/u,
  // Build-face configuration the checks read by literal path, not through an import.
  /^packages\/host\/tsconfig\.(?:client|host)\.json$/u,
  /^packages\/[^/]+\/tsconfig\.tests\.json$/u,
  // The typert generator is patched to accept out-of-tree Host protocol declarations.
  /^patches\//u,
]

/** A repository path that changes how a package is built rather than one implementation. */
export const STRUCTURAL = /^(?:(?:packages|examples)\/[^/]+\/(?:package\.json|tsconfig\.json)|script\/(?:clean-lib|prune-types)\.mjs)$/u

/** Whether a path changes the package or build graph, so the incremental build must run the full one. */
export function isStructuralBuildPath(file) {
  return STRUCTURAL.test(file) || /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig(?:\.[^/]+)?\.json|tsdown\.config\.ts|script\/package-contract\.mjs)$/u.test(file)
}
