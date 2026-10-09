/**
 * Prompt (roadmap slice 1.9b): `ui.prompt` is the one text control that is not a field. It draws a symbol, `[label size ×]`
 * tokens, and the buffer in one input row; a placeholder ladder while it is empty; `↑ history 2/4` in its corner while
 * `↑`/`↓` walk the recall (queued messages first); and a completion list under the buffer. The pane below is a small host:
 * it keeps the tokens, the queue, and the history, offers completions for a leading `/`, `@`, or `#` word, and answers the
 * prompt's events by republishing the node. Core keeps the draft, so a republish never loses what was typed.
 *
 * @module @mayfly-example/ui-gallery/groups/prompt
 */
import type { Context } from '@deepseek-ai/cordis'
import { ui, type MayflyUiNode, type MayflyUiObservationEvent, type MayflyUiActionEvent } from '@ephemeral-ai/mayfly-ui'

interface Entry { readonly id: string, readonly label: string, readonly detail: string, readonly size?: string }

const POOLS: Readonly<Record<string, readonly Entry[]>> = {
  '/': [
    { id: 'model', label: '/model', detail: 'switch model and thinking' },
    { id: 'sessions', label: '/sessions', detail: 'browse and resume sessions' },
    { id: 'trace', label: '/trace', detail: 'inspect the execution trace' },
  ],
  '@': [
    { id: 'activity', label: '@pane-activity.ts', detail: 'packages/mayfly/src/transcript/', size: '2 KB' },
    { id: 'agents', label: '@pane-agents.ts', detail: 'packages/mayfly/src/transcript/', size: '3 KB' },
    { id: 'notes', label: '@notes.md', detail: 'docs/', size: '2 KB' },
  ],
  '#': [
    { id: 'design', label: '#frontend-design', detail: 'build distinctive interfaces' },
    { id: 'review', label: '#review', detail: 'review a diff for defects' },
  ],
}

/** The placeholder ladder: whole triggers only, so a narrow pane never cuts inside one. */
const PLACEHOLDER = ['Ask anything · / commands · @ files · # skills', 'Ask anything · / commands · @ files', 'Ask anything']

/** The word being typed at the end of the draft, with the entries it offers. */
function offered(text: string): { readonly word: string, readonly entries: readonly Entry[] } {
  const match = /(?:^|\s)([@/#])(\S*)$/u.exec(text)
  if (match === null) return { word: '', entries: [] }
  return { word: `${match[1]!}${match[2]!}`, entries: POOLS[match[1]!]!.filter(entry => entry.label.slice(1).startsWith(match[2]!)) }
}

/**
 * Register the gallery's prompt through the public pane service.
 * @param ctx - a context that injects `mayflyPanes`.
 */
export function registerGalleryPrompt(ctx: Context): void {
  const state = {
    text: '',
    tokens: [{ id: 'image-1', label: 'Image #1', size: '84 KB' }] as { id: string, label: string, size: string }[],
    queued: ['also update the footer'],
    history: ['run the width scan again', 'bump the changelog too'],
    pulled: undefined as number | undefined,
    resets: 0,
    attachments: 1,
  }

  const promptNode = (reset?: string): MayflyUiNode => {
    if (reset !== undefined) state.resets += 1
    const { entries } = offered(state.text)
    return ui.stack.column([
      ui.text('Backspace on an empty prompt selects, then removes, the last token. Up and Down recall; type / @ or # for completions.', { tone: 'muted' }),
      ui.surface({
        title: 'Gallery prompt', titleAlign: 'right', chrome: 'surface', hint: 'completions',
        child: ui.prompt({
          id: 'gallery-prompt',
          tokens: state.tokens,
          recall: [...state.queued.map(text => ({ kind: 'queued' as const, text })), ...state.history.map(text => ({ kind: 'history' as const, text }))],
          recallLabel: 'history',
          placeholder: PLACEHOLDER,
          ...(entries.length === 0 ? {} : { completions: { items: entries.map(({ id, label, detail }) => ({ id, label, detail })) } }),
          reset: { rev: state.resets, value: reset ?? state.text },
        }),
      }),
    ], { gap: 1 })
  }

  const pane = ctx.mayflyPanes.register({
    id: 'example.ui-gallery.prompt',
    title: 'Gallery prompt',
    placement: 'bottom',
    onEvent: {
      observe: (event: MayflyUiObservationEvent) => {
        if (event.kind === 'value-change') {
          const before = offered(state.text).entries.map(entry => entry.id).join()
          state.text = event.value as string
          if (offered(state.text).entries.map(entry => entry.id).join() !== before) pane.set(promptNode())
        } else if (event.kind === 'recall-change') state.pulled = event.source === 'queued' ? event.index : undefined
      },
      action: (event: MayflyUiActionEvent) => {
        if (event.kind === 'completion-accept') {
          const { word, entries } = offered(state.text)
          const entry = entries.find(candidate => candidate.id === event.itemId)
          if (entry === undefined) return { kind: 'cancelled' }
          const before = state.text.slice(0, state.text.length - word.length)
          if (word.startsWith('@')) {
            state.attachments += 1
            state.tokens = [...state.tokens, { id: `file-${String(state.attachments)}`, label: entry.label, size: entry.size! }]
            state.text = before
            pane.set(promptNode(before))
          } else {
            state.text = `${before}${entry.label} `
            pane.set(promptNode(state.text))
          }
          return { kind: 'completed' }
        }
        if (event.kind === 'token-remove') {
          state.tokens = state.tokens.filter(token => token.id !== event.tokenId)
          pane.set(promptNode())
          return { kind: 'completed', feedback: { severity: 'info', message: 'Removed the attachment' } }
        }
        if (event.kind === 'submit') {
          const text = event.submission.forms[0]!.fields.find(field => field.id === 'text')!.value as string
          // A recalled queued message leaves the queue when it is sent.
          if (state.pulled !== undefined) state.queued = state.queued.filter((_, index) => index !== state.pulled)
          state.pulled = undefined
          if (text.trim() !== '') state.history = [text, ...state.history]
          const sent = state.tokens.length
          state.tokens = []
          state.text = ''
          return { kind: 'accepted', node: promptNode(''), source: [], feedback: { severity: 'success', message: sent === 0 ? 'Sent' : `Sent with ${String(sent)} attachment${sent === 1 ? '' : 's'}` } }
        }
        return { kind: 'completed' }
      },
    },
  }, promptNode())
}
