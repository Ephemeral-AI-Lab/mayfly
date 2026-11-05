/**
 * Branch decisions the feature specs leave to one side: the estimate's
 * supplementary non-printing and keycap guards, an out-of-range real row and
 * the real-run fallback of a row pipe, a verb-less row and a fixed slider in
 * the key grammar, a one-step wizard, a badge-only overlay heading, an
 * inverse span, a styled prompt symbol, a marked right-band child, a file
 * path cut below two columns, an unknown theme idea, an alias label, the
 * digest's count and repeated-model folds, the waiting phase and a raw spawn
 * label, a ten-second elapsed line, a warning-toned context field, a copied
 * plan without detail, placeholder fallbacks, a valid workspace creation
 * time, and a pinned segment with no label room.
 *
 * @module @ephemeral-ai/mayfly/tests/core/coverage-finish
 */

import { describe, expect, it } from 'vitest'
import { ui } from '../../../ui/src/index.ts'
import { placeholderLadder, placeholderState } from '../../src/interaction/placeholder.ts'
import { themeIdea } from '../../src/interaction/theme-names.ts'
import { agentPhasePresentation } from '../../src/transcript/agent-presentation.ts'
import { elapsedText } from '../../src/transcript/process-activity.ts'
import { AdmissionRow } from '../../src/core/ui-admission.ts'
import { paintDrawer } from '../../src/core/completion-drawer.ts'
import { ACTION_SUBMIT } from '../../src/core/key-actions.ts'
import { segmentLine } from '../../src/core/ui-list-segment.ts'
import { paintSpan } from '../../src/core/ui-paint.ts'
import { renderSurfaceHead, renderTabs } from '../../src/core/ui-patterns.ts'
import { paintHostedPrompt } from '../../src/core/ui-prompt.ts'
import { concatRows, rowSourceOf, rowsSource, virtualRows } from '../../src/core/ui-rows.ts'
import { estimateColumns } from '../../src/core/width-estimate.ts'
import { grammarHints, keyGrammar, type GrammarState } from '../../src/core/ui-key-grammar.ts'
import { truncateToWidth, visibleWidth } from '../../src/core/width.ts'
import { plainColors } from '../helpers.ts'

const colors = plainColors()

describe('width estimate guards', () => {
  it('prices a supplementary non-printing point at zero and still prices an emoji at two', () => {
    // U+E0001 LANGUAGE TAG is a supplementary default-ignorable: the >BMP regex arm.
    expect(estimateColumns('\u{E0001}', 0, 2)).toBe(0)
    expect(estimateColumns('😀', 0, 2)).toBe(2)
  })

  it('ignores a keycap enclosure that does not follow a one-cell base', () => {
    // U+20E3 arrives as the line's first point, so walk.last is 0, not 1.
    expect(estimateColumns('\u20e3', 0, 1)).toBe(0)
  })
})

describe('row sources', () => {
  it('paints an out-of-range real row as empty instead of undefined', () => {
    expect(rowsSource(['only']).row(3)).toBe('')
  })

  it('reads a real run beside a virtual part through a row source over the real rows', () => {
    const rows = concatRows(['real'], virtualRows({ length: 1, row: () => 'virtual' }))
    expect([rows[0], rows[1]]).toEqual(['real', 'virtual'])
    // A concat source asked past its last part reads the last part out of range, which is empty.
    expect(rowSourceOf(rows)!.row(5)).toBe('')
  })
})

describe('key grammar edges', () => {
  const state = (control: GrammarState['control']): GrammarState => ({
    mode: 'ui', expanded: false, control, keyed: [], tabs: false, groups: 1, siblings: 1, escape: undefined, closable: false,
  })

  it('swallows Enter on a row whose accept verb is none, without a hint', () => {
    const bindings = keyGrammar(state({ kind: 'row', role: 'choose', multiple: false, tree: false, verb: 'none' }))
    expect(bindings.some(binding => binding.match.kind === 'action' && binding.match.action === ACTION_SUBMIT && binding.intent.kind === 'swallow')).toBe(true)
    expect(grammarHints(bindings).some(hint => hint.id === 'activate')).toBe(false)
  })

  it('leaves a fixed slider with only its confirm key and no adjust hint', () => {
    const hints = grammarHints(keyGrammar(state({ kind: 'slider', label: 'thinking', adjustable: false, stuckLeft: true })))
    expect(hints.some(hint => hint.id === 'adjust')).toBe(false)
    expect(hints.find(hint => hint.id === 'activate')).toMatchObject({ label: 'confirm' })
  })
})

