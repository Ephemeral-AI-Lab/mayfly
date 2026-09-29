/**
 * Centered status projection of the displayed conversation.
 * @module conversation-view-status
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { MayflyInlineSpan } from '@ephemeral-ai/mayfly-ui'
import { describe, expect, it } from 'vitest'
import { MayflyStatusService, MayflyOverlayService } from '../../../ui/src/services.ts'
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
    const entry = () => statuses.list().find(candidate => candidate.id === 'mayfly.status.scope')!
    const text = () => [entry().node, statuses.list().find(item => item.id === 'mayfly.status.switch')?.node].map(node => (node as { readonly spans: readonly MayflyInlineSpan[] }).spans.map(span => span.text).join('')).join(' · ')
    const badge = () => (entry().node as { readonly spans: readonly MayflyInlineSpan[] }).spans[0]
    expect(entry().node).toBeNull()

    conversations.open({ kind: 'subagent', sessionId: 'child', parentSessionId: 'primary', label: 'reviewer', mode: 'continuable' })
    expect(entry().definition).toMatchObject({ band: 'left', row: 2, priority: 0 })
    expect(statuses.list().find(item => item.id === 'mayfly.status.switch')?.definition).toMatchObject({ band: 'right', row: 2, priority: 1 })
    expect(text()).toBe('SUBAGENT · reviewer ⇄ MAIN · F7 switch · F8 detach')
    expect(badge()).toEqual({ text: 'SUBAGENT', tone: 'primary', styles: ['strong'] })

    conversations.back()
    expect(text()).toBe('MAIN ⇄ SUBAGENT · reviewer · F7 switch · F8 detach')
    expect(badge()).toMatchObject({ tone: 'accent' })
    live.delete('child')
    ctx.emit('agent/disposed', { agent: child } as never)
    expect(text()).toBe('MAIN ⇄ SUBAGENT · reviewer · reply to resume · F7 switch · F8 detach')
    conversations.back()
    expect(text()).toBe('SUBAGENT · reviewer ⇄ MAIN · reply to resume · F7 switch · F8 detach')
    conversations.close()
    expect(entry().node).toBeNull()

    conversations.open({ kind: 'subagent', sessionId: 'cold-once', parentSessionId: 'primary', label: 'once', mode: 'one-shot' })
    expect(text()).toContain('once ⇄ MAIN · read-only')
    conversations.open({ kind: 'btw', sessionId: 'btw', parentSessionId: 'primary', label: 'side' })
    expect(text()).toBe('BTW · side ⇄ SUBAGENT · once · 1 more open · F7 switch · F8 close')
    expect(badge()).toMatchObject({ tone: 'user' })
    await fiber.dispose()
    expect(statuses.list()).toEqual([])
  })
})


it('hides switching shortcuts under a capturing overlay and live-applies the off setting', async () => {
  const ctx = new Context()
  const primary = agent('main')
  const child = agent('child')
  ctx.provide('agents', { get: (id: unknown) => String(id) === 'main' ? primary : child } as never)
  ctx.provide('mayflyKeymap', new FakeKeymap() as never)
  const conversations = new MayflyConversationsService(ctx)
  const statuses = new MayflyStatusService(ctx)
  const overlays = new MayflyOverlayService(ctx)
  let hints = 'full'
  ctx.provide('mayflyInteractionState', { settingsSource: () => ({ keyHints: hints }) } as never)
  conversations.selectPrimary(primary)
  conversations.open({ kind: 'subagent', sessionId: 'child', parentSessionId: 'main', label: 'Reviewer', mode: 'continuable' })
  const fiber = await ctx.plugin(statusPlugin)
  const switching = () => statuses.list().find(entry => entry.id === 'mayfly.status.switch')?.node
  expect(switching()).not.toBeNull()
  const popup = overlays.open({ id: 'modal', capturing: true }, { kind: 'text', content: 'Request' })
  expect(switching()).toBeNull()
  popup.hide()
  expect(switching()).not.toBeNull()
  popup.close()
  hints = 'off'
  ctx.emit('settings/document-updated', 'mayfly' as never)
  expect(statuses.list().every(entry => entry.node === null)).toBe(true)
  await fiber.dispose()
})
