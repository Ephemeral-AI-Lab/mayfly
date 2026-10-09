/** The prompt's keys, events, and hint row in every state: idle, tokens, recall, completions, a paste, and a republish. */
import { CURSOR_MARKER } from '@earendil-works/pi-tui'
import { afterEach, describe, expect, it } from 'vitest'
import { ui, type MayflyPromptNode, type MayflyUiEvent, type MayflyUiNode } from '../../../ui/src/index.ts'
import { createRealSurface, parityComponents, type RealSurface } from '../design/parity.ts'
import { MayflyUiSurfaceRuntime, compileMayflyUiSurfaceNode } from '../../src/core/ui-compiler.ts'
import { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import { PROBE_PALETTE } from '../design/parity.ts'

const plain = (text: string): string => text.replaceAll(CURSOR_MARKER, '').replace(/\x1b\[[0-9;]*m/gu, '')
const KEY = { up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', enter: '\r', esc: '\x1b', tab: '\t', backspace: '\x7f', altEnter: '\x1b\r', ctrlJ: '\n', ctrlC: '\x03', paste: '\x1b[200~', pasteEnd: '\x1b[201~' } as const
const TOKENS = [{ id: 't1', label: 'Image #1', size: '84 KB' }, { id: 't2', label: 'notes.md', size: '2 KB' }]
const RECALL = [{ kind: 'queued', text: 'also update the footer' }, { kind: 'history', text: 'run the width scan again' }, { kind: 'history', text: 'bump the changelog too' }] as const
const ITEMS = [{ id: 'c1', label: '/model', detail: 'switch model' }, { id: 'c2', label: '/sessions' }, { id: 'c3', label: '/trace' }]

const surfaces: RealSurface[] = []
afterEach(() => { for (const surface of surfaces.splice(0)) surface.dispose() })

function open(prompt: Omit<MayflyPromptNode, 'kind' | 'id'> = {}, width = 100, extra: readonly MayflyUiNode[] = []) {
  const events: MayflyUiEvent[] = []
  const node = ui.surface({ title: 'Prompt', chrome: 'surface', child: ui.stack.column([ui.prompt({ id: 'p', autofocus: true, ...prompt }), ...extra]) })
  const surface = createRealSurface(node, width, { components: parityComponents(), events: event => events.push(event), overrides: { onUnhandledEscape: () => {}, escapeHint: 'close' } })
  surfaces.push(surface)
  const rows = (): string[] => surface.render().map(plain)
  const inside = (): string[] => rows().slice(1, -1).map(row => row.replace(/^│ ?| ?│$/gu, '').trimEnd())
  const hint = (): string => (inside().at(-1) ?? '').trim()
  const press = (...keys: string[]): void => { for (const key of keys) surface.press(key) }
  const type = (text: string): void => { press(...text) }
  return { surface, events, rows, inside, hint, press, type }
}
const kinds = (events: readonly MayflyUiEvent[]): string[] => events.map(event => event.kind)

describe('the hint row of a prompt', () => {
  it('names Enter and the newline key, and Esc to leave', () => {
    expect(open().hint()).toBe('Enter send · Alt+Enter newline · Esc close')
    expect(open({ submitLabel: 'queue' }).hint()).toBe('Enter queue · Alt+Enter newline · Esc close')
  })

  it('names the recall pair while ↑/↓ walk it, and drops it once the buffer holds text of its own', () => {
    const prompt = open({ recall: RECALL })
    expect(prompt.hint()).toBe('↑/↓ history · Enter send · Alt+Enter newline · Esc close')
    prompt.type('hi')
    expect(prompt.hint()).toBe('Enter send · Alt+Enter newline · Esc close')
    const walking = open({ recall: RECALL })
    walking.press(KEY.up)
    expect(walking.hint()).toBe('↑/↓ history · Enter send · Alt+Enter newline · Esc close')
    expect(open({ recall: RECALL, recallLabel: 'earlier' }).hint()).toBe('↑/↓ earlier · Enter send · Alt+Enter newline · Esc close')
  })

  it('shows three fragments below 80 columns, keeping Enter, the arrows, and Esc', () => {
    expect(open({ recall: RECALL }, 60).hint()).toBe('↑/↓ history · Enter send · Esc close')
  })

  it('reads the completion keys while the list is open, and the ordinary ones after Esc closes it', () => {
    const prompt = open({ completions: { items: ITEMS }, value: '/' })
    expect(prompt.hint()).toBe('↑/↓ options · Tab complete · Enter insert · Esc close')
    expect(open({ completions: { items: ITEMS }, value: '/' }, 60).hint()).toBe('Tab complete · Enter insert · Esc close')
    prompt.press(KEY.esc)
    expect(prompt.hint()).toBe('Enter send · Alt+Enter newline · Esc close')
  })

  it('draws no hint in the middle of a paste', () => {
    const prompt = open({})
    prompt.press(`${KEY.paste}first chunk`)
    expect(prompt.rows().join('\n')).not.toContain('Enter send')
    prompt.press(`last${KEY.pasteEnd}`)
    expect(prompt.hint()).toBe('Enter send · Alt+Enter newline · Esc close')
  })
})

describe('typing and the draft', () => {
  it('reports each edit as a value change on the prompt\'s own form', () => {
    const prompt = open()
    prompt.type('hi')
    expect(prompt.inside()[0]).toBe('> hi')
    expect(prompt.events).toMatchObject([
      { kind: 'value-change', controlId: 'text', formId: 'p', value: 'h', draftRevision: 1 },
      { kind: 'value-change', controlId: 'text', formId: 'p', value: 'hi', draftRevision: 2 },
    ])
  })

  it('inserts a line break with Alt+Enter and Ctrl+J, and then ↑/↓ belong to the buffer', () => {
    const prompt = open({ recall: RECALL })
    prompt.type('a')
    prompt.press(KEY.altEnter)
    prompt.type('b')
    prompt.press(KEY.ctrlJ)
    prompt.type('c')
    expect(prompt.events.at(-1)).toMatchObject({ kind: 'value-change', value: 'a\nb\nc' })
    // The buffer holds text, so ↑ is the editor's and no recall walk starts.
    prompt.press(KEY.up)
    expect(kinds(prompt.events)).not.toContain('recall-change')
  })

  it('keeps a lone Enter or Backspace inside a paste as text', () => {
    const prompt = open({ tokens: TOKENS })
    prompt.press(`${KEY.paste}a`, KEY.enter, KEY.backspace, `b${KEY.pasteEnd}`)
    expect(kinds(prompt.events)).not.toContain('submit')
    expect(kinds(prompt.events)).not.toContain('token-remove')
  })
})

describe('submitting', () => {
  it('sends the text and the token ids as one form addressed by the prompt, then clears the draft', () => {
    const prompt = open({ tokens: TOKENS })
    prompt.type('explain')
    prompt.events.length = 0
    prompt.press(KEY.enter)
    expect(prompt.events).toMatchObject([{
      kind: 'submit', controlId: 'p',
      submission: { actionId: 'p', forms: [{ formId: 'p', fields: [{ id: 'text', change: 'set', value: 'explain' }, { id: 'tokens', change: 'set', value: ['t1', 't2'] }] }] },
    }, { kind: 'value-change' }].slice(0, 1))
    expect(prompt.inside()[0]).toContain('[Image #1 84 KB ×] [notes.md 2 KB ×]')
    expect(prompt.inside()[0]).not.toContain('explain')
  })

  it('sends nothing for an empty draft without tokens, and tokens alone are a submission', () => {
    const empty = open()
    empty.press(KEY.enter)
    expect(empty.events).toEqual([])
    const tokens = open({ tokens: TOKENS })
    tokens.press(KEY.enter)
    expect(tokens.events).toMatchObject([{ kind: 'submit', submission: { forms: [{ fields: [{ value: '' }, { value: ['t1', 't2'] }] }] } }])
  })
})

describe('the two-step Backspace on an empty buffer', () => {
  it('selects the last token, then removes it', () => {
    const prompt = open({ tokens: TOKENS })
    prompt.press(KEY.backspace)
    expect(prompt.events).toEqual([])
    expect(prompt.surface.render().join('\n')).toContain('\x1b[7m[notes.md 2 KB ×]\x1b[0m')
    prompt.press(KEY.backspace)
    expect(prompt.events).toMatchObject([{ kind: 'token-remove', controlId: 'p', tokenId: 't2' }])
    expect(prompt.surface.render().join('\n')).not.toContain('\x1b[7m[notes')
  })

  it('lets any other key deselect the token first', () => {
    const prompt = open({ tokens: TOKENS })
    prompt.press(KEY.backspace, KEY.left, KEY.backspace)
    expect(prompt.events).toEqual([])
    expect(prompt.surface.render().join('\n')).toContain('\x1b[7m[notes.md 2 KB ×]\x1b[0m')
    prompt.type('x')
    expect(prompt.surface.render().join('\n')).not.toContain('\x1b[7m[notes')
  })

  it('edits the buffer when it holds text, and does nothing without tokens', () => {
    const typed = open({ tokens: TOKENS })
    typed.type('ab')
    typed.press(KEY.backspace)
    expect(kinds(typed.events)).not.toContain('token-remove')
    expect(typed.surface.render().join('\n')).not.toContain('\x1b[7m[notes')
    const none = open()
    none.press(KEY.backspace)
    expect(none.events).toEqual([])
  })
})

describe('the recall walk', () => {
  it('walks queued messages first, then history, newest first, and ↓ restores the draft', () => {
    const prompt = open({ recall: RECALL })
    prompt.press(KEY.up)
    expect(prompt.inside()[0]).toContain('also update the footer')
    expect(prompt.inside()[0]).toContain('↑ queued 1/3')
    prompt.press(KEY.up)
    expect(prompt.inside()[0]).toContain('run the width scan again')
    expect(prompt.inside()[0]).toContain('↑ history 2/3')
    prompt.press(KEY.down, KEY.down)
    expect(prompt.inside()[0]).not.toContain('↑')
    expect(prompt.inside()[0]).toBe('>')
    const recalls = prompt.events.filter(event => event.kind === 'recall-change')
    expect(recalls).toMatchObject([
      { controlId: 'p', source: 'queued', index: 0 },
      { source: 'history', index: 1 },
      { source: 'queued', index: 0 },
      { source: 'draft', index: -1 },
    ])
  })

  it('submits a recalled message as the draft, and an edit of it leaves the walk', () => {
    const prompt = open({ recall: RECALL })
    prompt.press(KEY.up)
    prompt.type('!')
    expect(prompt.inside()[0]).not.toContain('↑ queued')
    expect(prompt.inside()[0]).toContain('also update the footer!')
    prompt.press(KEY.enter)
    expect(prompt.events.at(-1)).toMatchObject({ kind: 'submit', submission: { forms: [{ fields: [{ value: 'also update the footer!' }, { value: [] }] }] } })
  })

  it('does nothing for ↓ before a walk has begun', () => {
    const prompt = open({ recall: RECALL })
    prompt.press(KEY.down)
    expect(prompt.events).toEqual([])
  })
})

describe('the completion list', () => {
  const list = () => open({ completions: { items: ITEMS }, value: '/' })

  it('moves a cursor with the arrows, and Tab or Enter accept the row under it', () => {
    const prompt = list()
    expect(prompt.inside()[1]).toBe('→ /model — switch model')
    prompt.press(KEY.down, KEY.down, KEY.up)
    expect(prompt.inside()[2]).toBe('→ /sessions')
    prompt.press(KEY.tab)
    expect(prompt.events).toMatchObject([{ kind: 'completion-accept', controlId: 'p', itemId: 'c2' }])
    prompt.press(KEY.enter)
    expect(prompt.events.filter(event => event.kind === 'completion-accept')).toHaveLength(1)
  })

  it('accepts with Enter, and never submits while the list is open', () => {
    const prompt = list()
    prompt.press(KEY.enter)
    expect(prompt.events).toMatchObject([{ kind: 'completion-accept', itemId: 'c1' }])
    expect(kinds(prompt.events)).not.toContain('submit')
  })

  it('closes on Esc until the offered rows change, and Esc then leaves as it did', () => {
    const prompt = list()
    prompt.press(KEY.esc)
    expect(prompt.events).toMatchObject([{ kind: 'completion-dismiss', controlId: 'p' }])
    expect(prompt.inside().some(row => row.includes('/sessions'))).toBe(false)
    prompt.press(KEY.enter)
    expect(kinds(prompt.events)).toContain('submit')
  })

  it('keeps typing: other keys edit the buffer, and an edit puts the cursor back on the first row', () => {
    const prompt = list()
    prompt.press(KEY.down)
    prompt.type('m')
    expect(prompt.inside()[0]).toBe('> /m')
    expect(prompt.inside()[1]).toBe('→ /model — switch model')
  })

  it('inserts a line break while the list is open', () => {
    const prompt = list()
    prompt.press(KEY.altEnter)
    expect(prompt.events.at(-1)).toMatchObject({ kind: 'value-change', value: '/\n' })
  })
})

describe('republishing', () => {
  /** A surface the host republishes: one model and runtime, a new node each time. */
  function host(initial: Omit<MayflyPromptNode, 'kind' | 'id'>, width = 80) {
    let revision = 1
    const events: MayflyUiEvent[] = []
    const endpoint = { prepare: async (event: MayflyUiEvent) => { events.push(event); return { reply: { kind: 'completed' as const }, publish: () => true } } }
    const snapshot = (prompt: Omit<MayflyPromptNode, 'kind' | 'id'>) => ({
      scope: { kind: 'app' as const, targetId: 'prompt' }, source: [], revision: revision++, update: { reason: 'data' as const },
      node: ui.surface({ title: 'Prompt', chrome: 'surface', child: ui.prompt({ id: 'p', autofocus: true, ...prompt }) }), events: endpoint, definition: { onEvent: {} },
    })
    const model = new UiSurfaceModel('prompt', snapshot(initial) as never)
    let runtime = new MayflyUiSurfaceRuntime(model)
    const compile = () => {
      const result = compileMayflyUiSurfaceNode(model.node!, {
        components: parityComponents(), colors: PROBE_PALETTE, getViewport: () => ({ columns: width, rows: 40 }), screenMode: 'alternate',
        emit: () => {}, contextHints: { enabled: true }, onUnhandledEscape: () => {}, surfaceRuntime: runtime,
      })
      if (!result.ok) throw new Error(result.message)
      result.value.focusTarget!.focused = true
      return result.value
    }
    let compiled = compile()
    return {
      events, model,
      rows: () => compiled.component.render(width).map(plain),
      press: (key: string) => { compiled.focusTarget!.handleInput?.(key) },
      publish: (prompt: Omit<MayflyPromptNode, 'kind' | 'id'>) => { model.receive(snapshot(prompt) as never); compiled = compile() },
      reload: () => { runtime.dispose(); runtime = new MayflyUiSurfaceRuntime(model); compiled = compile() },
      dispose: () => { runtime.dispose(); model.dispose() },
    }
  }

  it('keeps the draft through a republish and a renderer reload, and a reset replaces it once', () => {
    const prompt = host({ placeholder: 'Ask' })
    prompt.press('h'); prompt.press('i')
    prompt.publish({ placeholder: 'Ask again', tokens: [{ id: 't', label: 'x' }] })
    expect(prompt.rows()[1]).toContain('[x ×] hi')
    prompt.reload()
    expect(prompt.rows()[1]).toContain('[x ×] hi')
    prompt.publish({ reset: { rev: 1, value: 'inserted ' } })
    expect(prompt.rows()[1]).toContain('> inserted')
    prompt.press('x')
    prompt.publish({ reset: { rev: 1, value: 'inserted ' } })
    expect(prompt.rows()[1]).toContain('> inserted x')
    prompt.dispose()
  })

  it('walks a recall list the host shrinks when it hands a queued message back', () => {
    const prompt = host({ recall: RECALL })
    prompt.press(KEY.up)
    prompt.publish({ recall: [RECALL[1], RECALL[2]] })
    expect(prompt.rows()[1]).toContain('also update the footer')
    prompt.press(KEY.up)
    expect(prompt.rows()[1]).toContain('run the width scan again')
    expect(prompt.rows()[1]).toContain('↑ history 1/2')
    prompt.dispose()
  })

  it('repaints the completion list the host offers and drops it when the host takes it back', () => {
    const prompt = host({ value: '/' })
    const body = () => prompt.rows().slice(1, -1).map(row => row.replace(/^│ | *│$/gu, '').trimEnd())
    expect(body()).toEqual(['> /', '  Enter send · Alt+Enter newline · Esc close'])
    prompt.publish({ completions: { items: ITEMS } })
    expect(body().slice(0, 4)).toEqual(['> /', '→ /model — switch model', '  /sessions', '  /trace'])
    expect(body()).toHaveLength(5)
    prompt.publish({ value: '/' })
    expect(body()).toHaveLength(2)
    prompt.dispose()
  })
})

describe('focus', () => {
  it('draws the caret only while the surface has focus, and starts on an autofocus prompt', () => {
    const prompt = open({}, 40, [ui.actions({ id: 'actions', items: [{ id: 'go', label: 'Go', defaultFocus: true }] })])
    // The action declares itself the default, but an autofocus prompt is not preferred over nothing: the prompt asked first.
    expect(prompt.surface.render().join('')).toContain('\x1b[7m')
    prompt.surface.press(KEY.down)
    expect(prompt.rows().join('\n')).toContain('Go')
  })

  it('claims the printable keys, so a letter accelerator elsewhere cannot take them', () => {
    const prompt = open({}, 80, [ui.actions({ id: 'actions', items: [{ id: 'copy', label: 'Copy', key: 'c' }] })])
    prompt.type('c')
    expect(prompt.events).toMatchObject([{ kind: 'value-change', value: 'c' }])
  })

  it('leaves modifier accelerators to their actions', () => {
    const prompt = open({}, 80, [ui.actions({ id: 'actions', items: [{ id: 'copy', label: 'Copy', key: 'Ctrl+Y' }] })])
    prompt.press('\x19')
    expect(prompt.events).toMatchObject([{ kind: 'activate', actionId: 'copy' }])
    expect(prompt.hint()).toContain('Ctrl+Y copy')
  })

  it('closes the surface with Esc and Ctrl+C when no completion list is open', () => {
    const closed: string[] = []
    const events: MayflyUiEvent[] = []
    const surface = createRealSurface(ui.surface({ title: 'Prompt', chrome: 'surface', child: ui.prompt({ id: 'p' }) }), 60, { components: parityComponents(), events: event => events.push(event), overrides: { onUnhandledEscape: () => { closed.push('closed') }, escapeHint: 'close' } })
    surfaces.push(surface)
    surface.press(KEY.esc)
    surface.press(KEY.ctrlC)
    expect(closed).toEqual(['closed', 'closed'])
  })
})

describe('the surface around a prompt', () => {
  it('names no Esc when the host handles none, and leaves Ctrl+C unbound', () => {
    const events: MayflyUiEvent[] = []
    const surface = createRealSurface(ui.surface({ title: 'Prompt', chrome: 'surface', child: ui.prompt({ id: 'p' }) }), 80, { components: parityComponents(), events: event => events.push(event) })
    surfaces.push(surface)
    expect(surface.render().map(plain).at(-2)!.replace(/^│ ?| ?│$/gu, '').trim()).toBe('Enter send · Alt+Enter newline')
    surface.press(KEY.esc)
    surface.press(KEY.ctrlC)
    expect(events).toEqual([])
  })

  it('paints a prompt its model does not hold as read-only text', () => {
    const model = new UiSurfaceModel('other', {
      scope: { kind: 'app', targetId: 'p' }, source: [], revision: 1, update: { reason: 'data' }, node: ui.text('another tree'),
      events: { prepare: async () => ({ reply: undefined, publish: () => false }) }, definition: {},
    } as never)
    const runtime = new MayflyUiSurfaceRuntime(model)
    const result = compileMayflyUiSurfaceNode(ui.prompt({ id: 'p', value: 'kept', placeholder: 'Ask' }), { components: parityComponents(), colors: PROBE_PALETTE, getViewport: () => ({ columns: 40, rows: 10 }), screenMode: 'alternate', emit: () => {}, surfaceRuntime: runtime })
    if (!result.ok) throw new Error(result.message)
    expect(result.value.component.render(40).map(plain)).toEqual(['> kept'])
    runtime.dispose()
    model.dispose()
  })

  it('contains a failing editor behind an error row, and repaints after an invalidation', () => {
    const components = parityComponents()
    const failing = { ...components, createEditor: () => { const editor = components.createEditor(); editor.renderContent = () => { throw new Error('boom') }; return editor } }
    const model = new UiSurfaceModel('failing', {
      scope: { kind: 'app', targetId: 'p' }, source: [], revision: 1, update: { reason: 'data' }, node: ui.prompt({ id: 'p', value: 'text' }),
      events: { prepare: async () => ({ reply: undefined, publish: () => false }) }, definition: {},
    } as never)
    const runtime = new MayflyUiSurfaceRuntime(model)
    const result = compileMayflyUiSurfaceNode(model.node!, { components: failing, colors: PROBE_PALETTE, getViewport: () => ({ columns: 40, rows: 10 }), screenMode: 'alternate', emit: () => {}, surfaceRuntime: runtime })
    if (!result.ok) throw new Error(result.message)
    expect(result.value.component.render(40).map(plain).join('\n')).toContain('boom')
    result.value.component.invalidate()
    expect(result.value.component.render(40).map(plain).join('\n')).toContain('boom')
    runtime.dispose()
    model.dispose()
  })

  it('lets go of the editor of a prompt a republish took out of the tree', () => {
    let revision = 1
    const endpoint = { prepare: async () => ({ reply: { kind: 'completed' as const }, publish: () => true }) }
    const snapshot = (node: MayflyUiNode) => ({ scope: { kind: 'app' as const, targetId: 'p' }, source: [], revision: revision++, update: { reason: 'data' as const }, node, events: endpoint, definition: { onEvent: {} } })
    const model = new UiSurfaceModel('gone', snapshot(ui.prompt({ id: 'p', value: 'kept' })) as never)
    const runtime = new MayflyUiSurfaceRuntime(model)
    const compile = () => {
      const result = compileMayflyUiSurfaceNode(model.node!, { components: parityComponents(), colors: PROBE_PALETTE, getViewport: () => ({ columns: 40, rows: 10 }), screenMode: 'alternate', emit: () => {}, surfaceRuntime: runtime })
      if (!result.ok) throw new Error(result.message)
      return result.value
    }
    expect(compile().component.render(40).map(plain)).toEqual(['> kept'])
    model.receive(snapshot(ui.text('no prompt any more')) as never)
    expect(model.prompt({ pagePath: [], controlId: 'p' })).toBeUndefined()
    expect(compile().component.render(40).map(plain)).toEqual(['no prompt any more'])
    model.receive(snapshot(ui.prompt({ id: 'p', value: 'new' })) as never)
    // The new prompt starts from its own value: the old draft went with the old prompt.
    expect(compile().component.render(40).map(plain)).toEqual(['> new'])
    runtime.dispose()
    model.dispose()
  })

  it('takes no prompt intent while a decision waits for its answer', () => {
    const events = { prepare: async () => ({ reply: { kind: 'completed' as const }, publish: () => true }) }
    const model = new UiSurfaceModel('decision', {
      scope: { kind: 'app', targetId: 'p' }, source: [], revision: 1, update: { reason: 'data' },
      node: ui.stack.column([ui.prompt({ id: 'p' }), ui.actions({ id: 'a', items: [{ id: 'go', label: 'Go', confirm: 'Sure?' }] })]), events, definition: { onEvent: {} },
    } as never)
    model.invoke('go')
    model.updatePrompt({ pagePath: [], controlId: 'p' }, { kind: 'edit', value: 'x' })
    expect(model.prompt({ pagePath: [], controlId: 'p' })?.text).toBe('')
    model.answerDecision(false)
    model.updatePrompt({ pagePath: [], controlId: 'p' }, { kind: 'edit', value: 'x' })
    expect(model.prompt({ pagePath: [], controlId: 'p' })?.text).toBe('x')
    model.dispose()
    model.updatePrompt({ pagePath: [], controlId: 'p' }, { kind: 'edit', value: 'y' })
    expect(model.prompt({ pagePath: [], controlId: 'p' })).toBeUndefined()
  })
})
