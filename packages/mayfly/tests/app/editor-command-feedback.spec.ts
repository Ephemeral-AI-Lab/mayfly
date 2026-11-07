/** Command outcomes through the actual editor change handler and notification pane. @module */
import { Context } from '@deepseek-ai/cordis'
import { compileMayflyUiNode } from '../../src/core/ui-compiler.ts'
import { MayflyKeymapService } from '../../src/core/keymap.ts'
import type { MayflyScreenService } from '../../src/core/screen.ts'
import * as frontend from '../../src/frontend/index.ts'
import * as uiProvider from '@ephemeral-ai/mayfly-ui/provider'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountRemoteEditor } from '../../src/app/editor.ts'
import { flush, submissionFixture, wire } from './editor-feature-fixture.ts'
import { plain, plainColors } from './render-fixture.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const off of cleanups.splice(0).reverse()) await off(); vi.restoreAllMocks() })

async function fixture() {
  const ctx = new Context()
  await ctx.plugin(uiProvider)
  await ctx.plugin(frontend)
  await ctx.plugin(MayflyKeymapService)
  const host = wire()
  let handle: ReturnType<typeof mountRemoteEditor> | undefined
  const f = submissionFixture(host.selected, undefined, undefined, { set: (...args) => { handle?.notice.set(...args) } })
  vi.spyOn(f.components, 'createEditor').mockReturnValue(f.editor)
  const screen = {
    rows: 24, columns: 80, requestRender: vi.fn(),
    mountDockSlot: () => ({ focus() {}, dispose() {} }),
    setContentScrollHandler: () => () => {},
  } as unknown as MayflyScreenService
  ctx.provide('mayflyScreen', screen)
  handle = mountRemoteEditor(ctx, screen, f.components, plainColors(), { submit() {}, onError() {}, cancel() {}, exit() {} }, () => ({ hostKey: host.selected.ref.host, sessionId: host.selected.ref.sessionId }))
  f.editor.onSubmit = value => { f.submit.submit(value) }
  const rows = (width = 80): string => {
    const node = ctx.mayflyPanes.list().find(pane => pane.id === 'mayfly.pane.notification')!.node!
    const compiled = compileMayflyUiNode(node, { components: f.components, colors: plainColors(), getViewport: () => ({ columns: width, rows: 24 }), screenMode: 'alternate', emit() {} })
    if (!compiled.ok) throw new Error(compiled.message)
    return plain(compiled.value.component.render(width)).join('\n')
  }
  cleanups.push(async () => { f.submit.dispose(); handle!.dispose(); await ctx.fiber.dispose() })
  return { ...f, ctx, host, rows }
}

describe('command notification and draft admission', () => {
  it('consumes an executed local parser error and preserves its exact visible native feedback', async () => {
    const f = await fixture()
    f.local.list = () => [{ name: 'agents', description: 'Browse agents' }]
    f.local.execute = async () => { throw new Error('usage: /agents [stop <id>]') }
    f.enter('/agents stop'); await flush()
    expect(f.editor.getText()).toBe('')
    expect(f.editor.getHistory()).toContain('/agents stop')
    expect(f.rows()).toContain('✗ usage: /agents [stop <id>]')
    expect(f.rows(40)).toContain('usage: /agents')
    expect(f.ctx.mayflyUiInteraction.notificationSnapshot()).toContainEqual(expect.objectContaining({ severity: 'error', message: 'usage: /agents [stop <id>]' }))
    f.editor.setText('new draft')
    expect(f.ctx.mayflyUiInteraction.notificationSnapshot()).toEqual([])
  })

  it.each(['success', 'error'] as const)('consumes an admitted native %s outcome with reference severity', async kind => {
    const f = await fixture()
    f.host.executeCommand.mockResolvedValueOnce({ ok: true, value: { result: { kind, text: 'native command result' } } } as never)
    f.enter('/host-only'); await flush()
    expect(f.editor.getText()).toBe('')
    expect(f.ctx.mayflyUiInteraction.notificationSnapshot()).toContainEqual(expect.objectContaining({ severity: kind === 'error' ? 'error' : 'info', message: 'native command result' }))
    expect(f.rows()).toContain('native command result')
  })

  it('restores a pre-admission attachment refusal before publishing its visible error', async () => {
    const f = await fixture()
    f.local.list = () => [{ name: 'model', description: 'Choose model' }]
    f.local.execute = () => ({ kind: 'error', text: '/model does not accept attachments; no command was sent' })
    const marker = f.file()
    const source = `/model ${marker}`
    f.enter(source); await flush()
    expect(f.editor.getText()).toBe(source)
    expect(f.editor.getHistory()).not.toContain(source)
    expect(f.attachments.capture(marker).content).toEqual([{ type: 'file', receiptId: 'receipt-1' }])
    expect(f.rows()).toContain('/model does not accept attachments')
    expect(f.ctx.mayflyUiInteraction.notificationSnapshot()).toContainEqual(expect.objectContaining({ severity: 'error', message: '/model does not accept attachments; no command was sent' }))
  })

  it('restores an unconfirmed transport failure before reporting it and keeps successful goal text quiet', async () => {
    const f = await fixture()
    f.host.executeCommand.mockRejectedValueOnce(new Error('command wire closed'))
    f.enter('/host-only'); await flush()
    expect(f.editor.getText()).toBe('/host-only')
    expect(f.rows()).toContain('command wire closed')
    expect(f.ctx.mayflyUiInteraction.notificationSnapshot()).toContainEqual(expect.objectContaining({ severity: 'error' }))
    f.enter('/goal status'); await flush()
    expect(f.editor.getText()).toBe('')
    expect(f.ctx.mayflyUiInteraction.notificationSnapshot()).toEqual([])
  })

  it.each(['abort', 'selection'] as const)('suppresses a rejected local command after %s retirement', async reason => {
    const f = await fixture()
    const pending = Promise.withResolvers<never>()
    f.local.list = () => [{ name: 'agents', description: 'Browse agents' }]
    f.local.execute = () => pending.promise
    const signal = new AbortController()
    const command = f.commands.execute('/agents', [], signal.signal)
    if (reason === 'abort') signal.abort()
    else f.select(wire('other').selected)
    pending.reject(new Error('late parser failure'))
    expect(await command).toEqual({ handled: true, exit: false, accepted: false })
    expect(f.ctx.mayflyUiInteraction.notificationSnapshot()).toEqual([])
  })
})
