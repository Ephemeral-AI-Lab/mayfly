/** Empty-editor text explains access and input syntax without changing the draft. */
import { describe, expect, it, vi } from 'vitest'
import { promptPlaceholder } from '../../src/interaction/placeholder.ts'
import { DEFAULT_SETTINGS } from '../../src/interaction/settings.ts'
import { fakeMayflyContext } from './fakes.ts'

describe('prompt placeholders', () => {
  it('provides whole-trigger variants and respects quiet settings', () => {
    const { ctx } = fakeMayflyContext()
    ctx.provide('testSession', { current: { id: 'a', status: 'idle' } })
    expect(promptPlaceholder(ctx)).toEqual([
      'Ask anything · / commands · @ files · # skills · ! shell',
      'Ask anything · / commands · @ files · # skills',
      'Ask anything · / commands · @ files',
      'Ask anything · / commands',
      'Ask anything',
    ])
    ctx.mayflyInteractionState.settingsSource = () => ({ ...DEFAULT_SETTINGS, keyHints: 'minimal' })
    expect(promptPlaceholder(ctx)).toEqual(['Ask anything'])
    ctx.mayflyInteractionState.settingsSource = () => ({ ...DEFAULT_SETTINGS, keyHints: 'off' })
    expect(promptPlaceholder(ctx)).toBeUndefined()
  })
  it('follows running, shell, side-conversation, readonly, and resumable states', () => {
    const { ctx } = fakeMayflyContext()
    const agent = { id: 'a', status: 'running' }
    ctx.provide('testSession', { current: agent })
    expect(promptPlaceholder(ctx)?.at(-1)).toBe('Type a follow-up to queue it')
    ctx.mayflyInteractionState.draft.stashInputMode('bash')
    expect(promptPlaceholder(ctx)).toEqual(['Run a shell command'])
    ctx.mayflyInteractionState.draft.stashInputMode('prompt')
    const displayed = vi.spyOn(ctx.mayflyConversations, 'displayed')
    displayed.mockReturnValue({ kind: 'btw', access: 'interactive', label: 'Side' } as never)
    expect(promptPlaceholder(ctx)?.[0]).toBe('Continue the side question · @ files · # skills')
    displayed.mockReturnValue({ kind: 'subagent', access: 'interactive', label: 'Reviewer' } as never)
    expect(promptPlaceholder(ctx)?.at(-1)).toBe('Message Reviewer')
    displayed.mockReturnValue({ kind: 'subagent', access: 'resumable', label: 'Reviewer' } as never)
    expect(promptPlaceholder(ctx)).toEqual(['Reply to Reviewer — sending resumes it', 'Reply to Reviewer'])
    displayed.mockReturnValue({ kind: 'subagent', access: 'readonly', label: 'Reviewer' } as never)
    expect(promptPlaceholder(ctx)).toEqual(['Read-only conversation'])
    displayed.mockReturnValue(null)
    expect(promptPlaceholder(ctx)?.at(-1)).toBe('Type a follow-up to queue it')
    expect(promptPlaceholder(fakeMayflyContext().ctx)?.at(-1)).toBe('Ask anything')
  })
})
