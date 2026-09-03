/**
 * Tests for the editor draft stash: `mayfly-input` mirrors editor text into
 * the frontend-tree stash, the editor mounted after a reload (a theme swap
 * re-runs this fiber) restores it, and consuming the draft — submit or an
 * Escape buffer clear — clears the stash so the next reload starts empty.
 * A separate tree receives a separate stash.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as inputPlugin from '../../src/interaction/input-plugin.ts'
import { DraftStash } from '../../src/interaction/draft-stash.ts'
import { fakeMayflyContext, KEY, type FakeMayflyComponents, type FakeMayflyEditor } from './fakes.ts'

function type(editor: FakeMayflyEditor, text: string): void {
  for (const char of text) editor.handleInput(char)
}

async function boot(): Promise<{
  ctx: Context
  components: FakeMayflyComponents
  followup: ReturnType<typeof vi.fn>
}> {
  const { ctx, components } = fakeMayflyContext()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  const session = ctx.sessions.create(SessionId('draft-spec'))
  const followup = vi.fn()
  const agent = { id: session.id, session, status: 'idle', followup } as unknown as Agent
  ctx.provide('testSession', { current: agent, modelRef: undefined })
  return { ctx, components, followup }
}

describe('editor draft stash', () => {
  it('restores the stashed draft after a reload and clears it on submit', async () => {
    const { ctx, components, followup } = await boot()
    const firstFiber = await ctx.plugin(inputPlugin)
    const first = components.editors[0] as FakeMayflyEditor
    type(first, 'half-written thought')
    expect(ctx.mayflyInteractionState.draft.getStashedDraft()).toBe('half-written thought')
    // The reload: the fiber disposes and re-runs, rebuilding the editor.
    await firstFiber.dispose()
    const secondFiber = await ctx.plugin(inputPlugin)
    const second = components.editors[1] as FakeMayflyEditor
    expect(second).not.toBe(first)
    expect(second.getText()).toBe('half-written thought')
    // Submitting consumes the draft; the stash goes with it.
    second.handleInput(KEY.enter)
    expect(followup).toHaveBeenCalledOnce()
    expect(ctx.mayflyInteractionState.draft.getStashedDraft()).toBe('')
    // A second reload therefore starts empty.
    await secondFiber.dispose()
    await ctx.plugin(inputPlugin)
    expect(components.editors[2]?.getText()).toBe('')
  })

  it('clears the stash when Escape clears the buffer', async () => {
    const { ctx, components } = await boot()
    const firstFiber = await ctx.plugin(inputPlugin)
    const first = components.editors[0] as FakeMayflyEditor
    type(first, 'draft')
    expect(ctx.mayflyInteractionState.draft.getStashedDraft()).toBe('draft')
    first.handleInput(KEY.escape)
    expect(first.getText()).toBe('')
    expect(ctx.mayflyInteractionState.draft.getStashedDraft()).toBe('')
    await firstFiber.dispose()
    await ctx.plugin(inputPlugin)
    expect(components.editors[1]?.getText()).toBe('')
  })

  it('stashes the input mode beside the draft and resets both on submit', () => {
    const stash = new DraftStash()
    stash.stashInputMode('bash')
    expect(stash.getStashedInputMode()).toBe('bash')
    // Consuming the draft resets the mode with it.
    stash.stashDraft('ls')
    stash.clearDraft()
    expect(stash.getStashedInputMode()).toBe('prompt')
    expect(stash.getStashedDraft()).toBe('')
  })
})
