/**
 * Decision tests of the activity row: the three rows every phase draws (a blank row, the header, the line under it),
 * the glyph and label of each phase and where the motion sits, the thinking label's tone and weight, the line under
 * the header (the calls in flight, else the tip, the `⎿` from 40 columns), the tail that sheds first and the label that
 * never does, and every row fitting the width it is drawn at.
 * @module components-activity-row
 */

import { describe, expect, it } from 'vitest'
import type { MayflySemanticColors } from '../../src/core/types.ts'
import { compileMayflyUiNode } from '../../src/core/ui-compiler.ts'
import { ActivityRow, DETAIL_CONNECTOR_MIN_WIDTH, type ActivityFacts, type ActivityPhase } from '../../src/components/activity-row.ts'
import { ADVERSARIAL, expectLinesFit } from '../core/width-scan.ts'
import { fakeMayflyComponents } from '../transcript/helpers.ts'
import { COLORS } from '../transcript/status-fakes.ts'

const ANSI = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|.)/gu

/** The row as a painted screen draws it: its rows at a width, escape sequences removed. */
function render(node: ReturnType<typeof ActivityRow>, width: number): string[] {
  const compiled = compileMayflyUiNode(node, {
    components: fakeMayflyComponents(),
    colors: COLORS as MayflySemanticColors,
    getViewport: () => ({ columns: width, rows: 40 }),
    screenMode: 'main',
    emit: () => {},
  })
  return (compiled.ok ? compiled.value.component : compiled.errorComponent).render(width).map(line => line.replace(ANSI, ''))
}

/** The header without its two-column margin and its glyph (the glyph is a motion frame, so a spec does not pin it). */
const bodyOf = (line: string): string => line.replace(/^ {2}\S? ?/u, '')

