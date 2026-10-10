/**
 * V8 CPU profiles (`--cpu-prof`) summarized as the functions that took the most self time, and two summaries compared
 * function by function. @module script/scenarios/cpuprofile
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/** A function's name, file, and line. */
const keyOf = frame => `${frame.functionName === '' ? '(anonymous)' : frame.functionName} ${frame.url === '' ? '' : `${basename(frame.url)}:${String(frame.lineNumber + 1)}`}`.trim()

/**
 * The self time of each function across every profile in a directory.
 * @param {string} dir
 * @returns {Map<string, number>} milliseconds by function.
 */
export function selfTimes(dir) {
  const totals = new Map()
  if (!existsSync(dir)) return totals
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
