import type { TokenBuckets } from '../usage.ts'

/** Token buckets that are still being added to. */
export type MutableBuckets = { -readonly [Key in keyof TokenBuckets]: TokenBuckets[Key] }

/** The tokens one model used in one day, in the two price tiers. */
export interface ModelDay {
  readonly provider: string
  readonly model: string
  readonly peak: MutableBuckets
  readonly offPeak: MutableBuckets
}

/** One local day of one session. */
export interface DayDigest {
  turns: number
  readonly models: Map<string, ModelDay>
}

/** What the index keeps of a session. */
export interface SessionDigest {
  readonly id: string
  readonly cwd: string | undefined
  readonly firstAt: number
  readonly lastAt: number
  /** Keyed by local `yyyy-mm-dd`. */
  readonly days: ReadonlyMap<string, DayDigest>
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** The local calendar day of a time, `yyyy-mm-dd`. */
export function dayKey(time: number): string {
  const date = new Date(time)
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export const emptyBuckets = (): MutableBuckets => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })

/** Add `usage` into a mutable bucket. */
export function addBuckets(into: MutableBuckets, usage: TokenBuckets): void {
  into.input += usage.input
  into.cacheRead += usage.cacheRead
  into.cacheWrite += usage.cacheWrite
  into.output += usage.output
}

