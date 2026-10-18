/**
 * `mayfly-status-basic-model` plugin: the baseline model-name entry. Covers the
 * model-source preference order (native `modelSelection.next` →
 * `lastUsed` → request header → options.model → 'no model'), the immediate
 * refresh on a committed `/model` pick and the foreign-session guard, the
 * no-session empty render, the `text` color tier, session-change rebinding, and
 * the shedding/truncation widths.
 */

import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import * as basic from '../../src/transcript/status-basic-model.ts'
import { SHED } from '../../src/transcript/status-shed.ts'
import { userEvent } from './helpers.ts'
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

  it('falls back to options.model, then the placeholder', async () => {
    const fromModel = await bootStatusPlugin(basic, fakeAgent([], { model: 'deepseek-chat' }))
    expect(fromModel.entry.render(80)).toBe('deepseek-chat')
    await fromModel.dispose()

    // A provider without a selected model names no model; the native
    // selection projection is the domain source now.
    const fromProvider = await bootStatusPlugin(basic, fakeAgent([], { provider: 'deepseek' }))
    expect(fromProvider.entry.render(80)).toBe('no model')
    await fromProvider.dispose()

    const placeholder = await bootStatusPlugin(basic, fakeAgent([]))
    expect(placeholder.entry.render(80)).toBe('no model')
    await placeholder.dispose()
  })

  it('renders in the full text tier, the footer\'s brightest anchor', async () => {
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

    ctx.emit('session/event', first.session as unknown as Session, userEvent('old'))
    expect(entry.render(80)).toBe('second-model')
    await dispose()
  })

  it('flips immediately on a committed selection, before any request fires', async () => {
    const agent = fakeAgent([], { model: 'boot-model', headerModel: 'header-model' })
    const harness = await bootStatusPlugin(basic, agent)
    expect(harness.entry.render(80)).toBe('header-model')
    // A committed `/model` pick updates the projection's `next` view without
    // any request/header event; the row must follow at once.
    harness.setModelSelection(agent.session, { next: { provider: 'deepseek', model: 'switched-model' }, lastUsed: { provider: 'deepseek', model: 'old-model' } })
    expect(harness.entry.render(80)).toBe('deepseek/switched-model')
    await harness.dispose()
  })

  it('falls back to lastUsed when no next selection is pending', async () => {
    const agent = fakeAgent([], { model: 'boot-model' })
    const harness = await bootStatusPlugin(basic, agent)
    expect(harness.entry.render(80)).toBe('boot-model')
    harness.setModelSelection(agent.session, { next: null, lastUsed: { provider: 'deepseek', model: 'used-model', reasoningEffort: 'high' } })
    expect(harness.entry.render(80)).toBe('deepseek/used-model High')
    await harness.dispose()
  })

  it('reads the model-selection snapshot only when the session or its selection changes', async () => {
    const agent = fakeAgent([], { model: 'boot-model' })
    let snapshots = 0
    let notify: ((session: unknown, key: string, value: unknown, seq: number) => void) | undefined
    const harness = await bootStatusPlugin(basic, agent, {
      services: {
        sessionProjections: {
          snapshot: () => {
            snapshots += 1
            return { asOfSeq: 0, values: { modelSelection: { next: { provider: 'deepseek', model: 'snap-model' } } } }
          },
          onChanged(listener: (session: unknown, key: string, value: unknown, seq: number) => void) {
            notify = listener
            return () => { notify = undefined }
          },
        },
      },
    })
    expect(harness.entry.render(80)).toBe('deepseek/snap-model')
    expect(snapshots).toBe(1)
    // Every facts delta asks for the row again; the projection snapshot is not re-read.
    harness.ctx.emit('session/event', agent.session as unknown as Session, userEvent('hi'))
    expect(harness.entry.render(80)).toBe('deepseek/snap-model')
    expect(snapshots).toBe(1)
    // The change feed carries the parsed value itself.
    notify!(agent.session, 'modelSelection', { next: { provider: 'deepseek', model: 'changed-model' } }, 2)
    expect(harness.entry.render(80)).toBe('deepseek/changed-model')
    expect(snapshots).toBe(1)
    await harness.dispose()
  })

  it('appends the capitalized effort of a committed selection', async () => {
    const agent = fakeAgent([], { model: 'boot-model', headerModel: 'header-model' })
    const harness = await bootStatusPlugin(basic, agent)
    harness.setModelSelection(agent.session, { next: { provider: 'deepseek', model: 'step-5-preview', reasoningEffort: 'max' }, lastUsed: null })
    expect(harness.entry.render(80)).toBe('deepseek/step-5-preview Max')
    // An explicit 'off' is a selection too, not the provider default.
    harness.setModelSelection(agent.session, { next: { provider: 'deepseek', model: 'step-5-preview', reasoningEffort: 'off' }, lastUsed: null })
    expect(harness.entry.render(80)).toBe('deepseek/step-5-preview Off')
    await harness.dispose()
  })

  it('drops the suffix when the next selection restores the provider default', async () => {
    const agent = fakeAgent([], { headerModel: 'header-model', headerEffort: 'high' })
    const harness = await bootStatusPlugin(basic, agent)
    expect(harness.entry.render(80)).toBe('header-model High')
    // `/model <id>` commits without an effort; the stale header level must
    // not bleed into the new model's row.
    harness.setModelSelection(agent.session, { next: { provider: 'deepseek', model: 'fresh-model' }, lastUsed: null })
    expect(harness.entry.render(80)).toBe('deepseek/fresh-model')
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

  it('ignores model-selection commits from other sessions and a null next/lastUsed', async () => {
    const agent = fakeAgent([], { model: 'boot-model' })
    const harness = await bootStatusPlugin(basic, agent)
    const other = fakeAgent([])
    harness.setModelSelection(other.session, { next: { provider: 'deepseek', model: 'other-model' }, lastUsed: null })
    expect(harness.entry.render(80)).toBe('boot-model')
    // No selection at all falls through the projection source to the header/options chain.
    harness.setModelSelection(agent.session, { next: null, lastUsed: null })
    expect(harness.entry.render(80)).toBe('boot-model')
    await harness.dispose()
  })

  it('truncates to the offered width budget', async () => {
    const harness = await bootStatusPlugin(basic, fakeAgent([], { model: 'a-very-long-model-name' }))
    expect(harness.entry.render(10)).toBe('a-very-lon')
    await harness.dispose()
  })

  it('unregisters the entry when the fiber unloads', async () => {
    const harness = await bootStatusPlugin(basic, fakeAgent([], { model: 'm' }))
    expect(harness.models.list()).toHaveLength(1)
    await harness.dispose()
    expect(harness.models.list()).toHaveLength(0)
  })

  it('sheds the provider, then the thinking level, then the model itself, as the row narrows', async () => {
    const agent = fakeAgent([])
    const harness = await bootStatusPlugin(basic, agent)
    harness.setModelSelection(agent.session, { next: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' }, lastUsed: null })
    const node = harness.models.list().find(model => model.id === 'mayfly.status.basic')!.node
    expect(node).toMatchObject({ kind: 'shed' })
    const forms = (node as unknown as { readonly narrower: readonly { readonly rank: number, readonly node: { readonly content: string } | null }[] }).narrower
    expect(forms.map(form => [form.rank, form.node === null ? null : form.node.content])).toEqual([[SHED.provider, 'deepseek-v4 High'], [SHED.effort, 'deepseek-v4'], [SHED.model, null]])
    expect(harness.entry.render(80)).toBe('deepseek/deepseek-v4 High')
    // The model is the row's anchor: it overflows by truncation and is the last thing given up.
    expect(harness.models.list().find(model => model.id === 'mayfly.status.basic')!.definition).toMatchObject({ priority: 0, overflow: 'truncate' })
    await harness.dispose()
  })
})

describe('default model before a session', () => {
  it('reads the saved default model and its effort when no Agent is attached', async () => {
    const withEffort = await bootStatusPlugin(basic, null, { services: { agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'saved-model', reasoningEffort: 'max' }) } } })
    expect(withEffort.entry.render(80)).toBe('deepseek/saved-model Max')
    await withEffort.dispose()

    const bare = await bootStatusPlugin(basic, null, { services: { agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'saved-model' }) } } })
    expect(bare.entry.render(80)).toBe('deepseek/saved-model')
    await bare.dispose()

    const absent = await bootStatusPlugin(basic, null, { services: { agentDefaultModel: { currentSelection: () => undefined } } })
    expect(absent.entry.render(80)).toBe('')
    await absent.dispose()
  })
})