/** The spans of every rich-text node in a node tree, in order. */
function spansOf(node: unknown): { readonly text: string, readonly tone?: string, readonly styles?: readonly string[], readonly motion?: string }[] {
  if (node === null || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(spansOf)
  const record = node as Record<string, unknown>
  const own = record.kind === 'rich-text' ? record.spans as never[] : []
  return [...own, ...Object.values(record).flatMap(value => spansOf(value))]
}

const PHASES: readonly ActivityPhase[] = ['diving', 'thinking', 'writing', 'tool', 'waiting', 'stopping']
const LABELS: Record<ActivityPhase, string> = {
  diving: 'Deep diving', thinking: 'Pondering', writing: 'Writing', tool: 'Running commands', waiting: 'Waiting for your approval', stopping: 'interrupting…',
}
const facts = (phase: ActivityPhase, more: Partial<ActivityFacts> = {}): ActivityFacts => ({ phase, label: LABELS[phase], ...more })

describe('ActivityRow', () => {
  it('draws three rows in every phase, with or without a line under the header', () => {
    for (const phase of PHASES) {
      for (const more of [{}, { tip: 'Tip: read the docs' }, { info: 'npm test' }, { tail: ['8s'], tip: 'Tip: x' }]) {
        const lines = render(ActivityRow(facts(phase, more)), 120)
        expect(lines, `${phase} ${JSON.stringify(more)}`).toHaveLength(3)
        expect(lines[0]).toBe('')
      }
    }
  })

  it('leaves the line under the header blank when there is neither a call nor a tip', () => {
    const lines = render(ActivityRow(facts('diving')), 120)
    expect(bodyOf(lines[1]!)).toBe('Deep diving')
    expect(lines[2]).toBe('')
  })

  it('draws a running tool as a still dot over its label and the calls in flight under it', () => {
    expect(render(ActivityRow(facts('tool', { tail: ['8s'], info: 'npm test · ls -la', tip: 'Tip: ignored' })), 120)).toEqual([
      '',
      '  ● Running commands · 8s',
      '    ⎿ npm test · ls -la',
    ])
  })

  it('gives the calls in flight the line over a tip, and the tip the line when no call runs', () => {
    expect(render(ActivityRow(facts('tool', { info: 'npm test', tip: 'Tip: hidden by the call' })), 120)[2]).toBe('    ⎿ npm test')
    expect(render(ActivityRow(facts('thinking', { tip: 'Tip: read the docs' })), 120)[2]).toBe('    ⎿ Tip: read the docs')
  })

  it('draws a stop as a static red square over the interrupt label, and never a motion glyph', () => {
    expect(render(ActivityRow(facts('stopping')), 120)).toEqual(['', '  ■ interrupting…', ''])
    expect(render(ActivityRow(facts('stopping')), 40)).toEqual(['', '  ■ interrupting…', ''])
  })

  it('shows the thinking tail as the elapsed time, the counters, and the rate, and drops the tail first when narrow', () => {
    const thinking = facts('thinking', { tail: ['8s', '↑30.2k ↓1.1k', '38 tok/s'], tip: 'Tip: x' })
    expect(bodyOf(render(ActivityRow(thinking), 120)[1]!)).toBe('Pondering · 8s · ↑30.2k ↓1.1k · 38 tok/s')
    // At 40 columns the tail is gone and the label stays whole.
    expect(bodyOf(render(ActivityRow(thinking), 40)[1]!)).toBe('Pondering')
  })

  it('keeps the label at the narrowest width and drops the connector below the detail width', () => {
    const waiting = facts('waiting', { tail: ['2m 4s'], tip: 'Tip: wait' })
    const narrow = render(ActivityRow(waiting), 28)
    // The tail goes; the label is cut only at the row's end.
    expect(bodyOf(narrow[1]!)).toBe('Waiting for your appro…')
    expect(narrow[2]).not.toContain('⎿')
    // The connector is drawn from the detail width on, and not one column below it.
    expect(render(ActivityRow(facts('thinking', { tip: 'Tip: x' })), DETAIL_CONNECTOR_MIN_WIDTH)[2]).toBe('    ⎿ Tip: x')
    expect(render(ActivityRow(facts('thinking', { tip: 'Tip: x' })), DETAIL_CONNECTOR_MIN_WIDTH - 1)[2]).toBe('    Tip: x')
  })

  it('keeps the tail beside the label while the row is wide enough for both', () => {
    expect(bodyOf(render(ActivityRow(facts('writing', { tail: ['12s'] })), 60)[1]!)).toBe('Writing · 12s')
  })

  it('marks the thinking label with the tone and weight of its stage', () => {
    const plain = spansOf(ActivityRow(facts('thinking', { labelTone: 'primary' })))
    expect(plain.find(span => span.text === ` ${LABELS.thinking}`)).toMatchObject({ tone: 'primary' })
    expect(plain.find(span => span.text === ` ${LABELS.thinking}`)?.styles).toBeUndefined()
    const deep = spansOf(ActivityRow(facts('thinking', { labelTone: 'accent', labelStrong: true })))
    expect(deep.find(span => span.text === ` ${LABELS.thinking}`)).toMatchObject({ tone: 'accent', styles: ['strong'] })
  })

  it('moves the glyph of a model phase and the label of a running tool, never both', () => {
    const motionOf = (phase: ActivityPhase) => spansOf(ActivityRow(facts(phase))).filter(span => span.motion !== undefined).map(span => span.motion)
    expect(motionOf('diving')).toEqual(['loader'])
    expect(motionOf('thinking')).toEqual(['loader'])
    expect(motionOf('writing')).toEqual(['loader'])
    expect(motionOf('waiting')).toEqual(['loader'])
    // The tool row keeps a still dot and shimmers its label; the stop is static.
    expect(spansOf(ActivityRow(facts('tool'))).find(span => span.motion === 'shimmer')?.text).toBe(LABELS.tool)
    expect(motionOf('stopping')).toEqual([])
  })

  it('fits every phase, with the adversarial texts in the line under the header, at each width', () => {
    for (const phase of PHASES) {
      for (const { name, text } of ADVERSARIAL) {
        for (const width of [120, 60, 40, 28, 20, 10]) {
          const node = ActivityRow(facts(phase, { tail: [text, '8s'], info: text, tip: text }))
          expectLinesFit(`ActivityRow ${phase}/${name}`, render(node, width), width)
        }
      }
    }
  })
})
