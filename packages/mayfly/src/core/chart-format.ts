/**
 * Number text of chart axes, shared by the line and column painters.
 *
 * @module @ephemeral-ai/mayfly/core/chart-format
 */

/** Format a chart value without corrupting scientific exponents. */
export function formatChartNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(4)))
}

/** `420.8M`, `12k`, `7`: decimal thousands with one decimal below ten of a unit. */
export function compactChartNumber(value: number): string {
  const size = Math.abs(value)
  for (const [limit, suffix] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'k']] as const) {
    if (size >= limit) return `${String(Number((value / limit).toFixed(size / limit < 10 ? 2 : 1)))}${suffix}`
  }
  return formatChartNumber(value)
}
