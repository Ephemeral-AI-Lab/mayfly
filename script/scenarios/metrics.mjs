/**
 * What a perf span measures of the product process: CPU time and memory from `/proc` (Linux; null elsewhere), and the
 * key-to-paint samples, frames, and bytes of the span. @module script/scenarios/metrics
 */

import { existsSync, readFileSync } from 'node:fs'

/** The process's user plus system CPU time in milliseconds (10 ms ticks), or null without `/proc`. */
export function processCpuMs(pid) {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return (Number(fields[11]) + Number(fields[12])) * 10
  } catch { return null }
}

/** The process's resident set and its high-water mark in KiB, or nulls without `/proc`. */
export function processMemoryKb(pid) {
  const file = `/proc/${String(pid)}/status`
  if (!existsSync(file)) return { rssKb: null, hwmKb: null }
  const status = readFileSync(file, 'utf8')
  const read = name => { const match = new RegExp(`^${name}:\\s+(\\d+)`, 'mu').exec(status); return match === null ? null : Number(match[1]) }
  return { rssKb: read('VmRSS'), hwmKb: read('VmHWM') }
}

/** The p-th quantile (0..1) of a list, by nearest rank, rounded to 0.01; null for none. */
export function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = values.toSorted((a, b) => a - b)
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(2))
}

/**
 * The figures of one span.
 * @param {{ name: string, wallMs: number, cpuMs: number | null, frames: number, bytes: number, keys: number[], memory: { rssKb: number | null, hwmKb: number | null } }} span
 */
export function spanMetrics({ name, wallMs, cpuMs, frames, bytes, keys, memory }) {
  return {
    name,
    wallMs: Math.round(wallMs),
    cpuMs,
    cpuPct: cpuMs === null ? null : Number((cpuMs / wallMs * 100).toFixed(1)),
    frames,
    bytes,
    ...(keys.length === 0 ? {} : {
      keys: keys.length,
      keyP50Ms: percentile(keys, 0.5),
      keyP95Ms: percentile(keys, 0.95),
      cpuPerKeyMs: cpuMs === null ? null : Number((cpuMs / keys.length).toFixed(2)),
      keySamples: keys.map(value => Number(value.toFixed(2))),
    }),
    ...memory,
  }
}
