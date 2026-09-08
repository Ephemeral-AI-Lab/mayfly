/**
 * Shared interaction action registration, including global Agent-view keys.
 * @module interaction-keys
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { MayflyKeymapService } from '../../src/core/keymap.ts'
import { UiInteractionService } from '../../src/core/ui-interaction-state.ts'
import * as keys from '../../src/interaction/keys.ts'
import { ACTION_SUBMIT, displayKey, keyActionKeys, matchesKeyAction } from '../../src/core/key-actions.ts'

describe('interaction keys', () => {
  it('normalizes paging, boundary, deletion, and Agent-view keys', () => {
    const ctx = new Context()
    const keymap = new MayflyKeymapService(ctx)
    keymap.register([...keys.INTERACTION_KEY_ACTIONS])
    expect(keymap.matches('\x1b[5~', keys.ACTION_PAGE_UP)).toBe(true)
    expect(keymap.matches('\x1b[6~', keys.ACTION_PAGE_DOWN)).toBe(true)
    expect(keymap.matches('\x1b[H', keys.ACTION_HOME)).toBe(true)
    expect(keymap.matches('\x1b[F', keys.ACTION_END)).toBe(true)
    expect(keymap.matches('\x04', keys.ACTION_DELETE)).toBe(true)
    expect(keymap.matches('\x1b[18~', keys.ACTION_TOGGLE_AGENT_VIEW)).toBe(true)
    expect(keys.interactionKeyHint(keymap, keys.ACTION_DELETE, 'Delete')).toBe('Delete/Ctrl+D')
    expect(keys.interactionKeyHint(keymap, 'missing', 'Fallback')).toBe('Fallback')
  })

  it('formats remapped key ids for contextual hints', () => {
    const keymap = { getKeys: () => ['f12', 'shift+tab', 'alt+x', 'meta+word'] } as never
    expect(keys.interactionKeyHint(keymap, keys.ACTION_SUBMIT, 'Enter')).toBe('F12/Shift+Tab/Alt+X/Meta+word')
    expect(['enter', 'f10', 'ctrl+x', 'alt+x', 'shift+x', 'meta+x', 'ctrl+delete', 'word'].map(displayKey)).toEqual([
      'Enter', 'F10', 'Ctrl+X', 'Alt+X', 'Shift+X', 'Meta+X', 'Ctrl+Delete', 'word',
    ])
    expect(keyActionKeys(undefined, ACTION_SUBMIT)).toEqual(['enter'])
    expect(keyActionKeys(undefined, 'missing')).toEqual([])
    expect(keyActionKeys({} as never, 'missing')).toEqual([])
    expect(keyActionKeys(keymap, ACTION_SUBMIT)).toEqual(['f12', 'shift+tab', 'alt+x', 'meta+word'])
    expect(matchesKeyAction(undefined, '\r', ACTION_SUBMIT)).toBe(true)
    expect(matchesKeyAction({ matches: () => false, getKeys: () => ['enter'] } as never, '\r', ACTION_SUBMIT)).toBe(false)
  })

  it('dispatches F7 and F8 through the current-Agent view owner', async () => {
    const ctx = new Context()
    await ctx.plugin(MayflyKeymapService)
    const interaction = new UiInteractionService(ctx)
    const toggleAuxiliary = vi.fn(() => true)
    const closeAuxiliary = vi.fn(() => ({ kind: 'btw' }))
    ctx.reflect.provide('mayflyCurrentAgent', { current: () => null, toggleAuxiliary, closeAuxiliary })
    ctx.on('mayfly/request-close-agent-view', () => { closeAuxiliary() })
    const fiber = await ctx.plugin(keys)
    expect(ctx.mayflyKeymap.dispatch('\x1b[18~')).toBe(true)
    expect(toggleAuxiliary).toHaveBeenCalledOnce()

    expect(ctx.mayflyKeymap.dispatch('\x1b[19~')).toBe(true)
    expect(closeAuxiliary).toHaveBeenCalledOnce()
    expect(interaction.notificationSnapshot()).toEqual([])
    await fiber.dispose()
  })

  it('reports an absent auxiliary without throwing from global dispatch', async () => {
    const ctx = new Context()
    await ctx.plugin(MayflyKeymapService)
    const interaction = new UiInteractionService(ctx)
    ctx.reflect.provide('mayflyCurrentAgent', { current: () => null, toggleAuxiliary: () => false, closeAuxiliary: () => null })
    await ctx.plugin(keys)
    ctx.mayflyKeymap.dispatch('\x1b[18~')
    ctx.mayflyKeymap.dispatch('\x1b[19~')
    expect(interaction.notificationSnapshot()).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'warning', message: 'no auxiliary conversation is open' })]))
  })
})
