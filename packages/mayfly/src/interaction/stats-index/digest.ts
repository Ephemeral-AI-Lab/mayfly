/**
 * One stored session folded into the few figures `/stats` History and Models need: the turns and the tokens of each
 * local day, per model and split by DeepSeek's peak hours. Pure: the index reads the log and keeps only this.
 *
 * @module @ephemeral-ai/mayfly/interaction/stats-index/digest
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenBuckets } from '../usage.ts'
import { isPeakRequest } from '../pricing.ts'

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

const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

/**
 * Fold a session's events. A session with no turn and no usage has no digest.
 * @param id - the session id.
 * @param cwd - its working directory, when the header has one.
 * @param events - its events in order.
 * @returns the digest, or undefined for an empty session.
 */
export function foldDigest(id: string, cwd: string | undefined, events: Iterable<SessionEvent>): SessionDigest | undefined {
  const days = new Map<string, DayDigest>()
  let firstAt = Number.POSITIVE_INFINITY
  let lastAt = Number.NEGATIVE_INFINITY
  const day = (time: number): DayDigest => {
    const key = dayKey(time)
    let entry = days.get(key)
    if (entry === undefined) { entry = { turns: 0, models: new Map() }; days.set(key, entry) }
    return entry
  }
  for (const event of events) {
    if (event.type === 'turn/start') {
      day(event.time).turns += 1
    } else if (event.type === 'assistant/message') {
      const usage = event.data.usage
      if (usage === undefined) continue
      const source = event.data.message.source
      const peak = isPeakRequest(source.provider, event.time)
      const entry = day(event.time)
      const key = `${source.provider}\u0000${source.model}`
      let model = entry.models.get(key)
      if (model === undefined) { model = { provider: source.provider, model: source.model, peak: emptyBuckets(), offPeak: emptyBuckets() }; entry.models.set(key, model) }
      addBuckets(peak ? model.peak : model.offPeak, { input: count(usage.inputTokens), cacheRead: count(usage.cacheReadTokens), cacheWrite: count(usage.cacheWriteTokens), output: count(usage.outputTokens) })
    } else continue
    firstAt = Math.min(firstAt, event.time)
    lastAt = Math.max(lastAt, event.time)
  }
  if (days.size === 0) return undefined
  return { id, cwd, firstAt, lastAt, days }
}
