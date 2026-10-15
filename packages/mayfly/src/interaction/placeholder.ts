/**
 * The editor's empty-prompt placeholder: the ghost text that teaches the typed prefixes (`/` `@` `#` `!`) by the state of
 * the displayed conversation. A state is a ladder of whole-trigger variants, longest first; the painter picks the longest
 * that fits the row, so nothing here reads a width. Quiet hints `off` blanks the ladders that teach (main, side
 * question, live subagent) and keeps the ones that state a condition (shell, resumable, read-only).
 *
 * @module @ephemeral-ai/mayfly/interaction/placeholder
 */

import type { MayflyTranslate } from '../frontend/locale.ts'

/** What the displayed conversation lets the empty prompt say. */
export type PlaceholderState =
  | { readonly kind: 'main', readonly running: boolean }
  | { readonly kind: 'shell' }
  | { readonly kind: 'side-question' }
  | { readonly kind: 'subagent-live', readonly name: string }
  | { readonly kind: 'subagent-resumable', readonly name: string }
  | { readonly kind: 'read-only' }

/** The shape of a displayed conversation this module reads. */
export interface PlaceholderView {
  readonly kind: 'primary' | 'btw' | 'subagent'
  readonly access: 'interactive' | 'resumable' | 'readonly'
  readonly label?: string
}

/**
 * The state of the empty prompt.
 * @param view - the displayed conversation, or none before one exists.
 * @param shell - the buffer is a shell command.
 * @param running - the displayed Agent is running a turn.
 * @returns the state.
 */
export function placeholderState(view: PlaceholderView | null | undefined, shell: boolean, running: boolean): PlaceholderState {
  if (shell) return { kind: 'shell' }
  if (view == null || view.kind === 'primary') return { kind: 'main', running }
  if (view.access === 'readonly') return { kind: 'read-only' }
  if (view.kind === 'btw') return { kind: 'side-question' }
  const name = view.label ?? ''
  return view.access === 'resumable' ? { kind: 'subagent-resumable', name } : { kind: 'subagent-live', name }
}

/**
 * The ladder of one state.
 * @param state - the state of the empty prompt.
 * @param hintsOff - the quiet-hints setting is `off`.
 * @param t - the interaction translator.
 * @returns the variants, longest first; none when the state's teaching is off.
 */
export function placeholderLadder(state: PlaceholderState, hintsOff: boolean, t: MayflyTranslate): readonly string[] {
  switch (state.kind) {
    case 'shell': return [t('Run a shell command · Esc leaves shell mode')]
    case 'read-only': return [t('Read-only conversation')]
    case 'subagent-resumable': return [t('Reply to {name} — sending resumes it', { name: state.name })]
    default:
  }
  if (hintsOff) return []
  switch (state.kind) {
    case 'main': return state.running
      ? [t('Type a follow-up to queue it · @ files · # skills'), t('Type a follow-up to queue it')]
      : [
          t('Ask anything · / commands · @ files · # skills · ! shell'),
          t('Ask anything · / commands · @ files · # skills'),
          t('Ask anything · / commands · @ files'),
          t('Ask anything · / commands'),
          t('Ask anything'),
        ]
    case 'side-question': return [t('Continue the side question · @ files · # skills'), t('Continue the side question')]
    default: return [t('Message {name} · @ files · # skills', { name: state.name }), t('Message {name}', { name: state.name })]
  }
}
