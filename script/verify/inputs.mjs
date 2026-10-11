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
  { pattern: /^\.github\/workflows\//u, reason: 'a CI workflow' },
  { pattern: /^packages\/mayfly\/(?:cordis\.patch\.yml|presets\/)/u, reason: 'the shipped composition contract' },
]

/**
 * The checks a change can select. `inputs` are the paths the check reads that are not code; `entry` is the script that
 * runs it, so a change the graph carries to that script selects the check too.
 */
export const CHECKS = {
  agentDocs: { entry: 'script/check-agent-docs.mjs', inputs: [/(?:^|\/)AGENTS\.md$/u, /\/SKILL\.md$/u, /^\.agents\//u, /^docs\/skills\//u, /\/mayfly-skills-plan\.md$/u] },
  diagrams: { entry: 'script/sync-diagrams.mjs', inputs: [/^docs\/diagrams\//u, /^README(?:\.zh)?\.md$/u, /^docs\/mayfly-architecture\.md$/u] },
  checkLib: { entry: 'script/check-lib-exports.mjs', inputs: [/^(?:packages|examples)\/[^/]+\/(?:package\.json|tsconfig\.json)$/u, /^packages\/ui\/src\//u, /^script\/(?:clean-lib|prune-types)\.mjs$/u] },
  // The app shots are painted from the goldens of the `app-*` scenarios.
  shots: { entry: 'script/shots/sync.mjs', inputs: [/^script\/shots\//u, /^website\/public\/shots\//u, /^script\/scenarios\/golden\/app-/u] },
  examples: { entry: 'script/check-examples.mjs', inputs: [/^examples\//u, /^packages\/ui\/src\//u] },
  pack: { entry: 'script/check-pack.mjs', inputs: [/^packages\/[^/]+\/package\.json$/u, /^packages\/cli\/runtime\//u, /^packages\/ui\/src\//u, /^script\/(?:pack-cli-runtime|release-packages|release-preflight|registry-release)\.mjs$/u] },
  website: { inputs: [/^website\//u] },
  smoke: { entry: 'script/smoke-happy.mjs', inputs: [/^script\/install-dev\.sh$/u] },
}

/** Reads the scanner cannot see (a path joined at run time), as `[reader, read]`: a change to `read` reaches `reader`. */
export const DATA_READS = [
  ['packages/mayfly/tests/bundle.spec.ts', 'packages/mayfly/package.json'],
  // The type fixtures compile with tsc against the declarations every source file of the contract emits.
  ['packages/ui/tests/types.spec.ts', 'packages/ui/tests/tsconfig.json'],
  ['packages/ui/tests/types.spec.ts', 'packages/ui/tests/ui.compile.ts'],
  ['packages/ui/tests/types.spec.ts', 'packages/ui/src/'],
  // The guard specs read whole source trees and import nothing from them, so any edit under a tree they scan reaches them.
  ['packages/mayfly/tests/core/keyboard-boundary.spec.ts', 'packages/mayfly/src/interaction/'],
  ['packages/mayfly/tests/core/keyboard-boundary.spec.ts', 'packages/mayfly/src/transcript/'],
  ['packages/mayfly/tests/core/business-rendering-drift.spec.ts', 'packages/mayfly/src/'],
  ['packages/mayfly/tests/core/business-rendering-drift.spec.ts', 'packages/ui/src/'],
  ['packages/mayfly/tests/core/business-rendering-drift.spec.ts', 'packages/cli/src/'],
  ['packages/mayfly/tests/frontend/architecture-boundary.spec.ts', 'packages/mayfly/src/'],
  ['packages/mayfly/tests/frontend/architecture-boundary.spec.ts', 'packages/ui/src/'],
  ['packages/mayfly/tests/locale-catalog.spec.ts', 'packages/mayfly/src/'],
]

/**
 * The scenarios a product source no scenario covers runs: the empty session and a full turn for the product, and the
 * gallery for its own sources.
 */
export const SCENARIO_SMOKE = [
  { pattern: /^examples\/ui-gallery\/src\//u, scenarios: ['gallery'] },
  { pattern: /^packages\/(?:mayfly|ui)\/src\//u, scenarios: ['idle', 'tour'] },
]

/**
 * Scenario machinery: a change here can move every checkpoint, so it selects the whole catalog. The path rule covers
 * the pipeline directory (not the goldens, which select their own scenario) and the `scenarios` command itself; the
 * pipeline roots catch an outside file the run, the content, or the compare loads (the throwaway profile a boot
 * prepares). An import the command makes only to orchestrate — the change-set parser, the shots painter, the dsh
 * lookup — is not machinery and no longer runs the catalog. @see select.mjs
 */
export const SCENARIO_ALL = /^script\/scenarios(?:\.mjs|\/(?!golden\/))/u
export const SCENARIO_PIPELINE = ['script/scenarios/runner.mjs', 'script/scenarios/catalog.mjs', 'script/scenarios/golden.mjs']

/** Files nothing in the gate reads: prose, history, the design sketch, and scripts a person runs. */
export const INERT = [
  /^LICENSE$/u,
  /^\.gitignore$/u,
  /^docs\//u,
  /^(?:packages|examples)\/[^/]+\/(?:README(?:\.zh)?\.md|LICENSE|\.gitignore|CHANGELOG\.md)$/u,
]

/** A repository path that changes how a package is built rather than one implementation. */
export const STRUCTURAL = /^(?:(?:packages|examples)\/[^/]+\/(?:package\.json|tsconfig\.json)|script\/(?:clean-lib|prune-types)\.mjs)$/u

/** Whether a path changes the package or build graph, so the incremental build must run the full one. */
export function isStructuralBuildPath(file) {
  return STRUCTURAL.test(file) || /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig(?:\.[^/]+)?\.json|tsdown\.config\.ts|script\/package-contract\.mjs)$/u.test(file)
}
