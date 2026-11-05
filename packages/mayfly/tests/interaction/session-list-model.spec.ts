import { describe, expect, it } from 'vitest'
import type { MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../../src/frontend/locale.ts'
import { formatAgo, formatDuration, sessionDetailNode, sessionLabel, sessionListItem, type SessionListFacts } from '../../src/interaction/session-list-model.ts'
import { withOverrides, type Overrides } from '../fixture-fields.ts'

const t: MayflyTranslate = (key, values) => key.replace(/\{(\w+)\}/g, (_match, name: string) => String(values?.[name]))
const text = (node: MayflyUiNode | ReturnType<typeof sessionListItem>): string => JSON.stringify(node)

const NOW = 1_800_000_000_000
const STATS = { turns: 2, steps: 4, llmMs: 1_000, toolMs: 500, ttftMs: 100, ttftSteps: 1, decodeMs: 900, decodeTokens: 50 }

describe('formatDuration', () => {
  it('formats every scale', () => {
    expect(formatDuration(-5)).toBe('0s')
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(12 * 60_000)).toBe('12m')
    expect(formatDuration(2 * 3_600_000 + 14 * 60_000)).toBe('2h 14m')
    expect(formatDuration(2 * 3_600_000)).toBe('2h')
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe('3d 4h')
    expect(formatDuration(3 * 86_400_000)).toBe('3d')
  })
})

describe('formatAgo', () => {
  it('formats every scale', () => {
    expect(formatAgo(30_000, t)).toBe('just now')
    expect(formatAgo(5 * 60_000, t)).toBe('5m ago')
    expect(formatAgo(3 * 3_600_000, t)).toBe('3h ago')
    expect(formatAgo(2 * 86_400_000, t)).toBe('2d ago')
  })
})

describe('sessionLabel', () => {
  const facts = (over: Partial<SessionListFacts> = {}): SessionListFacts => ({
    id: 'session-id-abcdef', lastActiveAt: NOW - 60_000, running: false,
    archived: false, current: false, reminders: false, migrationRequired: false, ...over,
  } as SessionListFacts)
  it('labels titled sessions and falls back to Untitled plus a short id', () => {
    expect(sessionLabel(facts({ title: 'Named' }), t)).toBe('Named')
    expect(sessionLabel(facts(), t)).toBe('Untitled · id-abcde')
    expect(sessionLabel({ ...facts(), id: 'custom-id' }, t)).toBe('Untitled · custom-i')
  })
})

describe('sessionListItem', () => {
  const facts = (over: Overrides<SessionListFacts> = {}): SessionListFacts => withOverrides<SessionListFacts>({
    id: 'session-id-abcdef', title: 'Named', cwd: '/home/dev/repo',
    lastActiveAt: NOW - 3_000_000, running: false, archived: false, current: false,
    reminders: false, migrationRequired: false,
    tokens: { input: 1_500, cacheRead: 0, cacheWrite: 0, output: 500 },
  }, over) as SessionListFacts
  it('leads the detail with tokens, then age and path', () => {
    const item = sessionListItem(facts(), NOW, '/home/dev', t)
    expect(item.label).toBe('Named')
    expect(item.cells?.map(cell => cell.spans.map(span => span.text).join('')).filter(Boolean)).toEqual(['2k tok', '50m ago', '~/repo'])
    expect(item.searchText).toContain('session-id-abcdef')
    expect(item.searchText).toContain('/home/dev/repo')
    expect(item.badge).toBeUndefined()
  })
  it('joins status badges, including migration, and keeps the parent id', () => {
    const item = sessionListItem(facts({ current: true, running: true, archived: true, reminders: true, migrationRequired: true, parentId: 'parent' }), NOW, '/home/dev', t)
    expect(item.badge).toBe('running · migration required · archived · reminders')
    expect(item.current).toBe(true)
    expect(item.parentId).toBe('parent')
  })
  it('omits missing tokens, activity, and an absent path', () => {
    const item = sessionListItem(facts({ lastActiveAt: undefined, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, cwd: undefined, title: undefined }), NOW, '/home/dev', t)
    expect(item.label).toBe('Untitled · id-abcde')
    expect(item.cells?.every(cell => cell.spans.length === 0)).toBe(true)
  })
})

describe('sessionDetailNode', () => {
  it('renders every field when the facts are complete', () => {
    const detail = text(sessionDetailNode({
      id: 'session-id-abcdef', title: 'Named', cwd: '/repo',
      lastActiveAt: NOW - 60_000, running: true, archived: true, current: true,
      reminders: false, migrationRequired: false, preset: 'standard', parentId: 'parent-id', origin: 'subagent',
      tokens: { input: 1_500, cacheRead: 100, cacheWrite: 50, output: 500 },
      stats: { ...STATS, llmMs: 61_000, toolMs: 2_000 },
      model: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' },
    }, NOW, t))
    expect(detail).toContain('Named')
    expect(detail).toContain('session-id-abcdef')
    expect(detail).toContain('/repo')
    expect(detail).toContain('running · archived · current')
    expect(detail).toContain('standard')
    expect(detail).toContain('Parent session')
    expect(detail).toContain('parent-id')
    expect(detail).toContain('model 1m · tools 2s')
    expect(detail).toContain('2 turns · 4 steps')
    expect(detail).toContain('cache read 100')
    expect(detail).toContain('deepseek-reasoner (deepseek) · high')
  })
  it('shows migration in the status and renders placeholders for sparse facts', () => {
    const detail = text(sessionDetailNode({
      id: 'bare', lastActiveAt: NOW, running: false, archived: false, current: false,
      reminders: false, migrationRequired: true, parentId: 'fork-parent',
    }, NOW, t))
    expect(detail).toContain('inactive · migration required')
    expect(detail).toContain('Untitled')
    expect(detail).toContain('Forked from')
    expect(detail).not.toContain('Parent session')
    expect(detail.match(/—/g)?.length).toBe(5)
    expect(detail).not.toContain('Preset')
  })
})
