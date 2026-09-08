/**
 * Pure token formatting and readonly usage fact types. Native projections
 * are read by their consumer; geometry and progress rendering belong to core.
 *
 * @module @ephemeral-ai/mayfly/interaction/usage
 */

/** The four disjoint provider-usage buckets both panels list. */
export interface TokenBuckets {
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
}

/**
 * The context-occupancy pair the panels render: the numerator is the
 * projection's next-request estimate when the provider has reported usage
 * (`projectedTokens`, else `pressureTokens`), the denominator the newest
 * advertised window. Both absent until a request reports or advertises.
 */
export interface ContextFacts {
  readonly used?: number
  readonly window?: number
}

/** Usage facts for the context and status views. */
export interface UsageFacts {
  /** Cumulative provider usage over the whole durable log. */
  readonly buckets: TokenBuckets
  /** Context occupancy; fields absent until known. */
  readonly context: ContextFacts
}

/** The heuristic composition of the next request. */
export interface CompositionFacts {
  readonly system: number
  readonly tools: number
  readonly messages: number
}

/**
 * One decimal, trailing `.0` trimmed: 1 → `1`, 1.5 → `1.5`.
 * @param value - the value to format.
 * @returns the trimmed one-decimal representation.
 */
function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '')
}

/**
 * Compact 1024-base token formatting (the kimi `/usage` port; the footer's
 * `status-context` twin): the plain integer below 1024, `x.yk` at or above
 * it (rounded at 100k), `x.yM` at or above 1 MiB. Context windows are
 * powers of two, so the binary base keeps abbreviations exact — 262144
 * renders as `256k`. Non-finite or negative input formats as `0`.
 * @param tokens - the token count.
 * @returns the formatted count.
 */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return '0'
  if (tokens >= 1024 * 1024) return `${trimDecimal(tokens / (1024 * 1024))}M`
  if (tokens >= 1024) {
    const k = tokens / 1024
    return `${k >= 100 ? String(Math.round(k)) : trimDecimal(k)}k`
  }
  return String(tokens)
}

/**
 * The usage share of a context window, in whole percents: rounded up so
 * partial use never reads as empty, clamped to [0, 100], a non-zero share
 * always at least 1. A non-finite or non-positive window reports 0.
 * @param used - the occupied tokens.
 * @param max - the context window.
 * @returns the share in percent.
 */
export function usagePercent(used: number, max: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(max) || used <= 0 || max <= 0) return 0
  return Math.min(100, Math.max(1, Math.ceil((used / max) * 100)))
}

/**
 * A usage ratio clamped to [0, 1] (NaN-safe) for bar rendering.
 * @param used - the occupied tokens.
 * @param max - the context window.
 * @returns the clamped ratio.
 */
export function usageRatio(used: number, max: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(max) || used <= 0 || max <= 0) return 0
  return Math.max(0, Math.min(1, used / max))
}

/**
 * Map a usage ratio to the severity color the bar paints (the kimi
 * thresholds): `danger` from 85%, `warn` from 50%, `ok` below.
 * @param ratio - the clamped usage ratio.
 * @returns the severity name.
 */
export function ratioSeverity(ratio: number): 'ok' | 'warn' | 'danger' {
  if (ratio >= 0.85) return 'danger'
  if (ratio >= 0.5) return 'warn'
  return 'ok'
}

/**
 * Sum the four buckets (the projection's disjoint-buckets total).
 * @param buckets - the buckets to sum.
 * @returns input + cacheRead + cacheWrite + output.
 */
export function totalTokens(buckets: TokenBuckets): number {
  return buckets.input + buckets.cacheRead + buckets.cacheWrite + buckets.output
}
