/** Direct queue-pane registry tests.
 * @module @ephemeral-ai/mayfly/interaction/tests/pane-queue
 */

import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as paneQueuePlugin from '../../src/interaction/pane-queue.ts'
import { fakeMayflyContext } from './fakes.ts'

function fakeInbox(nextTurn: UserMessage[] = [], nextStep: UserMessage[] = []) {
  return { nextTurn, nextStep, get hasPending() { return nextTurn.length > 0 || nextStep.length > 0 } }
}

function message(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

async function mount(attached = true, inbox = fakeInbox()) {
  const { ctx } = fakeMayflyContext()
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId('pane-queue-spec'))
  const agent = { id: session.id, session, inbox } as unknown as Agent
  ctx.provide('testSession', { current: attached ? agent : null })
  const fiber = await ctx.plugin(paneQueuePlugin)
  const entry = () => ctx.mayflyPanes.list().find(value => value.id === 'mayfly.pane.queue')
  return { ctx, agent, fiber, entry }
}

describe('mayfly-pane-queue', () => {
  it('registers one ordinary bottom pane and renders null without work', async () => {
    const world = await mount(false)
    expect(world.entry()?.definition).toMatchObject({ placement: 'bottom', priority: 20, narrow: 'bottom' })
    expect(world.entry()?.node).toBeNull()
  })

  it('projects pending turn and step messages as canonical muted rows', async () => {
    const world = await mount(true, fakeInbox(
      [message('first turn'), message('second\nturn')],
      [message('steer this')],
    ))
    expect(world.entry()?.node).toEqual({
      kind: 'stack',
      direction: 'column',
      children: [
        { node: { kind: 'divider' } },
        { node: { kind: 'text', content: 'Queued: first turn', tone: 'muted' } },
        { node: { kind: 'text', content: 'Queued: second turn', tone: 'muted' } },
        { node: { kind: 'text', content: 'Steer: steer this', tone: 'muted' } },
      ],
    })
  })

  it('summarizes image-only messages', async () => {
    const image = { source: { kind: 'user' }, content: [{ type: 'image' }] } as unknown as UserMessage
    const world = await mount(true, fakeInbox([image]))
    expect(world.entry()?.node).toMatchObject({
      children: [
        { node: { kind: 'divider' } },
        { node: { content: 'Queued: [1 image]' } },
      ],
    })
    const images = { source: { kind: 'user' }, content: [{ type: 'text', text: 'caption' }, { type: 'image' }, { type: 'image' }] } as unknown as UserMessage
    const plural = await mount(true, fakeInbox([images]))
    expect(plural.entry()?.node).toMatchObject({ children: [expect.anything(), { node: { content: 'Queued: caption [2 images]' } }] })
  })

  it('excludes internal runtime messages without modifying the native inbox', async () => {
    const policy = createUserMessage({ content: [{ type: 'text', text: 'Policy changed' }], source: { kind: 'plugin', plugin: 'approval' } })
    const inbox = fakeInbox([], [policy])
    const world = await mount(true, inbox)
    expect(world.entry()?.node).toBeNull()
    expect(inbox.nextStep).toEqual([policy])
    inbox.nextTurn.push(message('User work'))
    world.ctx.emit('agent/inbox/inserted', { agent: world.agent } as never)
    expect(world.entry()?.node).toMatchObject({ children: [{ node: { kind: 'divider' } }, { node: { content: 'Queued: User work' } }] })
  })

  it('refreshes only for the exact current Agent inbox', async () => {
    const world = await mount()
    const initial = world.entry()?.revision
    world.ctx.emit('agent/inbox/inserted', { agent: { id: 'other' } } as never)
    world.ctx.emit('agent/inbox/claimed', { agent: { id: 'other' } } as never)
    world.ctx.emit('agent/inbox/discarded', { agent: { id: 'other' } } as never)
    expect(world.entry()?.revision).toBe(initial)
    world.ctx.emit('agent/inbox/inserted', { agent: world.agent } as never)
    world.ctx.emit('agent/inbox/claimed', { agent: world.agent } as never)
    world.ctx.emit('agent/inbox/discarded', { agent: world.agent } as never)
    expect(world.entry()?.revision).toBe((initial ?? 0) + 3)
  })

  it('follows Agent selection and unregisters on unload', async () => {
    const world = await mount(true, fakeInbox([message('old')]))
    ;(world.ctx.get('testSession') as { current: Agent | null }).current = null
    world.ctx.emit('test/session-changed', null)
    expect(world.entry()?.node).toBeNull()
    await world.fiber.dispose()
    expect(world.entry()).toBeUndefined()
  })
})
