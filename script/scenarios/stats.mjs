/**
 * Comparing two builds' measurements: medians, a noise band from the median absolute deviation, and a two-sided
 * Mann-Whitney U test, into a verdict per metric where lower is better. @module script/scenarios/stats
 */

export const median = (values) => {
  if (values.length === 0) return null
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** The median absolute deviation from the median. */
export const mad = (values) => {
  const center = median(values)
  return center === null ? null : median(values.map(value => Math.abs(value - center)))
}

/** The standard normal distribution function (Abramowitz and Stegun 26.2.17). */
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const density = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI)
  const tail = density * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return z >= 0 ? 1 - tail : tail
}

/**
 * The two-sided p-value of the Mann-Whitney U test with the normal approximation and the tie correction.
 * @returns {number | null} null when either side has fewer than two samples.
 */
export function mannWhitneyP(a, b) {
  if (a.length < 2 || b.length < 2) return null
  const pooled = [...a.map(value => ({ value, side: 0 })), ...b.map(value => ({ value, side: 1 }))].sort((x, y) => x.value - y.value)
  const ranks = new Array(pooled.length)
  let ties = 0
  for (let start = 0; start < pooled.length;) {
    let end = start
    while (end + 1 < pooled.length && pooled[end + 1].value === pooled[start].value) end += 1
    const rank = (start + end) / 2 + 1
    for (let index = start; index <= end; index += 1) ranks[index] = rank
    const count = end - start + 1
    ties += count ** 3 - count
    start = end + 1
  }
  const rankSum = pooled.reduce((sum, entry, index) => sum + (entry.side === 0 ? ranks[index] : 0), 0)
  const [n1, n2] = [a.length, b.length]
  const u = rankSum - n1 * (n1 + 1) / 2
  const mean = n1 * n2 / 2
  const n = n1 + n2
  const variance = n1 * n2 / 12 * ((n + 1) - ties / (n * (n - 1)))
  if (variance <= 0) return 1
  const z = (Math.abs(u - mean) - 0.5) / Math.sqrt(variance)
  return Math.min(1, 2 * (1 - normalCdf(Math.max(0, z))))
}

/** Samples a side below which the rank test cannot reach p < 0.05, so a change it cannot confirm is inconclusive. */
export const CONCLUSIVE_SAMPLES = 5

/**
 * The verdict of one metric (lower is better). A change counts when the medians differ by more than the threshold and
 * by more than twice the noise band; it is `regressed` or `improved` when the rank test confirms it (p < 0.05), and
 * `inconclusive` when a side has too few samples to confirm anything (more runs decide it). Otherwise `same`.
 * @param {number[]} head
 * @param {number[]} base
 * @param {{ threshold?: number }} [options] - the smallest relative change that counts (default 0.1).
 */
export function verdict(head, base, { threshold = 0.1 } = {}) {
  const [h, b] = [median(head), median(base)]
  if (h === null || b === null) return { verdict: 'unmeasured', head: h, base: b }
  const delta = b === 0 ? (h === 0 ? 0 : Infinity) : (h - b) / b
  const noise = Math.max(mad(head) ?? 0, mad(base) ?? 0)
  const p = mannWhitneyP(head, base)
  const changed = Math.abs(h - b) > 2 * noise && Math.abs(delta) >= threshold
  const result = !changed ? 'same'
    : p !== null && p < 0.05 ? (h > b ? 'regressed' : 'improved')
      : Math.min(head.length, base.length) < CONCLUSIVE_SAMPLES ? 'inconclusive' : 'same'
  return { verdict: result, head: h, base: b, delta: Number.isFinite(delta) ? Number((delta * 100).toFixed(1)) : null, p: p === null ? null : Number(p.toFixed(4)) }
}
