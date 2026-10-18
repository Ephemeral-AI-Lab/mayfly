import { describe, expect, it } from 'vitest'
import { equalPaneSummary, equalStatusNode } from '../src/status-equality.ts'
import type {
  MayflyField,
  MayflyInlineSpan,
  MayflyPaneSummary,
  MayflyProgressNode,
  MayflyShedNode,
  MayflyStatusChild,
  MayflyStatusNode,
  MayflyTextNode,
} from '../src/contracts.ts'

const span = (overrides: Record<string, unknown> = {}): MayflyInlineSpan => ({ text: 'a', tone: 'muted', styles: ['strong'], motion: 'shimmer', variant: 'gap', ...overrides })
const text = (overrides: Record<string, unknown> = {}): MayflyTextNode => ({ kind: 'text', content: 'hello', tone: 'default', overflow: 'wrap', styles: ['strong'], ...overrides })
const field = (overrides: Record<string, unknown> = {}): MayflyField => ({ label: 'L', value: [span()], ...overrides })
const progress = (overrides: Record<string, unknown> = {}): MayflyProgressNode => ({
  kind: 'progress', label: 'p', value: 1, max: 2, style: 'cells', width: 10, tone: 'primary', showCount: true, showPercent: true,
  transition: { from: 0, ms: 100, rev: 1 }, ...overrides,
})
const child = (overrides: Record<string, unknown> = {}): MayflyStatusChild => ({
  node: text(), id: 'one', basis: 2, grow: 1, shrink: 0, minSize: 1, maxSize: 9,
  when: { minWidth: 10, maxWidth: 20, minHeight: 1, maxHeight: 30 }, priority: 1, band: 'left', mark: 'underline', overflow: 'hide', ...overrides,
} as MayflyStatusChild)
const stack = (children: readonly MayflyStatusChild[], overrides: Record<string, unknown> = {}): MayflyStatusNode => ({ kind: 'stack', direction: 'row', gap: 1, align: 'start', children, ...overrides }) as MayflyStatusNode
const shed = (overrides: Partial<MayflyShedNode> = {}): MayflyShedNode => ({ kind: 'shed', node: text(), narrower: [{ rank: 1, node: text({ content: 'small' }) }, { rank: 5, node: null }], ...overrides })

const equal = (left: MayflyStatusNode | null, right: MayflyStatusNode | null): boolean => equalStatusNode(left, right)