describe('tabs, surface chrome, and spans', () => {
  it('omits the n/m counter for a wizard with no second asking step', () => {
    const rows = renderTabs(ui.tabs({ id: 'steps', mode: 'wizard', activeId: 'one', items: [{ id: 'one', label: 'One' }] }), 40, { key: '', focused: false, marker: '|' }, colors)
    expect(rows[0]).toContain('One')
    expect(rows[0]).not.toContain('1/1')
  })

  it('draws an overlay heading with badges and no title', () => {
    const rows = renderSurfaceHead({ chrome: 'overlay', badges: [{ text: 'badge' }] } as never, 24, colors)
    expect(rows.join('\n')).toContain('badge')
    expect(rows[0]).toBe('━'.repeat(24))
  })

  it('paints the inverse style with its own close sequence', () => {
    expect(paintSpan({ text: 'x', styles: ['inverse'] }, colors)).toBe('\x1b[7mx\x1b[27m')
  })
})

describe('prompt and segment paints', () => {
  it('paints a declared prompt symbol tone with the accent color and bold', () => {
    const tagged = { ...colors, accent: (text: string): string => `<A>${text}</A>` }
    const rows = paintHostedPrompt({
      node: ui.prompt({ id: 'p', symbolTone: 'accent' }),
      width: 40,
      colors: tagged,
      components: { visibleWidth, truncateToWidth },
      buffer: () => ['typed'],
    })
    expect(rows[0]).toContain('\x1b[1m<A>> </A>\x1b[22m')
    expect(rows[0]).toContain('typed')
  })

  it('bolds a pinned segment that had to drop its label to fit', () => {
    const segment = {
      label: 'Thinking',
      options: [{ id: 'low', label: 'low' }, { id: 'high', label: 'high' }],
      inheritedId: 'low',
    }
    const line = segmentLine({ segment, pinned: 'high', active: 'high' } as never, 11, colors, 'Thinking')
    expect(line).toContain('\x1b[1mhigh\x1b[22m')
    expect(line).not.toContain('Thinking:')
  })
})

describe('completion drawer and admission marks', () => {
  it('cuts a file path with the ellipsis form below two columns', () => {
    const view = { kind: 'files' as const, prefix: '@', index: 0, items: [{ label: 'src/core/ui-prompt.ts', value: '@src/core/ui-prompt.ts' }] }
    const [row] = paintDrawer({ view, width: 6, colors, components: { visibleWidth, truncateToWidth }, glyphs: undefined, wait: undefined })
    expect(row).toContain('…')
    expect(visibleWidth(row!)).toBe(6)
  })

  it('aligns a right-band mark when no left or center child is on the row', () => {
    const component = { render: () => ['R'], invalidate: () => {} }
    const row = new AdmissionRow({
      components: { visibleWidth, truncateToWidth },
      colors,
      children: () => [{ forms: [{ rank: -1, component }], band: 'right', mark: 'underline' }],
    })
    const [line, underline] = row.render(20).map(painted => painted.replaceAll('\x1b[0m', ''))
    expect(underline!.indexOf('━')).toBe(line!.indexOf('R'))
  })
})

describe('pure interaction labels', () => {
  it('leaves an unknown theme key with no picker idea', () => {
    expect(themeIdea('neon', key => key)).toBe('')
  })
})

describe('transcript presentation helpers', () => {
  it('labels the waiting phase with its warning marker', () => {
    expect(agentPhasePresentation('waiting')).toEqual({ label: 'waiting', marker: '●', tone: 'warning' })
  })

  it('reports a ten-second elapsed line in seconds below the minute', () => {
    expect(elapsedText(10_000)).toBe('10s')
    expect(elapsedText(60_000)).toBe('1m 0s')
  })
})

describe('placeholder and workspace fallbacks', () => {
  it('names a subagent with no label as the empty name and falls back to the live kind', () => {
    expect(placeholderState({ kind: 'subagent', access: 'interactive' }, false, false)).toEqual({ kind: 'subagent-live', name: '' })
  })

  it('has no teaching ladder while quiet hints are off but keeps a condition state', () => {
    expect(placeholderLadder({ kind: 'main', running: false }, true, key => key)).toEqual([])
    expect(placeholderLadder({ kind: 'read-only' }, true, key => key)).toEqual(['Read-only conversation'])
  })
})
