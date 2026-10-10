/**
 * Select what a change set can affect: the specs and repository-workflow tests the import graph carries each changed
 * path to (with the chain that reached each one), the checks whose inputs or entry scripts it reaches, and the full
 * gate only for a global input or a path no rule claims. @module script/verify/select
 */

import { fileURLToPath } from 'node:url'
import { normalizeChangedFiles } from '../change-files.mjs'
import { buildGraph, CODE_FILE, covers, dependents, NODE_TEST_FILE, SPEC_FILE } from './graph.mjs'
import { CHECKS, DATA_READS, GLOBAL, INERT, STRUCTURAL } from './inputs.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

const NO_CHECKS = { lint: false, typecheck: false, build: false, checkLib: false, pack: false, examples: false, shots: false, agentDocs: false, diagrams: false, website: false, smoke: false }

/** Expand a plan to the repository's complete deterministic gate. */
export function promoteToFull(plan, reason) {
  return {
    ...plan,
    mode: 'full',
    reasons: [...new Set([...plan.reasons, reason])],
    checks: { ...plan.checks, lint: true, typecheck: true, build: true, checkLib: true, examples: true, shots: true, agentDocs: true, diagrams: true },
  }
}

const graphs = new Map()
/** The graph of a repository, built once per process, with the declared reads the scanner cannot see. */
export function repositoryGraph(root = ROOT) {
  let graph = graphs.get(root)
  if (graph === undefined) {
    graph = buildGraph(root)
    for (const [reader, read] of DATA_READS) graph.nodes.get(reader)?.edges.push({ to: read, kind: 'data' })
    graphs.set(root, graph)
  }
  return graph
}

/**
 * Whether some rule accounts for a path: the graph parses it, an edge reads it, or the inputs name it.
 * @param {{ nodes: Map<string, { edges: { to: string }[] }> }} graph
 */
export function claimed(graph, file) {
  if (graph.nodes.has(file) || CODE_FILE.test(file)) return true
  if (GLOBAL.some(rule => rule.pattern.test(file)) || INERT.some(pattern => pattern.test(file)) || STRUCTURAL.test(file)) return true
  if (Object.values(CHECKS).some(check => check.inputs.some(pattern => pattern.test(file)))) return true
  if (/\/__snapshots__\/[^/]+\.snap$/u.test(file)) return true
  for (const node of graph.nodes.values()) if (node.edges.some(edge => covers(edge.to, file))) return true
  return false
}

/**
 * Plan the verification of a change set.
 * @param {readonly string[]} inputFiles - changed repository paths, deleted ones included.
 * @param {{ graph?: ReturnType<typeof repositoryGraph> }} [options] - the graph (default: this repository's).
 */
export function classifyChanges(inputFiles, { graph = repositoryGraph() } = {}) {
  const files = normalizeChangedFiles(inputFiles)
  const reasons = []
  const checks = { ...NO_CHECKS }
  const manualAcceptance = new Set()
  let full = false
  const present = new Set(graph.files)

  for (const file of files) {
    const global = GLOBAL.find(rule => rule.pattern.test(file))
    if (global !== undefined) {
      full = true
      reasons.push(`${file}: ${global.reason}`)
      if (/^(?:pnpm-lock\.yaml|pnpm-workspace\.yaml|script\/package-contract\.mjs|packages\/mayfly\/(?:cordis\.patch\.yml|presets\/.*))$/u.test(file)) checks.pack = true
    } else if (!claimed(graph, file)) {
      full = true
      reasons.push(`${file}: no rule claims this path`)
    }
    for (const [name, check] of Object.entries(CHECKS)) if (check.inputs.some(pattern => pattern.test(file))) checks[name] = true
    if (STRUCTURAL.test(file)) checks.build = true
    if (/^(?:packages|examples)\/[^/]+\/src\/.+\.ts$/u.test(file)) checks.build = true
    if (/^(?:packages|examples)\/.+\.(?:[cm]?ts|tsx)$/u.test(file) && present.has(file)) checks.lint = true
    if (CODE_FILE.test(file) && !file.startsWith('docs/')) checks.typecheck = true
    if (/^packages\/(?:mayfly\/(?:src\/|presets\/|cordis\.patch\.yml)|ui\/src\/)/u.test(file)) manualAcceptance.add('runtime-profile')
    if (file.startsWith('website/')) manualAcceptance.add('website-preview')
  }

  // Everything the changed paths reach: the specs and workflow tests to run, and the checks whose entry they reach.
  const reached = dependents(graph, files)
  const why = {}
  const specs = []
  const nodeTests = []
  for (const [file, chain] of reached) {
    if (!present.has(file)) continue
    if (SPEC_FILE.test(file)) specs.push(file)
    else if (NODE_TEST_FILE.test(file)) nodeTests.push(file)
    else continue
    why[file] = chain
  }
  for (const [name, check] of Object.entries(CHECKS)) if (check.entry !== undefined && reached.has(check.entry)) checks[name] = true

  const plan = {
    files,
    mode: full ? 'full' : files.length === 0 ? 'none' : 'changed',
    reasons: [...new Set(reasons)],
    checks,
    tests: { specs: specs.sort(), nodeTests: nodeTests.sort(), why },
    manualAcceptance: [...manualAcceptance],
  }
  return full ? promoteToFull(plan, 'full gate required by change classification') : plan
}
