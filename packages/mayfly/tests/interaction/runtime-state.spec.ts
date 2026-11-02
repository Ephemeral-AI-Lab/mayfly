/**
 * Frontend-tree interaction state isolation and disposal.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { InteractionStateService } from '../../src/interaction/runtime-state.ts'
import { DEFAULT_SETTINGS } from '../../src/interaction/settings.ts'
import { beginPromptWait } from '../../src/interaction/prompt-wait.ts'

describe('InteractionStateService', () => {
  it('retires both shown and pending prompt waits on disposal', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    const service = new InteractionStateService(ctx, DEFAULT_SETTINGS)
    try {
      expect(service.disposed).toBe(false)
      expect(service.settingsSource()).toBe(DEFAULT_SETTINGS)
      beginPromptWait(ctx, 'Native request running')
      vi.advanceTimersByTime(150)
      beginPromptWait(ctx, 'Another request starting')
      expect(service.promptWaits.active).toHaveLength(2)
      expect(vi.getTimerCount()).toBe(1)
      service.dispose()
      expect(service.disposed).toBe(true)
      expect(service.promptWaits.active).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
      await ctx.fiber.dispose()
    }
  })

  it('isolates product state between frontend trees', () => {
    const first = new InteractionStateService(new Context(), DEFAULT_SETTINGS)
    const second = new InteractionStateService(new Context(), DEFAULT_SETTINGS)
    first.draft.stashDraft({ raw: 'first tree', pastes: new Map() })
    first.currentThemeKey = 'custom'
    first.pasteImage.pasteCount = 2

    expect(second.draft.getStashedDraft().raw).toBe('')
    expect(second.currentThemeKey).toBe('dark')
    expect(second.pasteImage.pasteCount).toBe(0)
  })

  it('releases cached and registered state on disposal', () => {
    const service = new InteractionStateService(new Context(), DEFAULT_SETTINGS)
    service.aliases.register('quit', ['q'])
    service.draft.stashDraft({ raw: 'draft', pastes: new Map() })
    service.draft.stashInputMode('bash')
    service.draft.stashHistory(['one'])
    service.modelsDevCache = { at: 1, index: { lookup: vi.fn(), lookupCost: vi.fn() } }
    service.updateInFlight = true
    service.pasteImage.backendCooldowns.set('x11', 1)
    service.pasteImage.pastedImages.set('marker', {
      attachmentId: 'attachment' as never,
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
    })
    service.pasteImage.pasteCount = 3

    service.dispose()

    expect(service.aliases.canonicalOf('q')).toBeUndefined()
    expect(service.draft.getStashedDraft().raw).toBe('')
    expect(service.draft.getStashedInputMode()).toBe('prompt')
    expect(service.draft.getStashedHistory()).toEqual([])
    expect(service.modelsDevCache).toBeUndefined()
    expect(service.updateInFlight).toBe(false)
    expect(service.pasteImage.backendCooldowns.size).toBe(0)
    expect(service.pasteImage.pastedImages.size).toBe(0)
    expect(service.pasteImage.pasteCount).toBe(0)
  })
})
