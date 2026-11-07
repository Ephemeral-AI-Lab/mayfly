/** Readonly presentation decisions at missing, invalid and lifecycle boundaries. @module */
import { Context } from '@deepseek-ai/cordis'
import type { JobView } from '@deepseek-ai/dsh-jobs'
import type { MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { afterEach, expect, it, vi } from 'vitest'
import { buildAccountPanel } from '../../src/components/account-panel.ts'
import { buildConversationStatus } from '../../src/components/conversation-status.ts'
import { Editor } from '../../src/components/editor.ts'
import { NotificationLine } from '../../src/components/notification-line.ts'
import { DEFAULT_SETTINGS } from '../../src/frontend/settings.ts'
import { interpolateLocaleMessage as t } from '../../src/frontend/locale.ts'
import { agentsPanelModel } from '../../src/interaction/agents-model.ts'
import { DraftStash } from '../../src/interaction/draft-stash.ts'
import { jobListPanel } from '../../src/interaction/jobs-model.ts'
import { placeholderLadder, placeholderState } from '../../src/interaction/placeholder.ts'
import { InteractionStateService } from '../../src/interaction/runtime-state.ts'
import { scheduleNode } from '../../src/interaction/schedule-model.ts'
import { usageNode, formatCreated } from '../../src/interaction/session-info-model.ts'
import { sessionWorkspaceLabel, sessionWorkspaceTab } from '../../src/interaction/session-workspaces-model.ts'
import { SessionlessCommandRegistry } from '../../src/interaction/sessionless-commands.ts'
import { themeLabel, themeName } from '../../src/interaction/theme-names.ts'
import { mentionPath } from '../../src/internal/mention.ts'
import { buildModelStatusNode } from '../../src/transcript/model-status.ts'
import { outputCounter } from '../../src/transcript/output-rate.ts'
import { resumedSessionMessage } from '../../src/transcript/resume-notice.ts'
import { buildContextStatusNode, contextPercent } from '../../src/transcript/status-context-model.ts'
import { formatGitBadge } from '../../src/transcript/status-git-model.ts'
import { createRealSurface, probeComponents } from '../design/probe.ts'
import { expectLinesFit, SCAN_WIDTHS } from '../core/width-scan.ts'

const text = (node: unknown): string => JSON.stringify(node)
afterEach(() => { vi.useRealTimers() })

function fits(node: MayflyUiNode): void {
  for (const width of SCAN_WIDTHS) {
    const surface = createRealSurface(node, width, { components: probeComponents() })
    try { expectLinesFit('presentation boundary', surface.render(), width) } finally { surface.dispose() }
  }
}

it('distinguishes account cancellation, expiry and actionable native failures', () => {
  for (const [phase, errorCode, expected] of [
    ['cancelled', undefined, 'Sign-in cancelled'], ['expired', undefined, 'link expired'],
    ['failed', 'expired', 'link expired'], ['failed', 'network', 'Could not reach'],
    ['failed', 'no-response', 'Could not reach'], ['failed', 'storage', 'could not be saved'],
    ['failed', undefined, 'Sign-in failed'],
  ] as const) {
    const node = buildAccountPanel({ status: 'signed-out', attempt: { phase, ...errorCode === undefined ? {} : { errorCode } } }, t, true, undefined, { now: 0 })
    expect(text(node)).toContain(expected)
    fits(node)
  }
  expect(text(buildAccountPanel({ status: 'signed-out', attempt: null }, t, false, undefined, { now: 0 }))).toContain('Desktop or Web host')
  for (const phase of ['starting', 'waiting-browser', 'exchanging', 'committing']) {
    for (const linked of [false, true]) {
      const node = buildAccountPanel({ status: 'signed-out', attempt: { phase, ...linked ? { authorizeUrl: 'https://example.test/login', expiresAt: 60_000 } : {} } }, t, true, undefined, { now: 1_000, pasteOpen: true, focusPaste: true, expiryTotalMs: 60_000 })
      fits(node)
    }
  }
  fits(buildAccountPanel({ status: 'signed-out', attempt: { phase: 'waiting-browser' } }, t, true, undefined, { now: 0 }))
})

it('keeps recurring reminders precise and orders equal targets stably', () => {
  const now = Date.parse('2026-11-08T00:00:00Z')
  const at = (offset: number) => new Date(now + offset).toISOString()
  const records: Parameters<typeof scheduleNode>[0] = [
    { id: 'later', title: 'Later', kind: 'after', scheduledAt: at(1) },
    { id: 'due', title: 'Due', kind: 'at', scheduledAt: at(0) },
    { id: 'old', title: 'Old', kind: 'rrule', scheduledAt: at(-86_400_000) },
    ...[1, 2, 60, 120, 3600, 7200, 86400, 172800, 61].map((everySeconds, index) => ({ id: `every-${index}`, title: `Interval ${everySeconds}`, kind: 'every' as const, everySeconds, scheduledAt: at((index + 1) * 3_600_000) })),
    ...(['daily', 'weekly', 'cron'] as const).map(kind => ({ id: kind, title: kind, kind, timeZone: 'Asia/Shanghai', scheduledAt: at(-500) })),
  ]
  const node = scheduleNode(records, now, t, 'en')
  const serialized = text(node)
  expect(serialized.indexOf('"id":"old"')).toBeLessThan(serialized.indexOf('"id":"due"'))
  for (const value of ['Due now', 'RRULE', 'Every 1 day', 'Every 2 hours', 'Every 61 seconds', 'Asia/Shanghai', 'overdue']) expect(serialized).toContain(value)
  const ties = scheduleNode([records[1]!, { ...records[1]!, id: 'tie', title: 'Tie' }], now, t)
  expect(text(ties).indexOf('"id":"due"')).toBeLessThan(text(ties).indexOf('"id":"tie"'))
  for (const delta of [500, -500, -65_000, -3_600_000]) fits(scheduleNode([{ id: 'relative', title: 'Target', kind: 'after', scheduledAt: at(delta) }], now, t))
  fits(node)
})

it('shows live jobs first and uses the settled finish time for durations', () => {
  vi.spyOn(Date, 'now').mockReturnValue(7_200_000)
  const job = (id: string, status: JobView['status'], startedAt: number, finishedAt?: number): JobView => ({ id, status, startedAt, ...finishedAt === undefined ? {} : { finishedAt }, kind: 'bash', label: id, output: { total: 0, earliest: 0 } }) as JobView
  const rows = [job('done-long', 'completed', 0, 3_660_000), job('done-minute', 'failed', 0, 60_000), job('running', 'running', 0), job('stopping', 'stopping', 1), job('missing-finish', 'killed', 120_000), { ...job('no-finish-newer', 'failed', 180_000), detail: 'Stopped by owner' }]
  const node = jobListPanel(rows, true, t)
  const serialized = text(node)
  expect(serialized.indexOf('"id":"running"')).toBeLessThan(serialized.indexOf('"id":"stopping"'))
  expect(serialized.indexOf('"id":"stopping"')).toBeLessThan(serialized.indexOf('"id":"done-long"'))
  for (const duration of ['2h', '1h 1m', '1m']) expect(serialized).toContain(duration)
  fits(node)
  vi.restoreAllMocks()
})

it('keeps exact workspace paths, labels and explicit current flags', () => {
  expect(sessionWorkspaceLabel(undefined, '/home/dev', t)).toBe('No working directory')
  expect(sessionWorkspaceLabel('/home/dev', '/home/dev', t)).toBe('~')
  expect(sessionWorkspaceLabel('/other', '/home/dev', t)).toBe('/other')
  expect(sessionWorkspaceLabel('D:\\repo', 'C:\\Users\\dev', t, 'win32')).toBe('D:/repo')
  const row = { id: 'w', cwd: '/home/dev/repo', count: 2 }
  expect(sessionWorkspaceTab(row, row.cwd, '/home/dev', t)).toEqual({ id: 'w', label: '~/repo · current', count: 2 })
  expect(sessionWorkspaceTab({ ...row, title: 'Named', current: false }, row.cwd, '', t).label).toBe('Named')
  expect(sessionWorkspaceTab({ ...row, label: 'Other sessions', current: true }, undefined, '', key => `translated:${key}`).label).toBe('translated:Other sessions · translated:current')
  expect(sessionWorkspaceTab({ ...row, cwd: undefined }, undefined, '', t).label).toBe('No working directory')
})

it('fences old sessionless command disposers and preserves discoverable hints', () => {
  const registry = new SessionlessCommandRegistry()
  const first = { name: 'z', description: 'Old', handler: vi.fn() }
  const off = registry.register(first)
  const replacement = { ...first, description: 'New', input: { hint: 'argument' } }
  const offNew = registry.register(replacement)
  registry.register({ name: 'a', description: 'First', handler: vi.fn() })
  off()
  expect(registry.find('z')).toBe(replacement)
  expect(registry.list()).toEqual([{ name: 'a', description: 'First' }, { name: 'z', description: 'New', input: { hint: 'argument' } }])
  offNew(); offNew()
  expect(registry.find('z')).toBeUndefined()
  registry.clear()
  expect(registry.list()).toEqual([])
})

it('retains paste history and clears every outstanding wait on frontend disposal', () => {
  const stash = new DraftStash()
  const pastes = new Map([[1, 'large paste']])
  stash.stashHistory(['[paste #1]'], [pastes])
  expect(stash.getStashedHistoryPastes()).toEqual([pastes])
  vi.useFakeTimers()
  const state = new InteractionStateService(new Context(), DEFAULT_SETTINGS)
  state.promptWaits.active.push({ timer: setTimeout(() => { throw new Error('retired wait') }, 50) } as never, {} as never)
  state.dispose()
  expect(vi.getTimerCount()).toBe(0)
  expect(state.promptWaits.active).toEqual([])
})

it('keeps resumable and named child placeholders distinct from readonly views', () => {
  const resumable = placeholderState({ kind: 'subagent', access: 'resumable', label: 'Worker' }, false, false)
  expect(placeholderLadder(resumable, true, t)).toEqual(['Reply to Worker — sending resumes it'])
  const live = placeholderState({ kind: 'subagent', access: 'interactive' }, false, false)
  expect(placeholderLadder(live, false, t)).toEqual(['Message  · @ files · # skills', 'Message '])
  expect(themeName('unknown-custom', t)).toBe('unknown-custom')
  expect(themeLabel('light', t)).toContain('(light)')
  expect(themeLabel('dark', t)).toContain('(dark)')
  expect(mentionPath('@"closed"')).toBe('closed')
  expect(mentionPath('@"unfinished')).toBe('unfinished')
  expect(mentionPath('@"')).toBe('')
})

it('carries child progress and singular tool metrics without inventing labels', () => {
  const base = { kind: 'child', id: 'worker', parentId: 'root', depth: 1, hasChildren: false, mode: 'continuable', activity: 'running' } as const
  for (const streamPhase of ['thinking', 'composing'] as const) {
    const node = agentsPanelModel([{ ...base, streamPhase, liveChars: 100, toolCount: 1 } as never], 1000, t)
    expect(text(node)).toContain('↓25')
    expect(text(node)).toContain('1 tool')
    expect(text(node)).toContain(streamPhase === 'thinking' ? 'Thinking…' : 'Writing…')
    fits(node)
  }
})

it('preserves notification navigation beside a notice and the shell frame accent', () => {
  const node = NotificationLine({ toggle: 'F7 child', notice: { severity: 'info', message: 'Resumed session' } })
  expect(text(node)).toContain('F7 child  ')
  fits(node)
  fits(NotificationLine({ toggle: 'F7 child' }))
  expect(Editor({ shell: true })).toMatchObject({ border: 'accent' })
  expect(buildConversationStatus('primary', t)).toMatchObject({ spans: [{ text: ' main ' }] })
})

it('keeps resumed history ages and git uncertainty explicit', () => {
  for (const [age, expected] of [[0, 'just now'], [120_000, '2m ago'], [7_200_000, '2h ago'], [172_800_000, '2d ago']] as const) expect(resumedSessionMessage(1, 0, age, t)).toBe(`Resumed session · 1 turn · last active ${expected}`)
  expect(outputCounter(0)).toBe('')
  expect(buildModelStatusNode(undefined)).toBeNull()
  expect(formatGitBadge({ branch: 'main', unknown: true })).toBe('main [?]')
  const clean = { branch: 'main', dirty: false, ahead: 0, behind: 0, diffAdded: 0, diffDeleted: 0 }
  expect(formatGitBadge(clean)).toBe('main')
  expect(formatGitBadge({ ...clean, dirty: true })).toBe('main [±]')
  expect(formatGitBadge({ ...clean, ahead: 2, behind: 3, diffAdded: 4, diffDeleted: 5 })).toBe('main [+4 -5 ↑2↓3]')
})

it('handles invalid pressure and cache counts without changing warning boundaries', () => {
  expect(contextPercent(Infinity, 100)).toBe(0)
  for (const used of [60, 80, 95]) for (const cacheRead of [0, 40, 70, Infinity]) {
    const node = buildContextStatusNode({ pressure: { projectedTokens: used, contextWindow: 100 }, usage: { uncachedInputTokens: 10, cacheReadTokens: cacheRead, cacheWriteTokens: 0 } } as never)
    expect(text(node)).toContain('ctx')
  }
})

it('distinguishes unavailable usage, output-only usage and heuristic composition', () => {
  expect(formatCreated(NaN)).toBe('unknown UTC')
  for (const window of [undefined, 0, 100]) for (const used of [undefined, 30, 80, 95]) {
    const node = usageNode({ usage: { buckets: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0 }, context: { ...window === undefined ? {} : { window }, ...used === undefined ? {} : { used } } }, composition: { system: Infinity, tools: -1, messages: NaN } }, t)
    expect(text(node)).toContain('Session usage')
    fits(node)
  }
})

it('uses the default profile directory when DSH_HOME is empty', async () => {
  const { dshHome } = await import('../../src/interaction/updater/profile.ts')
  const { updaterInternals } = await import('../../src/interaction/updater/io.ts')
  const old = updaterInternals.env.DSH_HOME
  try {
    updaterInternals.env.DSH_HOME = ''
    expect(dshHome()).toBe(`${updaterInternals.homedir()}/.dsh`)
  } finally {
    if (old === undefined) delete updaterInternals.env.DSH_HOME
    else updaterInternals.env.DSH_HOME = old
  }
})
