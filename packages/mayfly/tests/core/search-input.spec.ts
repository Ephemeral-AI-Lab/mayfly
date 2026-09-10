/** Native search/editor input through the shared pane and overlay models. */
import { Context } from '@deepseek-ai/cordis'
import { CURSOR_MARKER, stripTerminalSequences, TuiMainScreen } from '@earendil-works/pi-tui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MayflyComponentsService } from '../../src/core/components.ts'
import { SearchInput } from '../../src/core/search-input.ts'
import { compileMayflyUiSurfaceNode, MayflyUiSurfaceRuntime } from '../../src/core/ui-compiler.ts'
import { ui, type MayflyUiNode } from '../../../ui/src/index.ts'
import * as provider from '../../../ui/src/provider.ts'
import * as frontend from '../../src/frontend/index.ts'
import { FakeTheme, KEY } from '../interaction/fakes.ts'
import { FakeTerminal } from './fake-terminal.ts'
import { visibleWidth } from '../../src/core/width.ts'

const contexts: Context[] = []
const flush = () => new Promise<void>(resolve => { setImmediate(resolve) })
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
function display(ctx = new Context()) {
  contexts.push(ctx)
  const theme = new FakeTheme()
  return { theme, components: new MayflyComponentsService(ctx, { theme, tui: new TuiMainScreen(new FakeTerminal()) }) }
}

async function surface(node: MayflyUiNode, kind: 'pane' | 'overlay' = 'overlay', width = 60) {
  const ctx = new Context()
  const { components, theme } = display(ctx)
  await ctx.plugin(provider)
  await ctx.plugin(frontend)
  const onEvent = vi.fn(() => ({ kind: 'completed' as const }))
  if (kind === 'pane') ctx.mayflyPanes.register({ id: 'test', placement: 'bottom', onEvent: { action: onEvent } }, node)
  else ctx.mayflyOverlays.open({ id: 'test', capturing: true, onEvent: { action: onEvent } }, node)
  const model = ctx.mayflyUiInteraction.get(kind, 'test')!
  const runtime = new MayflyUiSurfaceRuntime(model)
  const viewport = { columns: width, rows: 10 }
  const compiled = compileMayflyUiSurfaceNode(model.node, { surfaceRuntime: runtime, components, colors: theme.colors, getViewport: () => viewport, screenMode: 'alternate', emit: event => model.emit(event), onUnhandledEscape: () => model.requestClose() })
  if (!compiled.ok) throw new Error(compiled.message)
  compiled.value.focusTarget!.focused = true
  return { model, runtime, viewport, onEvent, panel: compiled.value.component, input: (data: string) => compiled.value.focusTarget!.handleInput!(data) }
}

describe('SearchInput', () => {
  it('accepts batches and graphemes, removes a whole grapheme, and rejects control input', () => {
    const input = new SearchInput(display().components)
    expect(input.handleInput('中文😀e\u0301')).toBe(true)
    expect(input.text).toBe('中文😀e\u0301')
    input.handleInput('backspace', true)
    expect(input.text).toBe('中文😀')
    for (const key of ['', '\r', '\t', '\x1b[A', '\x00', '\x7f', '\x9b31m']) expect(input.handleInput(key)).toBe(false)
    input.clear()
    expect(input.text).toBe('')
    input.handleInput('\x1b[200~stale')
    input.clear()
    expect(input.pending).toBe(false)
    input.handleInput('\x1b[200~fresh\x1b[201~')
    expect(input.text).toBe('fresh')
  })

  it('buffers split paste endings and normalizes pasted newlines and terminal controls', () => {
    const input = new SearchInput(display().components)
    input.handleInput('\x1b[200~中文\n')
    expect(input.pending).toBe(true)
    expect(input.text).toBe('')
    input.handleInput('😀\r\n\t\x1b[31mred\x1b[0m\x01\x1b[20')
    input.handleInput('1~')
    expect(input.pending).toBe(false)
    expect(input.text).toBe('中文 😀 red')
    input.handleInput('\x1b[200~done\x1b[201~')
    expect(input.text).toBe('中文 😀 reddone')
  })

  it.each(['pane', 'overlay'] as const)('keeps pasted navigation and cancel keys inside the %s search', async kind => {
    const { panel, input, model, onEvent, runtime } = await surface(ui.list({ id: 'search', role: 'browse', filterable: true, selectedIds: [], items: [{ id: 'x', label: '中文😀' }] }), kind)
    input('\x1b[200~')
    input('中文😀')
    input('\x1b[201~')
    await flush()
    expect(panel.render(60).join('\n')).toContain('中文😀')
    expect(model.choice({ pagePath: [], controlId: 'search' })!.query).toBe('中文😀')
    expect(onEvent).not.toHaveBeenCalled()
    input(KEY.escape)
    await flush()
    expect(onEvent).not.toHaveBeenCalled()
    expect(model.disposed).toBe(false)
    runtime.dispose()
  })

  it('accepts a space as part of an active filter', async () => {
    const { panel, input, model, runtime } = await surface(ui.list({ id: 'search', role: 'browse', filterable: true, selectedIds: [], items: [{ id: 'x', label: 'a b' }] }))
    input('a')
    input(' ')
    await flush()
    expect(model.choice({ pagePath: [], controlId: 'search' })!.query).toBe('a ')
    expect(panel.render(60).join('\n')).toContain('a b')
    runtime.dispose()
  })

  it.each([20, 40, 80])('keeps long-label field values visible and delete inside the editor at width %i', async width => {
    const { panel, input, model, viewport, runtime, onEvent } = await surface(ui.stack.column([
      ui.form({ id: 'form', fields: [{ kind: 'input', id: 'key', label: '很长的字段标签 '.repeat(8), value: 'abc' }] }),
      ui.actions({ id: 'entity-actions', items: [{ id: 'delete', label: 'Delete', confirm: 'Delete?' }] }),
    ]), 'overlay', width)
    panel.render(width)
    input('\r')
    input('\x01')
    input('\x1b[3~')
    input('\x04')
    expect(model.form({ pagePath: [], formId: 'form' })!.fields.key!.value).toBe('c')
    const rows = panel.render(width)
    const cursorRows = rows.filter(row => row.includes(CURSOR_MARKER))
    expect(rows.join('').split(CURSOR_MARKER)).toHaveLength(2)
    expect(cursorRows).toHaveLength(1)
    expect(stripTerminalSequences(cursorRows[0]!)).toContain('c')
    expect(rows.every(row => visibleWidth(row) <= width)).toBe(true)
    viewport.rows = 1
    const frame = panel.render(width)
    expect(frame).toHaveLength(1)
    expect(stripTerminalSequences(frame[0]!)).toContain('c')
    expect(frame[0]).toContain(CURSOR_MARKER)
    input(KEY.escape)
    input('\x04')
    await flush()
    expect(onEvent.mock.calls.every(call => (call as unknown as [{ kind: string }])[0].kind !== 'activate')).toBe(true)
    runtime.dispose()
  })
})
