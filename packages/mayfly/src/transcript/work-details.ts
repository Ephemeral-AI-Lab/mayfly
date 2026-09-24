/** Terminal work-detail disclosure using Harness's four presentation modes.
 * @module @ephemeral-ai/mayfly/transcript/work-details
 */
import type { TranscriptModel, TranscriptEntryModel } from '../frontend/models.ts'
import type { TranscriptViewMode } from './presentation-policy.ts'

/** Keep final responses outside process folding; an intervening input prevents whole-turn folding. */
export function workDetailEntries(entries: TranscriptModel['entries'], streaming: boolean, mode: TranscriptViewMode, expanded: boolean): TranscriptModel['entries'] {
  if (mode === 'verbose' || expanded) return entries
  const turns = new Map<number, TranscriptEntryModel[]>()
  for (const entry of entries) {
    if (!entry.kind.startsWith('transcript-')) continue
    const item = entry as TranscriptEntryModel
    const group = turns.get(item.turn) ?? []
    group.push(item)
    turns.set(item.turn, group)
  }
  const latest = Math.max(-1, ...turns.keys())
  const hidden = new Set<string>()
  const summaries = new Map<string, string>()
  for (const [turn, group] of turns) {
    const running = streaming && turn === latest
    if (running && mode === 'detailed') continue
    const final = group.findLast(item => item.kind === 'transcript-assistant' && !item.streaming)
    if (!running && (final === undefined || group.some(item => item.kind === 'transcript-interrupted' || item.kind === 'transcript-error'))) continue
    const process = group.filter(item => item.kind !== 'transcript-user' && item.kind !== 'transcript-error' && item.kind !== 'transcript-interrupted' && item !== final && (!running || item.kind !== 'transcript-assistant'))
    if (process.length === 0) continue
    const first = group.indexOf(process[0]!)
    const intervening = group.slice(first).some(item => item.kind === 'transcript-user')
    if (intervening) continue
    for (const item of process) hidden.add(item.id)
    const last = process.at(-1)!
    const detail = mode === 'standard' && last.kind === 'transcript-tool' ? ` · ${last.preparing === undefined ? last.name : `Preparing ${last.name}`}` : ''
    summaries.set(process[0]!.id, `${running ? 'Working' : 'Work completed'}${detail} · Ctrl+O to expand`)
  }
  return entries.flatMap(entry => {
    if (!entry.kind.startsWith('transcript-')) return [entry]
    const id = (entry as TranscriptEntryModel).id
    const summary = summaries.get(id)
    if (summary !== undefined) return [{ kind: 'text' as const, content: summary, tone: 'muted' as const }]
    return hidden.has(id) ? [] : [entry]
  })
}
