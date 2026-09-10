/**
 * Canonical trace grouping over the official session event snapshot. This is
 * the read-only equivalent of transcript/fold's per-turn/step streaming
 * slots: reasoning and text deltas become one display item per stream.
 *
 * @module @ephemeral-ai/mayfly/interaction/trace-aggregate
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionEventRecord } from '@deepseek-ai/dsh-session-query'
import { attemptStreamText, traceSummary, traceTitle, type TraceItem } from './trace-format.ts'

/** Build timeline items, merging embedded attempt streams by turn, step, and stream type. */
export function aggregateTraceItems(records: readonly SessionEventRecord[], events: readonly SessionEvent[]): TraceItem[] {
  const items: TraceItem[] = []
  const streams = new Map<string, TraceItem>()
  const finalized = new Set<string>()
  for (const [index, record] of records.entries()) {
    const event = events[index]
    if (event?.type === 'assistant/attempt') {
      const stepId = `${String(event.data.turn)}:${String(event.data.step)}`
      if (finalized.has(stepId)) continue
      const parts = attemptStreamText(event.data.stream)
      for (const kind of ['reasoning', 'text'] as const) {
        const text = kind === 'reasoning' ? parts.reasoning : parts.text
        if (text === '') continue
        const key = `${stepId}:${kind}`
        const existing = streams.get(key)
        if (existing !== undefined) {
          const next = { ...existing, lastSeq: record.seq, eventSeqs: [...existing.eventSeqs, record.seq], summary: `${existing.summary}${text}` }
          items[items.indexOf(existing)] = next
          streams.set(key, next)
        } else {
          const item = { ...recordItem(record, event), title: kind === 'text' ? 'Assistant draft' : 'Thinking', summary: text }
          items.push(item)
          streams.set(key, item)
        }
      }
      continue
    }
    if (event?.type === 'assistant/message') {
      finalized.add(`${String(event.data.turn)}:${String(event.data.step)}`)
    }
    items.push(recordItem(record, event))
  }
  return items
}

function recordItem(record: SessionEventRecord, event: SessionEvent | undefined): TraceItem {
  const summary = event === undefined ? '' : traceSummary(event)
  return {
    seq: record.seq,
    lastSeq: record.seq,
    eventSeqs: [record.seq],
    time: record.time,
    type: record.type,
    surface: record.surface,
    title: traceTitle(record.type),
    summary,
  }
}

