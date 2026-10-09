/**
 * Scene 15, Editor, rebuilt with the real prompt: the prototype's `Editor` composition (a right-titled surface around
 * `ui.prompt`) and the demo host around it (`ui-preview.mjs`), driven by the events the prompt emits. The queue line and
 * the scene caption above the frame belong to the Editor component of Phase 5 and are not drawn here.
 */
import { CURSOR_MARKER } from '@earendil-works/pi-tui'
import { ui, type MayflyUiEvent, type MayflyUiNode } from '../../../ui/src/index.ts'
import { MayflyUiSurfaceRuntime, compileMayflyUiSurfaceNode } from '../../src/core/ui-compiler.ts'
import { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import type { MayflyEditor } from '../../src/core/types.ts'
import { truncateToWidth } from '../../src/core/width.ts'
import { createFakeEditor } from '../core/fake-editor.ts'
import { PROBE_PALETTE, parityComponents } from './parity.ts'

const HISTORY = ['run the width scan again', 'bump the changelog too', 'explain the facts projection']
const FILES = [{ id: 'f1', label: '@pane-activity.ts', detail: 'packages/mayfly/src/transcript/', size: '2 KB' }, { id: 'f2', label: '@pane-agents.ts', detail: 'packages/mayfly/src/transcript/', size: '3 KB' }, { id: 'f3', label: '@notes.md', detail: 'docs/', size: '2 KB' }]
const COMMANDS = [{ id: 'c1', label: '/model', detail: 'switch model and thinking' }, { id: 'c2', label: '/sessions', detail: 'browse and resume sessions' }, { id: 'c3', label: '/trace', detail: 'inspect the execution trace' }]
const SKILLS = [{ id: 's1', label: '#frontend-design', detail: 'build distinctive interfaces' }, { id: 's2', label: '#review', detail: 'review a diff for defects' }]
const POOLS: Readonly<Record<string, readonly { readonly id: string, readonly label: string, readonly detail: string, readonly size?: string }[]>> = { '@': FILES, '/': COMMANDS, '#': SKILLS }
const CONTEXTS = [
  { title: 'Update the landing page hero', variants: ['Ask anything · / commands · @ files · # skills · ! shell', 'Ask anything · / commands · @ files · # skills', 'Ask anything · / commands · @ files', 'Ask anything'], running: ['Type a follow-up to queue it · @ files · # skills', 'Type a follow-up to queue it'] },
  { title: 'why does the cache miss', variants: ['Continue the side question · @ files · # skills', 'Continue the side question'] },
  { title: 'reviewer', variants: ['Reply to reviewer — sending resumes it'] },
  { title: 'reviewer', variants: ['Read-only conversation'] },
] as const

/** The terminal editor with the prototype's caret: where the terminal puts its cursor, the real editor draws a marker and an inverse cell. */
function createCaretEditor(): MayflyEditor {
  const editor = createFakeEditor()
  editor.renderContent = (width: number) => [truncateToWidth(`${editor.getExpandedText()}${editor.focused ? `${CURSOR_MARKER}\x1b[7m \x1b[0m` : ''}`, width, '')]
  return editor
}

/** The cursor cell of the real editor, written the way the prototype writes it. */
export const toPrototypeCaret = (row: string): string => row.replaceAll(`${CURSOR_MARKER}\x1b[7m \x1b[0m`, '▌')

export interface EditorHost {
  /** The frame at the current width, one row per entry. */
  render(): string[]
  /** One key: the host's own demo keys first, then the focused prompt. */
  press(key: string): void
  readonly width: () => number
  dispose(): void
}

/** The demo host of scene 15: it answers the prompt's events and republishes the `Editor` node. */
export function editorHost(): EditorHost {
  const state = { tokens: [] as { id: string, label: string, size: string }[], queued: ['also update the footer'], history: [...HISTORY], running: false, shell: false, ctx: 0, w: 0, reset: { rev: 0, value: '' }, pulled: null as number | null, n: 1 }
  const widths = [96, 60, 40]
  let revision = 1
  let model!: UiSurfaceModel
  let runtime!: MayflyUiSurfaceRuntime
  let compiled!: ReturnType<typeof compile>
  const draft = (): string => model.prompt({ pagePath: [], controlId: 'prompt' })?.text ?? ''

  const node = (): MayflyUiNode => {
    const text = draft()
    const match = state.shell ? null : /(^|\s)([@/#])(\S*)$/u.exec(text)
    const pool = match === null ? [] : POOLS[match[2]!]!.filter(item => item.label.slice(1).startsWith(match[3]!))
    const context = CONTEXTS[state.ctx]!
    const placeholder = state.shell ? ['Run a shell command · Esc leaves shell mode'] : state.running && 'running' in context ? context.running : context.variants
    return ui.surface({
      title: context.title, titleAlign: 'right', chrome: 'surface', hint: 'completions', ...(state.shell ? { border: 'accent' as const } : {}),
      child: ui.prompt({
        id: 'prompt', autofocus: true, symbol: state.shell ? '! ' : '> ', ...(state.shell ? { symbolTone: 'accent' as const } : {}),
        tokens: state.tokens, recall: [...state.queued.map(text => ({ kind: 'queued' as const, text })), ...state.history.map(text => ({ kind: 'history' as const, text }))],
        placeholder, ...(pool.length === 0 ? {} : { completions: { items: pool.map(({ id, label, detail }) => ({ id, label, detail })) } }), reset: state.reset, recallLabel: 'history',
      }),
    })
  }
  const setText = (value: string): void => { state.reset = { rev: state.reset.rev + 1, value } }

  const onEvent = (event: MayflyUiEvent): void => {
    if (event.kind === 'value-change' && event.formId === 'prompt' && event.value === '!' && !state.shell) { state.shell = true; setText('') }
    else if (event.kind === 'completion-accept') {
      const text = draft()
      const word = /[@/#]\S*$/u.exec(text)?.[0] ?? ''
      const item = POOLS[word[0]!]!.find(candidate => candidate.id === event.itemId)!
      if (word[0] === '@') { state.tokens.push({ id: `t${String(state.n++)}`, label: item.label, size: item.size! }); setText(text.slice(0, -word.length)) }
      else setText(`${text.slice(0, -word.length)}${item.label} `)
    } else if (event.kind === 'token-remove') state.tokens = state.tokens.filter(token => token.id !== event.tokenId)
    else if (event.kind === 'recall-change') state.pulled = event.source === 'queued' ? event.index : null
    else if (event.kind === 'submit') {
      const text = event.submission.forms[0]!.fields.find(field => field.id === 'text')!.value as string
      if (state.pulled !== null) { state.queued.splice(state.pulled, 1); state.pulled = null }
      if (!state.shell) { if (state.running) state.queued.push(text); else state.history.unshift(text) }
      state.tokens = []
    }
  }

  const snapshot = (next: MayflyUiNode) => ({
    scope: { kind: 'app' as const, targetId: 'scene-15' }, source: [], revision: revision++, update: { reason: 'data' as const }, node: next,
    events: { prepare: async (event: MayflyUiEvent) => { onEvent(event); return { reply: { kind: 'completed' as const }, publish: () => true } } },
    definition: { onEvent: {} },
  })
  const events = snapshot(ui.text('')).events
  const compile = () => {
    const width = widths[state.w]!
    const result = compileMayflyUiSurfaceNode(model.node!, {
      components: { ...parityComponents(), createEditor: createCaretEditor }, colors: PROBE_PALETTE, getViewport: () => ({ columns: width, rows: 40 }), screenMode: 'alternate',
      emit: () => {}, contextHints: { enabled: true }, onUnhandledEscape: () => {}, surfaceRuntime: runtime,
    })
    if (!result.ok) throw new Error(result.message)
    result.value.focusTarget!.focused = true
    return result.value
  }
  const publish = (): void => {
    const before = draft()
    model.receive({ ...snapshot(node()), events } as never)
    compiled = compile()
    // A reset lands when the node arrives, and the completion pool follows the text it left: publish once more.
    if (draft() !== before) { model.receive({ ...snapshot(node()), events } as never); compiled = compile() }
  }

  model = new UiSurfaceModel('scene-15', { ...snapshot(ui.text('')), events, node: null } as never)
  runtime = new MayflyUiSurfaceRuntime(model)
  model.receive({ ...snapshot(node()), events } as never)
  compiled = compile()

  return {
    width: () => widths[state.w]!,
    render: () => compiled.component.render(widths[state.w]!).map(toPrototypeCaret),
    press(key) {
      const text = draft()
      if (key === '\x0b') state.tokens.push({ id: `t${String(state.n++)}`, label: `Image #${String(state.tokens.filter(token => token.label.startsWith('Image')).length + 1)}`, size: '84 KB' })
      else if (key === '\x16') state.tokens.push({ id: `t${String(state.n++)}`, label: `Pasted #${String(state.tokens.filter(token => token.label.startsWith('Pasted')).length + 1)}`, size: '12 lines' })
      else if (key === '\x12') state.running = !state.running
      else if (key === '\x0f') state.ctx = (state.ctx + 1) % CONTEXTS.length
      else if (key === '\x17') state.w = (state.w + 1) % widths.length
      else if (state.shell && (key === '\x1b' || (key === '\x7f' && text === ''))) state.shell = false
      else compiled.focusTarget!.handleInput?.(key)
      publish()
    },
    dispose: () => { runtime.dispose(); model.dispose() },
  }
}
