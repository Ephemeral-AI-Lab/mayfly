/**
 * What the decision card's events and hidden keys do for the plugins that settle a request: reading the choice and the note
 * back from an event, opening the request in `$EDITOR` (the request stays open while the editor runs), and copying it.
 *
 * @module @ephemeral-ai/mayfly/interaction/decision-actions
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MayflyUiActionEvent, MayflyUiActionReply } from '@ephemeral-ai/mayfly-ui'
import { DECISION } from '../components/decision-card.ts'
import type { MayflyTranslate } from '../frontend/locale.ts'
import { copyTextToClipboard } from './clipboard-write.ts'
import { resolveExternalEditorCommand, runExternalEditor } from './external-editor.ts'

/** What the card's events say: the choice made (absent for the note's Enter) and the note typed, trimmed. */
export interface DecisionRead {
  readonly action: 'choose' | 'send'
  readonly choice?: string
  readonly note: string
}

/**
 * Read a card's event. Only the two hidden actions that read the choice and the note settle anything.
 * @param event - an action event of the card's surface.
 * @returns the choice and the note, or `undefined` for any other event.
 */
export function readDecision(event: MayflyUiActionEvent): DecisionRead | undefined {
  if (event.kind !== 'activate' || event.inputs === undefined) return undefined
  if (event.actionId !== DECISION.choose && event.actionId !== DECISION.send) return undefined
  const value = event.inputs.forms[0]?.fields.find(field => field.id === DECISION.field)?.value
  const note = typeof value === 'string' ? value.trim() : ''
  if (event.actionId === DECISION.send) return { action: 'send', note }
  const choice = event.inputs.selections?.find(selection => selection.controlId === DECISION.options)?.selectedIds[0]
  return choice === undefined ? undefined : { action: 'choose', choice, note }
}

/**
 * Open a request's document in `$EDITOR` and come back to the card with the request still open: what the editor saves
 * changes nothing.
 * @param ctx - the plugin's context.
 * @param text - the diff, command, or plan to read.
 * @param t - translator for the interaction namespace.
 * @param signal - the operation's cancellation.
 * @returns the settlement of the key.
 */
export async function openInEditor(ctx: Context, text: string, t: MayflyTranslate, signal: AbortSignal): Promise<MayflyUiActionReply> {
  const screen = ctx.get('mayflyScreen')
  if (screen === undefined) return { kind: 'failed', message: t('The terminal is unavailable') }
  const command = resolveExternalEditorCommand(process.env, ctx.get('mayflyInteractionState')?.settingsSource().editorCommand ?? '')
  if (command === undefined) return { kind: 'failed', message: t('no editor configured ($VISUAL/$EDITOR)') }
  try {
    await screen.suspend(() => runExternalEditor(text, command))
    return signal.aborted ? { kind: 'cancelled' } : { kind: 'completed' }
  } catch {
    return signal.aborted ? { kind: 'cancelled' } : { kind: 'failed', message: t('The editor could not be opened') }
  }
}

/**
 * Copy a request's document to the clipboard.
 * @param text - what to copy.
 * @param done - the translated word for the notice on success.
 * @param failed - the translated word for the notice on failure.
 * @returns the settlement of the key, with the notice.
 */
export async function copyDocument(text: string, done: string, failed: string): Promise<MayflyUiActionReply> {
  try {
    await copyTextToClipboard(text)
    return { kind: 'completed', feedback: { message: done, severity: 'success' } }
  } catch (error) {
    return { kind: 'completed', feedback: { message: failed, severity: 'error', detail: error instanceof Error ? error.message : String(error) } }
  }
}
