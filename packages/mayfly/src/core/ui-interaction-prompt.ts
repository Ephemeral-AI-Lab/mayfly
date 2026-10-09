/**
 * The frontend model of a `prompt` node: the draft, the selected token, the recall walk, and the completion cursor.
 * Like the form and choice models it is immutable and reduced by intents, so a republish, a theme swap, or a core reload
 * keeps what the user typed. The surface model owns one per prompt and turns the effects a reduction returns into the
 * events the host sees; the terminal editor only mirrors `text`.
 *
 * @module @ephemeral-ai/mayfly/core/ui-interaction-prompt
 */
import { freezeWire } from '@ephemeral-ai/mayfly-ui'
import type { MayflyPromptNode, MayflyPromptRecall } from '@ephemeral-ai/mayfly-ui'
import type { UiControlAddress } from './ui-interaction-tree.ts'

/** How many completion rows the list shows at once. */
export const PROMPT_COMPLETION_ROWS = 5

/** The recall walk: the entry on show, and the draft that `↓` past the newest entry returns. */
export interface UiPromptRecall {
  /** Index into `definition.recall`; `-1` between the draft and the first entry, after the entry on show was withdrawn. */
  readonly index: number
  readonly draft: string
  /** The entry on show, to find it again when the host republishes the list; absent once it was withdrawn. */
  readonly entry?: MayflyPromptRecall
}

/** The immutable draft state of one prompt. */
export interface UiPromptModel {
  readonly address: UiControlAddress
  readonly definition: MayflyPromptNode
  /** The buffer, paste markers expanded. */
  readonly text: string
  /** The `reset.rev` the draft last took; a node naming another one replaces the draft. */
  readonly resetRev: number | undefined
  /** The id of the token the first `Backspace` selected. */
  readonly selectedToken: string | undefined
  readonly recall: UiPromptRecall | undefined
  readonly completion: { readonly index: number, readonly hidden: boolean, readonly signature: string }
  /** Counts the changes to `text`. */
  readonly revision: number
}

export type UiPromptIntent =
  | { readonly kind: 'edit', readonly value: string }
  /** `Backspace` on an empty buffer: the first press selects the last token, the second removes it. */
  | { readonly kind: 'backspace' }
  /** Any other key leaves a selected token alone again. */
  | { readonly kind: 'deselect' }
  | { readonly kind: 'recall', readonly direction: 'older' | 'newer' }
  | { readonly kind: 'complete-move', readonly delta: -1 | 1 }
  | { readonly kind: 'complete-accept' }
  | { readonly kind: 'complete-dismiss' }
  | { readonly kind: 'submit' }

/** What a reduction asks the surface model to tell the host. */
export type UiPromptEffect =
  | { readonly kind: 'value-change', readonly value: string, readonly draftRevision: number }
  | { readonly kind: 'recall-change', readonly source: 'queued' | 'history' | 'draft', readonly index: number }
  | { readonly kind: 'token-remove', readonly tokenId: string }
  | { readonly kind: 'completion-accept', readonly itemId: string }
  | { readonly kind: 'completion-dismiss' }
  | { readonly kind: 'submit', readonly text: string, readonly tokens: readonly string[], readonly draftRevision: number }

export interface UiPromptReduction {
  readonly model: UiPromptModel
  readonly effects: readonly UiPromptEffect[]
}

function signature(definition: MayflyPromptNode): string {
  return (definition.completions?.items ?? []).map(item => item.id).join('\0')
}

/** The model a prompt starts with: its `reset`, else its `value`, else nothing. */
export function createPromptModel(address: UiControlAddress, definition: MayflyPromptNode): UiPromptModel {
  return freezeWire({
    address,
    definition,
    text: definition.reset?.value ?? definition.value ?? '',
    resetRev: definition.reset?.rev,
    selectedToken: undefined,
    recall: undefined,
    completion: { index: 0, hidden: false, signature: signature(definition) },
    revision: 0,
  })
}

function sameEntry(left: MayflyPromptRecall, right: MayflyPromptRecall): boolean {
  return left.kind === right.kind && left.text === right.text
}

/** The recall walk against the list the host published now: it follows its entry, or the place the entry left. */
function reconcileRecall(recall: UiPromptRecall | undefined, entries: readonly MayflyPromptRecall[]): UiPromptRecall | undefined {
  if (recall === undefined) return undefined
  if (recall.entry === undefined) return recall.index >= entries.length ? { ...recall, index: entries.length - 1 } : recall
  const same = entries[recall.index]
  if (same !== undefined && sameEntry(same, recall.entry)) return recall
  const found = entries.findIndex(entry => sameEntry(entry, recall.entry!))
  if (found >= 0) return { ...recall, index: found }
  // The entry was withdrawn (a recalled queued message leaves the queue): the walk stands where it was, before the next one.
  return { index: Math.min(recall.index, entries.length) - 1, draft: recall.draft }
}

/**
 * The model for a republished definition. The draft survives; a new `reset.rev` replaces it, a token that is gone stops
 * being selected, and the recall walk and the completion cursor follow the lists the host published.
 */