describe('equalStatusNode', () => {
  it('treats one reference, and two nulls, as equal without looking inside', () => {
    const node = text()
    expect(equal(node, node)).toBe(true)
    expect(equal(null, null)).toBe(true)
    expect(equal(node, null)).toBe(false)
    expect(equal(null, node)).toBe(false)
  })

  it('refuses different kinds before comparing their fields', () => {
    expect(equal(text(), { kind: 'fields', rows: [] })).toBe(false)
    expect(equal({ kind: 'rich-text', spans: [] }, text())).toBe(false)
    expect(equal(progress(), stack([]))).toBe(false)
    expect(equal(shed(), { kind: 'progress', value: 0, max: 1 })).toBe(false)
    expect(equal(stack([]), { kind: 'shed', node: text(), narrower: [] })).toBe(false)
    expect(equal({ kind: 'fields', rows: [] }, shed())).toBe(false)
  })

  it('compares text content, tone, overflow, and styles', () => {
    expect(equal(text(), text())).toBe(true)
    expect(equal(text({ tone: 'danger' }), text())).toBe(false)
    expect(equal(text({ overflow: 'truncate' }), text())).toBe(false)
    expect(equal(text({ styles: [] }), text())).toBe(false)
    expect(equal(text({ styles: ['strong', 'italic'] }), text({ styles: ['strong'] }))).toBe(false)
    // A chunked content field compares the chunks' texts, not their identities or other fields.
    const chunks = [{ text: 'he' }, { text: 'llo' }]
    expect(equal(text({ content: chunks }), text({ content: [{ text: 'he' }, { text: 'llo' }] }))).toBe(true)
    expect(equal(text({ content: chunks }), text({ content: chunks }))).toBe(true)
    expect(equal(text({ content: [{ text: 'he' }] }), text({ content: [{ text: 'hello' }] }))).toBe(false)
    expect(equal(text({ content: [{ text: 'he' }, { text: 'llo' }] }), text({ content: [{ text: 'he' }] }))).toBe(false)
    expect(equal(text({ content: 'hello' }), text({ content: [{ text: 'hello' }] }))).toBe(false)
    expect(equal(text({ content: [{ text: 'hello' }] }), text({ content: 'hello' }))).toBe(false)
    expect(equal(text({ content: 'hello' }), text({ content: 'hello again' }))).toBe(false)
    expect(equal(text({ content: [{} as never] }), text({ content: 'hello' }))).toBe(false)
  })

  it('compares the spans of rich text, their styles and animation, and its overflow', () => {
    const rich = (spans: readonly MayflyInlineSpan[], overflow?: 'wrap' | 'truncate'): MayflyStatusNode => ({ kind: 'rich-text', spans, ...(overflow === undefined ? {} : { overflow }) })
    expect(equal(rich([span()]), rich([span()]))).toBe(true)
    expect(equal(rich([span()]), rich([]))).toBe(false)
    expect(equal(rich([span()]), rich([span({ text: 'b' })]))).toBe(false)
    expect(equal(rich([span()]), rich([span({ tone: 'primary' })]))).toBe(false)
    expect(equal(rich([span()]), rich([span({ styles: ['italic'] })]))).toBe(false)
    expect(equal(rich([span()]), rich([span({ styles: undefined })]))).toBe(false)
    expect(equal(rich([span()]), rich([span({ motion: undefined })]))).toBe(false)
    expect(equal(rich([span()]), rich([span({ variant: 'pulse' })]))).toBe(false)
    // Spans without styles are equal to spans without styles.
    expect(equal(rich([{ text: 'a' }]), rich([{ text: 'a' }]))).toBe(true)
    expect(equal(rich([span()], 'wrap'), rich([span()]))).toBe(false)
    expect(equal(rich([span()], 'truncate'), rich([span()], 'truncate'))).toBe(true)
  })

  it('compares fields by label and by every span of every row', () => {
    const fields = (rows: readonly MayflyField[]): MayflyStatusNode => ({ kind: 'fields', rows })
    expect(equal(fields([field()]), fields([field()]))).toBe(true)
    expect(equal(fields([field({ label: 'R' })]), fields([field()]))).toBe(false)
    expect(equal(fields([field()]), fields([]))).toBe(false)
    expect(equal(fields([field({ value: [span({ text: 'b' })] })]), fields([field()]))).toBe(false)
    expect(equal(fields([]), fields([]))).toBe(true)
  })

  it('compares every progress figure and its optional transition', () => {
    expect(equal(progress(), progress())).toBe(true)
    expect(equal(progress({ label: 'q' }), progress())).toBe(false)
    expect(equal(progress({ value: 2 }), progress())).toBe(false)
    expect(equal(progress({ max: 3 }), progress())).toBe(false)
    expect(equal(progress({ style: 'rule' }), progress())).toBe(false)
    expect(equal(progress({ width: 20 }), progress())).toBe(false)
    expect(equal(progress({ tone: 'danger' }), progress())).toBe(false)
    expect(equal(progress({ showCount: false }), progress())).toBe(false)
    expect(equal(progress({ showPercent: undefined }), progress())).toBe(false)
    // Both without a transition, or with one that carries the same figures.
    expect(equal(progress({ transition: undefined }), progress({ transition: undefined }))).toBe(true)
    expect(equal(progress(), progress({ transition: { from: 0, ms: 100, rev: 1 } }))).toBe(true)
    expect(equal(progress({ transition: { from: 1, ms: 100, rev: 1 } }), progress())).toBe(false)
    expect(equal(progress({ transition: { from: 0, ms: 200, rev: 1 } }), progress())).toBe(false)
    expect(equal(progress({ transition: { from: 0, ms: 100, rev: 2 } }), progress())).toBe(false)
    expect(equal(progress({ transition: { from: 0, ms: 100, rev: 1 } }), progress({ transition: undefined }))).toBe(false)
  })

  it('compares a stack direction, gap, align, and every child detail', () => {
    expect(equal(stack([child()]), stack([child()]))).toBe(true)
    expect(equal(stack([child()], { direction: 'column' }), stack([child()]))).toBe(false)
    expect(equal(stack([child()], { gap: 2 }), stack([child()]))).toBe(false)
    expect(equal(stack([child()], { gap: undefined }), stack([child()], { gap: undefined }))).toBe(true)
    expect(equal(stack([child()], { align: 'center' }), stack([child()]))).toBe(false)
    expect(equal(stack([]), stack([]))).toBe(true)
    expect(equal(stack([child()]), stack([]))).toBe(false)
    expect(equal(stack([child()]), stack([child(), child()]))).toBe(false)

    expect(equal(stack([child()]), stack([child({ node: { kind: 'rich-text', spans: [] } })]))).toBe(false)
    expect(equal(stack([child()]), stack([child({ id: 'two' })]))).toBe(false)
    expect(equal(stack([child()]), stack([child({ basis: 'auto' })]))).toBe(false)
    expect(equal(stack([child()]), stack([child({ grow: 2 })]))).toBe(false)
    expect(equal(stack([child()]), stack([child({ shrink: 1 })]))).toBe(false)
    expect(equal(stack([child()]), stack([child({ minSize: 2 })]))).toBe(false)
    expect(equal(stack([child()]), stack([child({ maxSize: 10 })]))).toBe(false)
    expect(equal(stack([child()]), stack([child({ priority: 2 })]))).toBe(false)
    expect(equal(stack([child()]), stack([child({ band: 'right' })]))).toBe(false)
    expect(equal(stack([child()]), stack([child({ mark: undefined })]))).toBe(false)
    expect(equal(stack([child()]), stack([child({ overflow: 'truncate' })]))).toBe(false)
    // A condition is the same when every bound is the same; a fresh object is equal and each bound matters.
    expect(equal(stack([child({ when: { minWidth: 10, maxWidth: 20, minHeight: 1, maxHeight: 30 } })]), stack([child()]))).toBe(true)
    expect(equal(stack([child({ when: { minWidth: 11, maxWidth: 20, minHeight: 1, maxHeight: 30 } })]), stack([child()]))).toBe(false)
    expect(equal(stack([child({ when: { minWidth: 10, maxWidth: 21, minHeight: 1, maxHeight: 30 } })]), stack([child()]))).toBe(false)
    expect(equal(stack([child({ when: { minWidth: 10, maxWidth: 20, minHeight: 2, maxHeight: 30 } })]), stack([child()]))).toBe(false)
    expect(equal(stack([child({ when: { minWidth: 10, maxWidth: 20, minHeight: 1, maxHeight: 31 } })]), stack([child()]))).toBe(false)
    expect(equal(stack([child()]), stack([child({ when: undefined })]))).toBe(false)
    expect(equal(stack([child({ when: undefined })]), stack([child({ when: undefined })]))).toBe(true)
    const when = { minWidth: 10 }
    expect(equal(stack([child({ when })]), stack([child({ when })]))).toBe(true)
  })

  it('compares a shed chain by its full form and every narrower rank and form', () => {
    expect(equal(shed(), shed())).toBe(true)
    expect(equal(shed({ node: text({ content: 'other' }) }), shed())).toBe(false)
    expect(equal(shed({ narrower: [] }), shed())).toBe(false)
    expect(equal(shed({ narrower: [{ rank: 2, node: text({ content: 'small' }) }, { rank: 5, node: null }] }), shed())).toBe(false)
    expect(equal(shed({ narrower: [{ rank: 1, node: text({ content: 'tiny' }) }, { rank: 5, node: null }] }), shed())).toBe(false)
    expect(equal(shed({ narrower: [{ rank: 1, node: text({ content: 'small' }) }] }), shed())).toBe(false)
    expect(equal(shed({ narrower: [{ rank: 1, node: text({ content: 'small' }) }, { rank: 5, node: text() }] }), shed())).toBe(false)
    expect(equal(shed({ narrower: [{ rank: 1, node: text({ content: 'small' }) }, { rank: 5, node: null }] }), shed())).toBe(true)
  })
})

describe('equalPaneSummary', () => {
  const summary = (node: MayflyStatusNode): MayflyPaneSummary => ({ node })

  it('is true for one reference and for equal fresh nodes, and false around a missing side', () => {
    const one = summary(text())
    expect(equalPaneSummary(one, one)).toBe(true)
    expect(equalPaneSummary(one, summary(text()))).toBe(true)
    expect(equalPaneSummary(null, null)).toBe(true)
    expect(equalPaneSummary(null, summary(text()))).toBe(false)
    expect(equalPaneSummary(summary(text()), null)).toBe(false)
    expect(equalPaneSummary(summary(text()), summary(text({ tone: 'danger' })))).toBe(false)
  })
})
