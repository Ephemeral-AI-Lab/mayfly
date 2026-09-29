/** Contextual editor keys projected into independently admitted status fragments.
 * @module @ephemeral-ai/mayfly/interaction/key-hints-status
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MayflyStatusRegistration } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/index.ts'
import { displayKey } from '../core/key-actions.ts'
import { interactionTranslator, observeInteractionLocale } from './locale.ts'
import { currentMayflySettings } from './settings.ts'
import { sessionModeSnapshot } from './mode-commands.ts'
import {
  ACTION_BACKSPACE, ACTION_CANCEL, ACTION_CYCLE_MODEL, ACTION_EXTERNAL_EDITOR,
  ACTION_NEWLINE, ACTION_PAGE_DOWN, ACTION_PAGE_UP, ACTION_SHIFT_TAB, ACTION_STEER, ACTION_SUBMIT,
} from './keys.ts'

export interface PromptHintState {
  readonly editorFocused?: boolean
  readonly access: 'interactive' | 'readonly' | 'resumable'
  readonly running: boolean
  readonly stopping: boolean
  readonly hasRetractionCandidate?: boolean
  readonly draft: boolean
  readonly shell: boolean
  readonly plan: boolean | undefined
  readonly focusable?: boolean
  readonly disclosure?: { readonly expanded: boolean, readonly count: number }
}
export interface PromptKeyHint { readonly id: string, readonly key: string, readonly label: string, readonly priority: number }

/** Hints use the same editor state as dispatch and omit unregistered actions. */
export function promptKeyHints(state: PromptHintState, mode: 'full' | 'minimal' | 'off', keys: (action: string) => readonly string[], t: MayflyTranslate): readonly PromptKeyHint[] {
  if (mode === 'off' || state.editorFocused === false) return []
  const hints: PromptKeyHint[] = []
  const add = (id: string, action: string, label: string, priority: number): void => {
    const key = keys(action).map(displayKey).join('/')
    if (key !== '') hints.push({ id, key, label, priority })
  }
  if (state.disclosure !== undefined && state.disclosure.count > 0) add('disclosure', 'mayfly.transcript.toggle-collapse', state.disclosure.expanded ? t('collapse') : t('expand'), 4)
  if (state.access !== 'interactive') {
    if (mode === 'full') {
      if (state.access === 'resumable') add('reply', ACTION_SUBMIT, t('reply'), 3)
      const scroll = [...keys(ACTION_PAGE_UP), ...keys(ACTION_PAGE_DOWN)].map(displayKey).join('/')
      if (scroll !== '') hints.push({ id: 'scroll', key: scroll, label: t('scroll'), priority: 5 })
    }
    return hints
  }
  if (state.running && !state.stopping) add('escape', ACTION_CANCEL, state.hasRetractionCandidate === true ? t('take back / interrupt') : t('interrupt'), 2)
  if (mode === 'minimal') return hints
  if (state.focusable) add('focus', 'mayfly.surface.next', t('focus'), 8)
  if (state.draft) {
    add('submit', ACTION_SUBMIT, state.shell ? t('run') : state.running ? t('queue') : t('send'), 3)
    if (!state.shell) {
      if (state.running) add('steer', ACTION_STEER, t('steer'), 4)
      add('newline', ACTION_NEWLINE, t('newline'), 6)
    }
    add('external', ACTION_EXTERNAL_EDITOR, t('editor'), 7)
    if (!state.running) add('escape', ACTION_CANCEL, t('clear'), 2)
  } else if (!state.running) {
    if (state.shell) add('shell', ACTION_BACKSPACE, t('exit shell'), 3)
    if (state.plan !== undefined) add('plan', ACTION_SHIFT_TAB, state.plan ? t('exit plan') : t('plan'), 5)
    add('model', ACTION_CYCLE_MODEL, t('model'), 6)
    if (!state.shell) hints.push({ id: 'help', key: '/help', label: t('keys'), priority: 9 })
  }
  return hints
}

/** Mount in the input Fiber; registration refresh never touches editor input. */
export function mountKeyHintsStatus(ctx: Context, read: () => PromptHintState): () => void {
  let refresh = (): void => {}
  ctx.inject(['mayflyStatus'], owner => {
    const t = interactionTranslator(owner)
    const handles = new Map<string, { handle: MayflyStatusRegistration, signature: string }>()
    refresh = () => {
      const capturing = ctx.mayflyOverlays.list().some(entry => !entry.hidden && entry.definition.capturing === true)
      const hints = capturing ? [] : promptKeyHints(read(), currentMayflySettings(ctx).keyHints, action => ctx.mayflyKeymap.getKeys(action), t)
      const live = new Set(hints.map(hint => hint.id))
      for (const [id, entry] of handles) if (!live.has(id)) { entry.handle.dispose(); handles.delete(id) }
      for (const hint of hints) {
        const node = { kind: 'rich-text' as const, spans: [{ text: hint.key, styles: ['strong' as const] }, { text: ` ${hint.label}`, tone: 'muted' as const }] }
        const signature = JSON.stringify(node)
        const previous = handles.get(hint.id)
        if (previous === undefined) handles.set(hint.id, { handle: owner.mayflyStatus.register({ id: `mayfly.status.keys.${hint.id}`, row: 2, band: 'left', priority: hint.priority, overflow: hint.id === 'escape' ? 'truncate' : 'hide' }, node), signature })
        else if (previous.signature !== signature) { previous.signature = signature; previous.handle.set(node) }
      }
    }
    owner.effect(() => ctx.mayflyInteractionState.draft.subscribe(refresh))
    owner.effect(() => ctx.mayflyConversations.subscribe(refresh))
    owner.effect(() => ctx.mayflyOverlays.subscribe(refresh))
    owner.effect(() => observeInteractionLocale(owner, refresh))
    owner.on('session/event', refresh)
    owner.on('mayfly/input-focus-changed', refresh)
    owner.on('mayfly/input-editor-changed', refresh)
    owner.on('mayfly/transcript-disclosure-changed', refresh)
    owner.on('mayfly/transcript-content-changed', refresh)
    owner.on('mayfly/request-state-changed', refresh)
    owner.on('mayfly/request-stop-changed', refresh)
    owner.on('mayfly/keymap-changed', refresh)
    owner.on('settings/document-updated', refresh)
    owner.on('mayfly/settings-source-ready', refresh)
    owner.effect(() => () => { refresh = () => {}; for (const entry of handles.values()) entry.handle.dispose() })
    refresh()
  })
  return () => refresh()
}

/** Read the actual plan-toggle target, including a pending turn-boundary change. */
export function promptPlanState(ctx: Context): boolean | undefined {
  const agent = ctx.mayflyCurrentAgent.current()
  const plan = agent === null ? undefined : sessionModeSnapshot(ctx, agent).plan
  return plan === undefined ? undefined : plan.active !== plan.pending
}
