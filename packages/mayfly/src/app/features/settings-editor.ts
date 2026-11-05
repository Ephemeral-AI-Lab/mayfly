/**
 * Local settings-document editing through the core's exclusive terminal suspension.
 * @module @ephemeral-ai/mayfly/app/features/settings-editor
 */

import { editLocalText, resolveExternalEditorCommand } from '../local/external-editor.ts'
import type { RemoteSettingsEdit } from './settings.ts'

/** Integrator-owned terminal handoff; no terminal mode is managed by this module. */
interface RemoteSettingsEditorOptions {
  readonly suspend: <T>(run: () => Promise<T>) => Promise<T>
  readonly command?: () => string | undefined
  readonly edit?: typeof editLocalText
}

/** Create a settings hook that edits locally and ignores aborted editor results. */
export function createRemoteSettingsEditor(options: RemoteSettingsEditorOptions): RemoteSettingsEdit {
  let editing = false
  return async (_client, content, signal) => {
    if (signal.aborted) return undefined
    if (editing) throw new Error('The external editor is already open')
    const command = options.command?.() ?? resolveExternalEditorCommand()
    if (command === undefined || command.trim() === '') throw new Error('Set $VISUAL or $EDITOR to edit the settings document')
    editing = true
    try {
      return await options.suspend(async () => {
        if (signal.aborted) return undefined
        const edited = await (options.edit ?? editLocalText)(content, command, signal)
        return signal.aborted ? undefined : edited
      })
    } finally {
      editing = false
    }
  }
}
