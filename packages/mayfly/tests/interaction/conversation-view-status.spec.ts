/**
 * Centered status projection of the displayed conversation.
 * @module conversation-view-status
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { MayflyInlineSpan } from '@ephemeral-ai/mayfly-ui'
import { describe, expect, it } from 'vitest'
import { MayflyStatusService } from '../../../ui/src/services.ts'
import { MayflyConversationsService } from '../../src/app/conversation-views.ts'
import * as statusPlugin from '../../src/interaction/conversation-view-status.ts'
import { FakeKeymap } from './fakes.ts'

function agent(id: string): Agent { return { id: SessionId(id) } as Agent }

describe('mayfly-conversation-view-status', () => {
  it('shows the displayed kind, its F7 counterpart, access, and how many more stay open', async () => {
    const ctx = new Context()
    const primary = agent('primary')
    const child = agent('child')
    const btw = agent('btw')
    const live = new Map([[String(primary.id), primary], [String(child.id), child], [String(btw.id), btw]])
    ctx.reflect.provide('agents', { get: (id: unknown) => live.get(String(id)) })
    ctx.reflect.provide('mayflyKeymap', new FakeKeymap())
    const conversations = new MayflyConversationsService(ctx)
    conversations.selectPrimary(primary)
    const statuses = new MayflyStatusService(ctx)
    const fiber = await ctx.plugin(statusPlugin)
    const entry = () => statuses.list().find(candidate => candidate.id === 'mayfly.status.conversation-view')!
    const text = () => (entry().node as { readonly spans: readonly MayflyInlineSpan[] }).spans.map(span => span.text).join('')
    const badge = () => (entry().node as { readonly spans: readonly MayflyInlineSpan[] }).spans[0]
    expect(entry().node).toBeNull()

    conversations.open({ kind: 'subagent', sessionId: 'child', parentSessionId: 'primary', label: 'reviewer', mode: 'continuable' })
    expect(entry().definition).toMatchObject({ band: 'center', priority: 0 })
    expect(text()).toBe('SUBAGENT · F7 switch · F8 close · reviewer ⇄ MAIN')
    expect(badge()).toEqual({ text: 'SUBAGENT', tone: 'primary', styles: ['strong'] })

    conversations.back()
    expect(text()).toBe('MAIN · F7 switch · F8 close ⇄ SUBAGENT · reviewer')
    expect(badge()).toMatchObject({ tone: 'accent' })
    live.delete('child')
    ctx.emit('agent/disposed', { agent: child } as never)
    expect(text()).toBe('MAIN · F7 switch · F8 close ⇄ SUBAGENT · reviewer · reply to resume')
    conversations.back()
    expect(text()).toBe('SUBAGENT · F7 switch · F8 close · reviewer ⇄ MAIN · reply to resume')
    conversations.close()
    expect(entry().node).toBeNull()

    conversations.open({ kind: 'subagent', sessionId: 'cold-once', parentSessionId: 'primary', label: 'once', mode: 'one-shot' })
    expect(text()).toContain('once ⇄ MAIN · read-only')
    conversations.open({ kind: 'btw', sessionId: 'btw', parentSessionId: 'primary', label: 'side' })
    expect(text()).toBe('BTW · F7 switch · F8 close · side ⇄ SUBAGENT · once · 1 more open')
    expect(badge()).toMatchObject({ tone: 'user' })
    await fiber.dispose()
    expect(statuses.list()).toEqual([])
  })
})
