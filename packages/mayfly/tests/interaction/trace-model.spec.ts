/** Reference nodes captured from immutable f148 trace-command.ts, plus width and clipboard semantics. @module */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { TraceItem } from '../../src/interaction/trace-model.ts'
import { tracePanelModel, traceDetailBody, traceTime, formatTraceAll, formatTraceItem } from '../../src/interaction/trace-model.ts'

// Produced by evaluating only tracePanelModel and traceTime from git show f148e704,
// against the same renderer-neutral UI builders. The fixture is never regenerated
// from the candidate implementation, so a changed title, column, page or action fails.
const reference = JSON.parse(readFileSync(new URL('./fixtures/trace-rc2.json', import.meta.url), 'utf8')) as {
  reference: string
  sessionId: string
  items: TraceItem[]
  document: string
  models: Record<'list' | 'wideDetail' | 'narrowDetail' | 'empty', unknown>
}

describe('shared reference trace model', () => {
  it('matches the immutable reference whole node graphs for list, detail and narrow-page states', () => {
    expect(reference.reference).toBe('f148e7045cc22a66e62c0cd5203f8eeca1368081')
    const t = (key: string) => key
    expect(tracePanelModel(reference.sessionId, reference.items, t)).toEqual(reference.models.list)
    expect(tracePanelModel(reference.sessionId, reference.items, t, { selected: reference.items[1], document: reference.document })).toEqual(reference.models.wideDetail)
    expect(tracePanelModel(reference.sessionId, reference.items, t, { selected: reference.items[1], document: reference.document, narrow: 'detail', escapeLabel: 'back' })).toEqual(reference.models.narrowDetail)
    expect(tracePanelModel(reference.sessionId, [], t)).toEqual(reference.models.empty)
    expect(tracePanelModel(reference.sessionId, reference.items, undefined, { selected: reference.items[0] })).toBeDefined()
    expect(traceDetailBody(reference.items[0]!, 'native document')).toBeDefined()
  })

  it('preserves the complete native relationship and raw-event clipboard documents', () => {
    const item = reference.items[0]!
    expect(traceTime(1_000)).toBe('00:00:01'); expect(traceTime(Number.NaN)).toBe('??:??:??')
    const relation = { replacedBy: 4, replacementChain: [4, 5], replacedEventSeqs: [1], sourceEventSeqs: [2], derivedEventSeqs: [6] }
    const raw = [{ seq: 0, time: 1_000, type: 'user/message', data: { content: [{ type: 'text', text: 'Native request' }] } }]
    expect(formatTraceItem(item, undefined, relation, raw)).toBe('[00:00:01] #0 User request (user/message)\nsurface: current\n\nRead the native trace\n\nreplaced by: #4\nreplacement chain: #4 -> #5\nreplaces: #1\nsources: #2\nderived: #6\n\nraw events:\n' + JSON.stringify(raw, null, 2))
    expect(formatTraceItem(item, { target: raw[0] }, { replacementChain: [], replacedEventSeqs: [], sourceEventSeqs: [], derivedEventSeqs: [] })).toContain('\n\nraw event:\n')
    expect(formatTraceItem({ ...item, summary: '' }, undefined, undefined)).toBe('[00:00:01] #0 User request (user/message)\nsurface: current')
    expect(formatTraceAll([reference.items[1]!, { ...item, summary: '' }], reference.sessionId)).toContain('## [00:00:02] #1-2 Assistant draft')
    expect(formatTraceAll([], reference.sessionId)).toBe('# Trace\n\nSession: reference-session\n')
    expect(formatTraceItem(reference.items[1]!, undefined, undefined, raw)).toContain('#1-2')
  })
})
