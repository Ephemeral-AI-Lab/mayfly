/**
 * Shared interaction action registration, including global Agent-view keys.
 * @module interaction-keys
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { MayflyKeymapService } from '../../src/core/keymap.ts'
import * as keys from '../../src/interaction/keys.ts'

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
  })

  it('dispatches F7 and F8 through the current-Agent view owner', async () => {
    const ctx = new Context()
    await ctx.plugin(MayflyKeymapService)
    const toggleAuxiliary = vi.fn(() => true)
    const closeAuxiliary = vi.fn(() => ({ kind: 'btw' }))
    const notice = vi.fn()
    ctx.reflect.provide('mayflyCurrentAgent', { toggleAuxiliary, closeAuxiliary })
    ctx.reflect.provide('mayflyPromptEditor', { current: { notice } })
    ctx.on('mayfly/request-close-agent-view', () => { closeAuxiliary() })
    const fiber = await ctx.plugin(keys)
    expect(ctx.mayflyKeymap.dispatch('\x1b[18~')).toBe(true)
    expect(toggleAuxiliary).toHaveBeenCalledOnce()

    expect(ctx.mayflyKeymap.dispatch('\x1b[19~')).toBe(true)
    expect(closeAuxiliary).toHaveBeenCalledOnce()
    expect(notice).not.toHaveBeenCalled()
    await fiber.dispose()
  })

  it('reports an absent auxiliary without throwing from global dispatch', async () => {
    const ctx = new Context()
    await ctx.plugin(MayflyKeymapService)
    const notice = vi.fn()
    ctx.reflect.provide('mayflyCurrentAgent', { toggleAuxiliary: () => false, closeAuxiliary: () => null })
    ctx.reflect.provide('mayflyPromptEditor', { current: { notice } })
    await ctx.plugin(keys)
    ctx.mayflyKeymap.dispatch('\x1b[18~')
    ctx.mayflyKeymap.dispatch('\x1b[19~')
    expect(notice).toHaveBeenCalledOnce()
  })
})
