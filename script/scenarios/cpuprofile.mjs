/**
 * V8 CPU profiles (`--cpu-prof`) of scenario runs, summarized as the functions that took the most self time, and two
 * summaries compared function by function. A run writes its profiles into one directory of its own
 * ({@link profileLeaf}); a scenario's summary reads exactly the directories of its runs. @module script/scenarios/cpuprofile
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/** A function's name, file, and line. */
const keyOf = frame => `${frame.functionName === '' ? '(anonymous)' : frame.functionName} ${frame.url === '' ? '' : `${basename(frame.url)}:${String(frame.lineNumber + 1)}`}`.trim()

/**
 * The directory one run of a scenario writes its profiles to.
 * @param {string} root - the checkout that runs the product.
 * @param {'head' | 'base'} side
 * @param {string} name - the scenario.
 * @param {number} run - from 1.
 */
export function profileLeaf(root, side, name, run) {
  return join(root, '.artifacts/perf/prof', side, `${name}-${String(run)}`)
}

/**
 * The self time of each function across every profile in the directories; a directory that does not exist adds nothing.
 * @param {string | string[]} dirs - each holds the `.cpuprofile` files directly, not in subdirectories.
 * @returns {Map<string, number>} milliseconds by function.
 */
export function selfTimes(dirs) {
  const totals = new Map()
  for (const dir of typeof dirs === 'string' ? [dirs] : dirs) {
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir).filter(name => name.endsWith('.cpuprofile'))) {
      const profile = JSON.parse(readFileSync(join(dir, file), 'utf8'))
      const byId = new Map(profile.nodes.map(node => [node.id, node]))
      const deltas = profile.timeDeltas ?? []
      profile.samples?.forEach((id, index) => {
        const node = byId.get(id)
        if (node === undefined || ['(idle)', '(program)', '(garbage collector)'].includes(node.callFrame.functionName)) return
        const key = keyOf(node.callFrame)
        totals.set(key, (totals.get(key) ?? 0) + (deltas[index + 1] ?? deltas[index] ?? 0) / 1000)
      })
    }
  }
  return totals
}

/**
 * The top functions by self time, with the baseline's time beside each when given.
 * @param {Map<string, number>} head
 * @param {Map<string, number>} [base]
 * @param {number} [count]
 * @returns {{ fn: string, headMs: number, baseMs?: number }[]}
 */
export function topFunctions(head, base, count = 15) {
  return [...head.entries()].sort((a, b) => b[1] - a[1]).slice(0, count).map(([fn, ms]) => ({ fn, headMs: Number(ms.toFixed(1)), ...(base === undefined ? {} : { baseMs: Number((base.get(fn) ?? 0).toFixed(1)) }) }))
}

/**
 * The functions with the most self time in one scenario's runs, in milliseconds per run. It reads the directories of
 * runs `1..runs` only, so the profiles of other scenarios or of earlier invocations do not count.
 * @param {string} root - the checkout whose `.artifacts` holds the profiles of both sides.
 * @param {string} name - the scenario.
 * @param {number} runs - how many runs each side made.
 * @param {boolean} [withBase] - whether the baseline side ran too.
 * @throws when the head side left no profile: a summary that is silently empty reads as "no hot function".
 * @returns {{ fn: string, headMs: number, baseMs?: number }[]}
 */
export function scenarioFunctions(root, name, runs, withBase = false) {
  const perRun = side => new Map([...selfTimes(Array.from({ length: runs }, (_, index) => profileLeaf(root, side, name, index + 1))).entries()].map(([fn, ms]) => [fn, ms / runs]))
  const head = perRun('head')
  if (head.size === 0) throw new Error(`${name}: --prof left no CPU profile under ${profileLeaf(root, 'head', name, 1)}`)
  return topFunctions(head, withBase ? perRun('base') : undefined)
}
