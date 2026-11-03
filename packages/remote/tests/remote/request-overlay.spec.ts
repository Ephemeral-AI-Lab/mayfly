/** Real UI registration/acknowledgement boundaries for Remote native request overlays. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ui, type MayflyUiActionEvent, type MayflyUiEventContext } from '@ephemeral-ai/mayfly-ui'
import { requestOverlay } from '../../src/remote/interactions/request-overlay.ts'
import { questionFixture } from './question-feature-fixture.ts'

type Fixture = Awaited<ReturnType<typeof questionFixture>>
type Options = Parameters<typeof requestOverlay<string>>[1]
const fixtures: Fixture[] = []
afterEach(async () => { for (const f of fixtures.splice(0).reverse()) await f.cleanup(); vi.restoreAllMocks() })
async function fixture() { const f = await questionFixture(); fixtures.push(f); return f }
const event: MayflyUiActionEvent = { kind: 'activate', pagePath: [], controlId: 'actions', actionId: 'answer' }
function open(f: Fixture, extra: Partial<Options> = {}) {
  return requestOverlay<string>(f.ctx, {
    id: 'request-test', title: 'Questions', scope: { kind: 'session', sessionId: 'same-session' },
    isCurrent: () => true, subscribeLocale: callback => { f.locales.add(callback); return () => { f.locales.delete(callback) } },
    view: () => ui.text('Question draft'), answer: () => 'native answer', cancelled: reason => reason,
    ...extra,
  })
}
function prepare(f: Fixture, operationId = 'answer', signal = new AbortController().signal, action = event) {
  const entry = f.ctx.mayflyOverlays.list().find(row => row.id === 'request-test')!
  const context: MayflyUiEventContext = { surfaceId: entry.id, revision: entry.revision, source: entry.source, operationId, signal, report: vi.fn() }
  return entry.events.prepare(action, context)
}

describe('Remote acknowledged request overlay lifecycle', () => {
  it('keeps early-aborted and stale handles safe to cancel, refresh, and reveal without opening UI', async () => {
    const f = await fixture()
    const aborted = open(f, { signal: AbortSignal.abort() })
    aborted.refresh(); aborted.reveal(); aborted.cancel()
    await expect(aborted.result).resolves.toBe('abort')
    const stale = open(f, { isCurrent: () => false })
    stale.refresh(); stale.reveal(); stale.cancel()
    await expect(stale.result).resolves.toBe('stale')
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
  })

  it('wraps the goal-style editor once, preserves its source on accepted publication, and retires locale ownership', async () => {
    const f = await fixture()
    const overlay = open(f)
    expect(f.ctx.mayflyOverlays.list()[0]?.node).toMatchObject({ kind: 'surface', title: 'Questions', child: ui.text('Question draft') })
    for (const refresh of f.locales) refresh()
    const answer = await prepare(f)
    expect(answer.reply).toMatchObject({ kind: 'accepted', source: [{ resourceId: 'request-test', revision: 1 }] })
    expect(answer.publish()).toBe(true)
    await expect(overlay.result).resolves.toBe('native answer')
    overlay.refresh(); overlay.reveal(); overlay.cancel()
    expect(f.locales.size).toBe(0)
  })

  it('admits one candidate at a time and permits a new explicit answer after its prepared operation is aborted', async () => {
    const f = await fixture()
    const overlay = open(f)
    const abort = new AbortController()
    const first = await prepare(f, 'first', abort.signal)
    expect(first.reply?.kind).toBe('accepted')
    const duplicate = await prepare(f, 'duplicate')
    expect(duplicate.reply?.kind).toBe('cancelled')
    abort.abort()
    expect(first.publish()).toBe(false)
    const replacement = await prepare(f, 'replacement')
    replacement.publish()
    await expect(overlay.result).resolves.toBe('native answer')
  })

  it('fences a native acknowledgement when an earlier actual registry observer retires its selected scope', async () => {
    const f = await fixture()
    let current = true
    const off = f.ctx.mayflyOverlays.subscribe(delta => { if (delta.kind === 'upsert' && delta.entry.update.reason === 'ack') current = false })
    const overlay = open(f, { isCurrent: () => current })
    const answer = await prepare(f)
    answer.publish()
    await expect(overlay.result).resolves.toBe('stale')
    off()
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
  })

  it.each(['abort', 'stale'] as const)('rechecks a synchronous %s triggered by closing an acknowledged overlay', async mode => {
    const f = await fixture()
    const abort = new AbortController()
    let current = true
    const off = f.ctx.mayflyOverlays.subscribe(delta => {
      if (delta.kind !== 'remove') return
      if (mode === 'abort') abort.abort()
      else current = false
    })
    const overlay = open(f, { signal: abort.signal, isCurrent: () => current })
    const answer = await prepare(f)
    answer.publish()
    await expect(overlay.result).resolves.toBe(mode)
    off()
  })

  it('handles native abort during the actual initial registry publication before its listener is installed', async () => {
    const f = await fixture()
    const abort = new AbortController()
    const off = f.ctx.mayflyOverlays.subscribe(delta => { if (delta.kind === 'upsert' && delta.entry.id === 'request-test') abort.abort() })
    const overlay = open(f, { signal: abort.signal })
    await expect(overlay.result).resolves.toBe('abort')
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
    expect(f.locales.size).toBe(0)
    off()
  })

  it('settles external registry closure as unload and never publishes its prepared answer afterward', async () => {
    const f = await fixture()
    const overlay = open(f)
    const answer = await prepare(f)
    expect(f.ctx.mayflyOverlays.close('request-test')).toBe(true)
    await expect(overlay.result).resolves.toBe('unload')
    expect(answer.publish()).toBe(false)
  })

  it('preserves non-answer completion and frames content changes while leaving an explicit surface intact', async () => {
    const f = await fixture()
    const content = open(f, { answer: () => undefined, onAction: async () => ({ kind: 'conflict', source: [], message: 'Review the new question', node: ui.text('New question') }) })
    const replacement = await prepare(f)
    expect(replacement.reply).toMatchObject({ kind: 'conflict', node: { kind: 'surface', title: 'Questions', child: ui.text('New question') } })
    replacement.publish()
    content.cancel()
    await content.result
    const node = { kind: 'surface', title: 'Explicit question', child: ui.text('Already framed') } as const
    const framed = open(f, { answer: () => undefined, onAction: async () => ({ kind: 'conflict', source: [], message: 'Review the new question', node }) })
    expect((await prepare(f)).reply).toMatchObject({ node })
    framed.cancel()
    await framed.result
    const blank = open(f, { answer: () => undefined })
    expect((await prepare(f)).reply).toEqual({ kind: 'completed' })
    blank.cancel()
    await blank.result
  })
})
