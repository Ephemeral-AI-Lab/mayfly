/** Contextual keys follow editor state, registration, settings, and Fiber lifetime. */
import { describe, expect, it, vi } from 'vitest'
import * as provider from '@ephemeral-ai/mayfly-ui/provider'
import { mountKeyHintsStatus, promptKeyHints, promptPlanState, type PromptHintState } from '../../src/interaction/key-hints-status.ts'
import { DEFAULT_SETTINGS } from '../../src/interaction/settings.ts'
import { INTERACTION_KEY_ACTIONS, ACTION_CYCLE_MODEL, ACTION_CANCEL } from '../../src/interaction/keys.ts'
import { fakeMayflyContext } from './fakes.ts'
import { flushRequests } from './request-fixture.ts'

const t = (key: string) => key
const keys = new Map(INTERACTION_KEY_ACTIONS.map(action => [action.id, typeof action.keys === 'string' ? [action.keys] : action.keys]))
keys.set('mayfly.transcript.toggle-collapse', ['ctrl+o'])
keys.set('mayfly.surface.next', ['f6'])
const key = (action: string) => keys.get(action) ?? []
const idle: PromptHintState = { access: 'interactive', running: false, stopping: false, draft: false, shell: false, plan: false }
const row = (state: Partial<PromptHintState>, mode: 'full' | 'minimal' | 'off' = 'full') => promptKeyHints({ ...idle, ...state }, mode, key, t).map(hint => `${hint.key} ${hint.label}`)

describe('contextual status keys', () => {
  it('teaches available idle and mode actions without promising a send on an empty prompt', () => {
    expect(row({})).toEqual(['Shift+Tab plan', 'Alt+M model', '/help keys'])
    expect(row({ plan: true, disclosure: { expanded: false, count: 2 } })).toEqual(['Ctrl+O expand', 'Shift+Tab exit plan', 'Alt+M model', '/help keys'])
    expect(row({ disclosure: { expanded: true, count: 1 } })[0]).toBe('Ctrl+O collapse')
    expect(row({ disclosure: { expanded: false, count: 0 }, plan: undefined })).toEqual(['Alt+M model', '/help keys'])
    expect(row({ shell: true })).toEqual(['Backspace exit shell', 'Shift+Tab plan', 'Alt+M model'])
  })
  it('distinguishes running, stopping, shell and draft effects', () => {
    expect(row({ running: true })).toEqual(['Esc interrupt'])
    expect(row({ running: true, hasRetractionCandidate: true })).toEqual(['Esc take back / interrupt'])
    expect(row({ running: true, stopping: true })).toEqual([])
    expect(row({ running: true, draft: true })).toEqual(['Esc interrupt', 'Enter queue', 'Ctrl+S steer', 'Alt+Enter newline', 'Ctrl+G editor'])
    expect(row({ draft: true })).toEqual(['Enter send', 'Alt+Enter newline', 'Ctrl+G editor', 'Esc clear'])
    expect(row({ draft: true, shell: true })).toEqual(['Enter run', 'Ctrl+G editor', 'Esc clear'])
  })
  it('keeps access restrictions and quiet settings honest', () => {
    expect(row({ access: 'readonly' })).toEqual(['PgUp/PgDn scroll'])
    expect(row({ access: 'resumable' })).toEqual(['Enter reply', 'PgUp/PgDn scroll'])
    expect(row({ access: 'resumable' }, 'minimal')).toEqual([])
    expect(row({ draft: true }, 'minimal')).toEqual([])
    expect(row({ running: true, draft: true }, 'minimal')).toEqual(['Esc interrupt'])
    expect(row({ running: true }, 'off')).toEqual([])
    expect(row({ editorFocused: false })).toEqual([])
    expect(row({ focusable: true })).toContain('F6 focus')
    expect(promptKeyHints({ ...idle, access: 'readonly' }, 'full', () => [], t)).toEqual([])
    expect(promptKeyHints(idle, 'full', () => [], t)).toEqual([{ id: 'help', key: '/help', label: 'keys', priority: 9 }])
  })
  it('uses rebound keys and removes absent actions', () => {
    const rebound = (id: string) => id === ACTION_CYCLE_MODEL ? ['ctrl+m'] : id === ACTION_CANCEL ? [] : key(id)
    const hints = promptKeyHints(idle, 'full', rebound, t)
    expect(hints.find(hint => hint.id === 'model')?.key).toBe('Ctrl+M')
    expect(promptKeyHints({ ...idle, running: true }, 'full', rebound, t)).toEqual([])
  })
  it('live-applies full/minimal/off, hides under capturing overlays, and cleans up with its owner', async () => {
    const { ctx } = fakeMayflyContext()
    await ctx.plugin(provider)
    let mode: 'full' | 'minimal' | 'off' = 'full'
    ctx.mayflyInteractionState.settingsSource = () => ({ ...DEFAULT_SETTINGS, keyHints: mode })
    let state = idle
    let refresh = () => {}
    const fiber = await ctx.plugin({ name: 'hint-spec', apply(owner) { refresh = mountKeyHintsStatus(owner, () => state) } })
    await flushRequests()
    const entries = () => ctx.mayflyStatus.list().filter(entry => entry.id.startsWith('mayfly.status.keys.'))
    expect(entries()).toHaveLength(3)
    const original = entries().map(entry => entry.revision)
    refresh()
    expect(entries().map(entry => entry.revision)).toEqual(original)
    state = { ...idle, plan: true }
    refresh()
    expect(JSON.stringify(entries())).toContain('exit plan')
    mode = 'off'
    ctx.emit('settings/document-updated', 'mayfly' as never)
    expect(entries()).toHaveLength(0)
    mode = 'minimal'
    state = { ...idle, running: true }
    ctx.mayflyInteractionState.draft.stashDraft('draft')
    expect(entries()).toHaveLength(1)
    const overlay = ctx.mayflyOverlays.open({ id: 'capture', capturing: true }, { kind: 'text', content: 'Request' })
    expect(entries()).toHaveLength(0)
    overlay.hide()
    expect(entries()).toHaveLength(1)
    overlay.close()
    await fiber.dispose()
    refresh()
    expect(entries()).toHaveLength(0)
  })
  it('derives the effective plan state, including queued toggles and a missing Agent', () => {
    const { ctx } = fakeMayflyContext()
    expect(promptPlanState(ctx)).toBeUndefined()
    ctx.provide('testSession', { current: { id: 'a', session: { id: 'a' }, status: 'idle' } })
    let plan: { active: boolean, pending: boolean } | undefined
    vi.spyOn(ctx.sessionProjections, 'snapshot').mockImplementation(() => ({ asOfSeq: 0, values: { plan } }) as never)
    expect(promptPlanState(ctx)).toBeUndefined()
    plan = { active: true, pending: false }
    expect(promptPlanState(ctx)).toBe(true)
    plan = { active: true, pending: true }
    expect(promptPlanState(ctx)).toBe(false)
  })
})
