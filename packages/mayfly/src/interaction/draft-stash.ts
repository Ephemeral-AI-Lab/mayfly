/**
 * Frontend-tree stash of the input editor's unsubmitted draft (text and
 * input mode) and its prompt history. A theme swap disposes the theme
 * provider fiber and Cordis reloads every `mayflyTheme` dependent —
 * including `mayfly-input`, whose editor component is rebuilt from scratch.
 * The parent state service survives the reload while the component does not,
 * so `mayfly-input` mirrors every edit into this state
 * through `onChange`, clears it when the text is consumed (submit/steer),
 * and restores it into the freshly mounted editor; `mayfly-editor-plus`
 * mirrors the prompt/bash mode the same way, so a bash draft reloads as
 * bash. The history mirrors beside it (after every submission) — pi-tui
 * keeps the history in the component, so without the stash a `/theme`
 * argument submission would vanish from Up-recall the moment its own
 * command rebuilds the editor.
 *
 * @module @ephemeral-ai/mayfly/interaction/draft-stash
 */

import type { MayflySubmittedDraft } from '../core/types.ts'

/** Draft, mode, and history owned by one frontend tree. */
export class DraftStash {
  private draft: MayflySubmittedDraft = { raw: '', pastes: new Map() }
  private inputMode: 'prompt' | 'bash' = 'prompt'
  private history: readonly string[] = []
  private historyPastes: readonly (ReadonlyMap<number, string> | undefined)[] = []

/**
 * Mirror the editor's current buffer into the stash.
 * @param draft - the raw text and its paste table, which a reload restores together.
 */
  stashDraft(draft: MayflySubmittedDraft): void { this.draft = draft }

/** Clear the draft stash; called when the draft is consumed (submitted/steered). */
  clearDraft(): void {
    this.draft = { raw: '', pastes: new Map() }
    this.inputMode = 'prompt'
  }

/**
 * Read the stashed draft.
 * @returns the preserved buffer and paste table; empty text when nothing is stashed.
 */
  getStashedDraft(): MayflySubmittedDraft { return this.draft }

/**
 * Mirror the editor's input mode into the stash.
 * @param mode - `'prompt'` or `'bash'`.
 */
  stashInputMode(mode: 'prompt' | 'bash'): void { this.inputMode = mode }

/**
 * Read the stashed input mode.
 * @returns the preserved mode; `'prompt'` when nothing was stashed.
 */
  getStashedInputMode(): 'prompt' | 'bash' { return this.inputMode }

/**
 * Mirror the editor's prompt history into the stash.
 * @param entries - the history entries, newest first.
 * @param pastes - the paste table of each entry, index for index, `undefined` for one with no pasted block.
 */
  stashHistory(entries: readonly string[], pastes: readonly (ReadonlyMap<number, string> | undefined)[] = []): void {
    this.history = [...entries]
    this.historyPastes = [...pastes]
  }

/**
 * Read the stashed history.
 * @returns the preserved entries, newest first; empty when nothing was
 *   stashed.
 */
  getStashedHistory(): readonly string[] { return this.history }

/**
 * Read the paste tables of the stashed history.
 * @returns one per entry, in the entries' order.
 */
  getStashedHistoryPastes(): readonly (ReadonlyMap<number, string> | undefined)[] { return this.historyPastes }

  clearAll(): void {
    this.clearDraft()
    this.history = []
    this.historyPastes = []
  }
}
