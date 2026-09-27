/**
 * `mayfly-status-basic-model` plugin: the baseline model-name entry. Covers the
 * model-source preference order (projected next selection → request header →
 * options.model → options.provider → 'no model'), the immediate refresh on a
 * committed `/model` pick and the foreign-session guard, the no-session empty
 * render, the `text` color tier, session-change rebinding, and the
 * `session/event` re-derivation that picks up the first request header.
 */

import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import * as basic from '../../src/transcript/status-basic-model.ts'
import { event, userEvent } from './helpers.ts'
import { asAgent, bootStatusPlugin, COLORS, fakeAgent } from './status-fakes.ts'

describe('mayfly-status-basic-model', () => {
  it('renders nothing without an attached agent', async () => {
    const harness = await bootStatusPlugin(basic)
    expect(harness.entry.render(80)).toBe('')
    expect(harness.entry.id).toBe('')
    expect(harness.entry.priority).toBe(0)
    // Events arriving before any session attaches leave the entry empty.
    const stray = fakeAgent([])
    harness.ctx.emit('session/event', stray.session as unknown as Session, userEvent('early'))
    expect(harness.entry.render(80)).toBe('')
    await harness.dispose()
  })

  it('prefers the request header model over agent options', async () => {
    const agent = fakeAgent([], { model: 'options-model', headerModel: 'header-model' })
    const harness = await bootStatusPlugin(basic, agent)
    expect(harness.entry.render(80)).toBe('header-model')
    await harness.dispose()
  })

  it('falls back to options.model, then provider, then the placeholder', async () => {
    const fromModel = await bootStatusPlugin(basic, fakeAgent([], { model: 'deepseek-chat' }))
    expect(fromModel.entry.render(80)).toBe('deepseek-chat')
    await fromModel.dispose()

    const fromProvider = await bootStatusPlugin(basic, fakeAgent([], { provider: 'deepseek' }))
    expect(fromProvider.entry.render(80)).toBe('deepseek')
    await fromProvider.dispose()

    const placeholder = await bootStatusPlugin(basic, fakeAgent([]))
    expect(placeholder.entry.render(80)).toBe('no model')
    await placeholder.dispose()
  })

  it('renders in the full text tier, the footer’s brightest anchor', async () => {
    const text = (body: string): string => `[T]${body}[/T]`
    const harness = await bootStatusPlugin(
      basic,
      fakeAgent([], { model: 'm' }),
      { colors: { ...COLORS, text } },
    )
    expect(harness.entry.render(80)).toBe('[T]m[/T]')
    await harness.dispose()
  })

  it('rebinds on test/session-changed and ignores the old agent afterwards', async () => {
    const first = fakeAgent([], { model: 'first-model' })
    const { ctx, entry, dispose } = await bootStatusPlugin(basic, first)
    expect(entry.render(80)).toBe('first-model')

    const second = fakeAgent([], { model: 'second-model' })
    ctx.emit('test/session-changed', asAgent(second))
    expect(entry.render(80)).toBe('second-model')

    first.status = 'running'
    ctx.emit('session/event', first.session as unknown as Session, userEvent('old'))
    expect(entry.render(80)).toBe('second-model')
    await dispose()
  })

  it('re-derives the model when the first request header lands', async () => {
    const agent = fakeAgent([], { model: 'boot-model' })
    const { ctx, entry, dispose } = await bootStatusPlugin(basic, agent)
    expect(entry.render(80)).toBe('boot-model')

    // An event on another session does not touch the entry.
    const other = fakeAgent([])
    ctx.emit('session/event', other.session as unknown as Session, userEvent('foreign'))
    expect(entry.render(80)).toBe('boot-model')

    // The loop logs the first request/header snapshot inside its step; the
    // next session event re-derives the model from it.
    agent.session.requestHeader = () => ({ config: { model: 'header-model' } })
    ctx.emit('session/event', agent.session as unknown as Session, userEvent('hi'))
    expect(entry.render(80)).toBe('header-model')
    await dispose()
  })

  it('flips immediately when a model selection commits, before any request fires', async () => {
    const agent = fakeAgent([], { model: 'boot-model', headerModel: 'header-model' })
    const harness = await bootStatusPlugin(basic, agent)
    expect(harness.entry.render(80)).toBe('header-model')
    // A committed `/model` pick updates the projection's `next` view without
    // any request/header event; the row must follow at once.
    harness.setModelSelection(agent.session, { next: { provider: 'deepseek', model: 'switched-model' } })
    expect(harness.entry.render(80)).toBe('switched-model')
    await harness.dispose()
  })

  it('appends the capitalized effort of a committed selection', async () => {
    const agent = fakeAgent([], { model: 'boot-model', headerModel: 'header-model' })
    const harness = await bootStatusPlugin(basic, agent)
    harness.setModelSelection(agent.session, { next: { provider: 'deepseek', model: 'step-5-preview', reasoningEffort: 'max' } })
    expect(harness.entry.render(80)).toBe('step-5-preview Max')
    // An explicit 'off' is a selection too, not the provider default.
    harness.setModelSelection(agent.session, { next: { provider: 'deepseek', model: 'step-5-preview', reasoningEffort: 'off' } })
    expect(harness.entry.render(80)).toBe('step-5-preview Off')
    await harness.dispose()
  })

  it('drops the suffix when the next selection restores the provider default', async () => {
    const agent = fakeAgent([], { headerModel: 'header-model', headerEffort: 'high' })
    const harness = await bootStatusPlugin(basic, agent)
    expect(harness.entry.render(80)).toBe('header-model High')
    // `/model <id>` commits without an effort; the stale header level must
    // not bleed into the new model's row.
    harness.setModelSelection(agent.session, { next: { provider: 'deepseek', model: 'fresh-model' } })
    expect(harness.entry.render(80)).toBe('fresh-model')
    await harness.dispose()
  })

  it('pairs the request-header effort with its own model, before any projection', async () => {
    const harness = await bootStatusPlugin(basic, fakeAgent([], { headerModel: 'header-model', headerEffort: 'max' }))
    expect(harness.entry.render(80)).toBe('header-model Max')
    await harness.dispose()
  })

  it('pairs the options effort with options.model', async () => {
    const harness = await bootStatusPlugin(basic, fakeAgent([], { model: 'deepseek-chat', effort: 'low' }))
    expect(harness.entry.render(80)).toBe('deepseek-chat Low')
    await harness.dispose()
  })

  it('reads the effort folded from a request/header event', async () => {
    const agent = fakeAgent([])
    const { ctx, entry, dispose } = await bootStatusPlugin(basic, agent)
    expect(entry.render(80)).toBe('no model')
    ctx.emit('session/event', agent.session as unknown as Session, event('request/header', {
      header: { config: { provider: 'deepseek', model: 'event-model', reasoningEffort: 'high' } },
    }))
    expect(entry.render(80)).toBe('event-model High')
    await dispose()
  })

  it('ignores model-selection commits from other sessions and a null next', async () => {
    const agent = fakeAgent([], { model: 'boot-model' })
    const harness = await bootStatusPlugin(basic, agent)
    const other = fakeAgent([])
    harness.setModelSelection(other.session, { next: { provider: 'deepseek', model: 'other-model' } })
    expect(harness.entry.render(80)).toBe('boot-model')
    // A selection with no `next` (nothing pending or used) falls through the
    // projection source to the ordinary chain.
    harness.setModelSelection(agent.session, { next: null })
    expect(harness.entry.render(80)).toBe('boot-model')
    await harness.dispose()
  })

  it('truncates to the offered width budget', async () => {
    const agent = fakeAgent([], { model: 'a-very-long-model-name' })
    const harness = await bootStatusPlugin(basic, agent)
    expect(harness.entry.render(10)).toBe('a-very-lon')
    await harness.dispose()
  })

  it('unregisters the entry when the fiber unloads', async () => {
    const harness = await bootStatusPlugin(basic, fakeAgent([], { model: 'm' }))
    expect(harness.models.list()).toHaveLength(1)
    await harness.dispose()
    expect(harness.models.list()).toHaveLength(0)
  })
})
