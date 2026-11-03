/** Workspace-first session browsing over the native Session Controller
 * catalog and the native Workspace registry, opened as one editor panel.
 * @module @ephemeral-ai/mayfly/interaction/native-sessions
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { MayflyTranslate } from '../frontend/locale.ts'
import { createSessionListCache } from './session-list-reads.ts'
import { openSessionsPanel } from './session-workspace-panel.ts'

/**
 * Browse sessions by native workspace in the one sessions panel.
 * @param ctx - the commands context.
 * @param signal - the dispatching command's cancellation.
 * @param t - interaction translator.
 * @param cache - the listing cache retained by the command Fiber.
 * @returns the command result.
 */
export async function openSessions(ctx: Context, signal: AbortSignal, t: MayflyTranslate, cache = createSessionListCache(ctx)): Promise<CommandResult> {
  if (signal.aborted || ctx.mayflyOverlays.focus('mayfly.sessions')) return { kind: 'success' }
  try {
    openSessionsPanel(ctx, signal, t, cache)
    return { kind: 'success' }
  } catch (error) {
    return { kind: 'error', text: String(error) }
  }
}