export function reconcilePrompt(previous: UiPromptModel, definition: MayflyPromptNode): UiPromptModel {
  if (definition === previous.definition) return previous
  const reset = definition.reset !== undefined && definition.reset.rev !== previous.resetRev
  const items = definition.completions?.items.length ?? 0
  const changed = signature(definition) !== previous.completion.signature
  const completion = changed
    ? { index: 0, hidden: false, signature: signature(definition) }
    : { ...previous.completion, index: Math.min(previous.completion.index, Math.max(0, items - 1)) }
  const selected = previous.selectedToken !== undefined && !reset && (definition.tokens ?? []).some(token => token.id === previous.selectedToken)
  return freezeWire({
    ...previous,
    definition,
    ...(reset ? { text: definition.reset!.value, resetRev: definition.reset!.rev, recall: undefined, revision: previous.revision + 1 }
      : { recall: reconcileRecall(previous.recall, definition.recall ?? []) }),
    selectedToken: selected ? previous.selectedToken : undefined,
    completion: reset ? { ...completion, index: 0, hidden: false } : completion,
  })
}

/** Whether the completion list is on show: the host offered rows and the user has not dismissed them. */
export function promptCompletionsOpen(model: UiPromptModel): boolean {
  return (model.definition.completions?.items.length ?? 0) > 0 && !model.completion.hidden
}

/** The first row of the completion window that keeps the cursor row in view. */
export function promptCompletionStart(model: UiPromptModel): number {
  return Math.max(0, model.completion.index - (PROMPT_COMPLETION_ROWS - 1))
}

/** Whether `↑`/`↓` walk the recall now: there is something to recall, and the buffer is empty or already a recalled entry. */
export function promptRecallActive(model: UiPromptModel): boolean {
  return (model.definition.recall?.length ?? 0) > 0 && (model.text === '' || model.recall !== undefined)
}

function withText(model: UiPromptModel, text: string, extra: Partial<UiPromptModel> = {}): UiPromptModel {
  return freezeWire({ ...model, text, revision: model.revision + 1, completion: { ...model.completion, index: 0, hidden: false }, ...extra })
}

/** Apply one intent. A reduction that changes nothing returns the same model and no effects. */
export function reducePrompt(model: UiPromptModel, intent: UiPromptIntent): UiPromptReduction {
  const none: UiPromptReduction = { model, effects: [] }
  const tokens = model.definition.tokens ?? []
  switch (intent.kind) {
    case 'edit': {
      if (intent.value === model.text) return none
      const next = withText(model, intent.value, { selectedToken: undefined, recall: undefined })
      return { model: next, effects: [{ kind: 'value-change', value: intent.value, draftRevision: next.revision }] }
    }
    case 'deselect': return model.selectedToken === undefined ? none : { model: freezeWire({ ...model, selectedToken: undefined }), effects: [] }
    case 'backspace': {
      if (model.text !== '' || tokens.length === 0) return none
      const selected = tokens.find(token => token.id === model.selectedToken)
      if (selected === undefined) return { model: freezeWire({ ...model, selectedToken: tokens.at(-1)!.id }), effects: [] }
      return { model: freezeWire({ ...model, selectedToken: undefined }), effects: [{ kind: 'token-remove', tokenId: selected.id }] }
    }
    case 'recall': {
      if (!promptRecallActive(model)) return none
      const entries = model.definition.recall!
      const walk = model.recall
      let index: number
      if (intent.direction === 'older') index = walk === undefined ? 0 : Math.min(entries.length - 1, walk.index + 1)
      else {
        if (walk === undefined) return none
        index = walk.index - 1
      }
      if (walk !== undefined && index === walk.index) return none
      if (index < 0) {
        const next = withText(model, walk!.draft, { recall: undefined, selectedToken: undefined })
        return { model: next, effects: [{ kind: 'recall-change', source: 'draft', index: -1 }, ...(walk!.draft === model.text ? [] : [{ kind: 'value-change' as const, value: next.text, draftRevision: next.revision }])] }
      }
      const entry = entries[index]!
      const next = withText(model, entry.text, { recall: { index, draft: walk?.draft ?? model.text, entry }, selectedToken: undefined })
      return { model: next, effects: [{ kind: 'recall-change', source: entry.kind, index }, { kind: 'value-change', value: entry.text, draftRevision: next.revision }] }
    }
    case 'complete-move': {
      if (!promptCompletionsOpen(model)) return none
      const items = model.definition.completions!.items
      const index = Math.max(0, Math.min(items.length - 1, model.completion.index + intent.delta))
      return index === model.completion.index ? none : { model: freezeWire({ ...model, completion: { ...model.completion, index } }), effects: [] }
    }
    case 'complete-accept': {
      const item = model.definition.completions?.items[model.completion.index]
      if (!promptCompletionsOpen(model) || item === undefined) return none
      return { model, effects: [{ kind: 'completion-accept', itemId: item.id }] }
    }
    case 'complete-dismiss': {
      if (!promptCompletionsOpen(model)) return none
      return { model: freezeWire({ ...model, completion: { ...model.completion, hidden: true } }), effects: [{ kind: 'completion-dismiss' }] }
    }
    case 'submit': {
      if (model.text.trim() === '' && tokens.length === 0) return none
      const next = withText(model, '', { recall: undefined, selectedToken: undefined })
      return { model: next, effects: [{ kind: 'submit', text: model.text, tokens: tokens.map(token => token.id), draftRevision: next.revision }] }
    }
  }
}
