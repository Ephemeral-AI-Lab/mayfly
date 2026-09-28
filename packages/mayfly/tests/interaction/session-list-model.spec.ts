/** `/sessions` pure projections: facts, rows, and the detail sheet.
 * @module @ephemeral-ai/mayfly/tests/interaction/session-list-model
 */
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import type { MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../../src/frontend/index.ts'
import {
  formatAgo,
  formatDuration,
  sessionDetailNode,
  sessionLabel,
  sessionListFacts,
  sessionListItem,
  sessionSpan,
  type SessionListFacts,
} from '../../src/interaction/session-list-model.ts'

const t: MayflyTranslate = (key, values) => key.replace(/\{(\w+)\}/g, (_match, name: string) => String(values?.[name]))
const text = (node: MayflyUiNode | ReturnType<typeof sessionListItem>): string => JSON.stringify(node)

const NOW = 1_800_000_000_000

const summary = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: 'session-id-abcdef',
  updatedAt: NOW - 60_000,
  running: false,
  ...over,
} as SessionSummary)

const header = (over: Partial<SessionHeader> = {}): SessionHeader => ({
  id: 'session-id-abcdef',
  createdAt: NOW - 3_600_000,
  cwd: '/header/cwd',
  ...over,
} as SessionHeader)

const context = (over = {}) => ({ archived: false, current: false, now: NOW, ...over })

