/** Host-native rc.2 turn/usage digest, without a renderer dependency. @module */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { MayflyStatsBuckets, MayflyStatsDigest, MayflyStatsModelDay } from './stats-contract.ts'
import { frozen } from './json.ts'

type Buckets = { -readonly [K in keyof MayflyStatsBuckets]: number }
const empty = (): Buckets => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

function peak(provider: string, at: number): boolean {
  if (provider !== 'deepseek' && provider !== 'deepseek-official') return false
  const beijing = new Date(at + 8 * 3_600_000)
  const day = beijing.getUTCDay()
  const hour = beijing.getUTCHours()
  return day >= 1 && day <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))
}

/** Fold native Session events once on Host into complete local-day statistics. */
export function statsDigest(id: string, cwd: string | undefined, events: Iterable<SessionEvent>): MayflyStatsDigest | undefined {
  const days = new Map<string, { turns: number, models: Map<string, MayflyStatsModelDay> }>()
  let firstAt = Infinity
  let lastAt = -Infinity
  const dayOf = (time: number) => {
    const date = new Date(time)
    const key = `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    let day = days.get(key)
    if (day === undefined) { day = { turns: 0, models: new Map() }; days.set(key, day) }
    return day
  }
  for (const event of events) {
    if (event.type === 'turn/start') dayOf(event.time).turns += 1
    else if (event.type === 'assistant/message') {
      const usage = event.data.usage
      if (usage === undefined) continue
      const { provider, model } = event.data.message.source
      const day = dayOf(event.time)
      const key = `${provider}\0${model}`
      let entry = day.models.get(key)
      if (entry === undefined) { entry = { provider, model, peak: empty(), offPeak: empty() }; day.models.set(key, entry) }
      const bucket = (peak(provider, event.time) ? entry.peak : entry.offPeak) as Buckets
      bucket.input += count(usage.inputTokens)
      bucket.output += count(usage.outputTokens)
      bucket.cacheRead += count(usage.cacheReadTokens)
      bucket.cacheWrite += count(usage.cacheWriteTokens)
    } else continue
    firstAt = Math.min(firstAt, event.time)
    lastAt = Math.max(lastAt, event.time)
  }
  if (days.size === 0) return undefined
  return frozen({ id, cwd, firstAt, lastAt, days: [...days].map(([key, day]) => ({ key, turns: day.turns, models: [...day.models.values()] })) })
}