describe('sessionListFacts', () => {
  it('projects the title, projections, and header join', () => {
    const facts = sessionListFacts(summary({
      cwd: '/summary/cwd',
      running: true,
      projections: { values: {
        title: 'My session',
        tokenUsage: { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 },
        sessionStats: { turns: 2, steps: 4, llmMs: 1_000, toolMs: 500, ttftMs: 100, ttftSteps: 1, decodeMs: 900, decodeTokens: 50 },
        modelSelection: { lastUsed: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' } },
        mayflyConversationFacts: { endedAt: NOW - 30_000 },
      } },
    }), { ...context({ current: true, archived: true }), header: header({ agentPreset: 'standard' }), reminders: new Set(['session-id-abcdef']) })
    expect(facts).toMatchObject({
      id: 'session-id-abcdef',
      title: 'My session',
      cwd: '/summary/cwd',
      createdAt: NOW - 3_600_000,
      preset: 'standard',
      lastActiveAt: NOW,
      running: true,
      archived: true,
      current: true,
      reminders: true,
      tokens: { input: 100, cacheRead: 10, cacheWrite: 5, output: 50 },
      stats: { turns: 2, steps: 4 },
      model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
    })
  })

  it('falls back through the header and drops absent values', () => {
    const facts = sessionListFacts(summary({ parentSessionId: 'parent-id', origin: 'subagent', updatedAt: NOW - 120_000 }), {
      ...context(), header: header({ agentPreset: undefined }),
    })
    expect(facts.title).toBeUndefined()
    expect(facts.cwd).toBe('/header/cwd')
    expect(facts.preset).toBeUndefined()
    expect(facts.lastActiveAt).toBe(NOW - 120_000)
    expect(facts.parentId).toBe('parent-id')
    expect(facts.origin).toBe('subagent')
    expect(facts.tokens).toBeUndefined()
    expect(facts.stats).toBeUndefined()
    expect(facts.model).toBeUndefined()
    expect(facts.reminders).toBe(false)
  })

  it('uses the next model when none was used and ignores empty titles', () => {
    const facts = sessionListFacts(summary({
      projections: { values: {
        title: '',
        modelSelection: { next: { provider: 'deepseek', model: 'deepseek-reasoner' } },
      } },
    }), context())
    expect(facts.title).toBeUndefined()
    expect(facts.model).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
    expect(facts.cwd).toBeUndefined()
    expect(facts.createdAt).toBeUndefined()
  })
})

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

describe('sessionSpan and sessionLabel', () => {
  const facts = (over: Partial<SessionListFacts> = {}): SessionListFacts => ({
    id: 'session-id-abcdef', lastActiveAt: NOW - 60_000, running: false, archived: false, current: false, reminders: false, ...over,
  })
  it('computes the wall span and clamps a reversed pair', () => {
    expect(sessionSpan(facts({ createdAt: NOW - 3_600_000 }))).toBe(3_540_000)
    expect(sessionSpan(facts({ createdAt: NOW }))).toBe(0)
    expect(sessionSpan(facts())).toBeUndefined()
  })
  it('labels titled sessions and falls back to a short id', () => {
    expect(sessionLabel(facts({ title: 'Named' }), t)).toBe('Named')
    expect(sessionLabel(facts(), t)).toBe('Untitled · session-')
  })
})

describe('sessionListItem', () => {
  const facts = (over: Partial<SessionListFacts> = {}): SessionListFacts => ({
    id: 'session-id-abcdef', title: 'Named', cwd: '/home/dev/repo', createdAt: NOW - 3_600_000,
    lastActiveAt: NOW - 3_000_000, running: false, archived: false, current: false, reminders: false,
    tokens: { input: 1_500, cacheRead: 0, cacheWrite: 0, output: 500 }, ...over,
  })
  it('leads the detail with the span and tokens, then age and path', () => {
    const item = sessionListItem(facts(), NOW, '/home/dev', t)
    expect(item.label).toBe('Named')
    expect(item.detailSpans?.map(span => span.text).join('')).toBe('10m · 2k tok · 50m ago · ~/repo')
    expect(item.searchText).toContain('session-id-abcdef')
    expect(item.searchText).toContain('/home/dev/repo')
    expect(item.badge).toBeUndefined()
  })
  it('joins status badges and keeps the parent id', () => {
    const item = sessionListItem(facts({ current: true, running: true, archived: true, reminders: true, parentId: 'parent' }), NOW, '/home/dev', t)
    expect(item.badge).toBe('current · running · archived · reminders')
    expect(item.parentId).toBe('parent')
  })
  it('omits missing span, zero tokens, and an absent path', () => {
    const item = sessionListItem(facts({ createdAt: undefined, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, cwd: undefined, title: undefined }), NOW, '/home/dev', t)
    expect(item.label).toBe('Untitled · session-')
    expect(item.detailSpans?.map(span => span.text).join('')).toBe('50m ago')
  })
})

describe('sessionDetailNode', () => {
  it('renders every field when the facts are complete', () => {
    const detail = text(sessionDetailNode({
      id: 'session-id-abcdef', title: 'Named', cwd: '/repo', createdAt: NOW - 3_600_000,
      lastActiveAt: NOW - 60_000, running: true, archived: true, current: true, reminders: false,
      preset: 'standard', parentId: 'parent-id', origin: 'subagent',
      tokens: { input: 1_500, cacheRead: 100, cacheWrite: 50, output: 500 },
      stats: { turns: 2, steps: 4, llmMs: 61_000, toolMs: 2_000, ttftMs: 100, ttftSteps: 1, decodeMs: 900, decodeTokens: 50 },
      model: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' },
    }, NOW, t))
    expect(detail).toContain('Named')
    expect(detail).toContain('session-id-abcdef')
    expect(detail).toContain('/repo')
    expect(detail).toContain('running · archived · current')
    expect(detail).toContain('standard')
    expect(detail).toContain('Parent session')
    expect(detail).toContain('parent-id')
    expect(detail).toContain('59m')
    expect(detail).toContain('model 1m · tools 2s')
    expect(detail).toContain('2 turns · 4 steps')
    expect(detail).toContain('cache read 100')
    expect(detail).toContain('deepseek-reasoner (deepseek) · high')
  })
  it('renders placeholders and omits lineage fields when facts are sparse', () => {
    const detail = text(sessionDetailNode({
      id: 'bare', lastActiveAt: NOW, running: false, archived: false, current: false, reminders: false,
      parentId: 'fork-parent',
    }, NOW, t))
    expect(detail).toContain('Untitled')
    expect(detail).toContain('inactive')
    expect(detail).toContain('Forked from')
    expect(detail).not.toContain('Parent session')
    expect(detail.match(/—/g)?.length).toBe(7)
    expect(detail).not.toContain('Preset')
  })
})
