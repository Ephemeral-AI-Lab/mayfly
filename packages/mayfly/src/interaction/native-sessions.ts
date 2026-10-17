/** Workspace-first session browsing over the native Session Controller
 * catalog and the native Workspace registry.
 * @module @ephemeral-ai/mayfly/interaction/native-sessions
 */
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { ui, type MayflyOverlayHandle } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/locale.ts'
import type {} from '../app/conversation-views.ts'
import { createSessionListCache, refreshSessionList, sessionListRows } from './session-list-reads.ts'
import { sessionWorkspaceItem, sessionWorkspacePlacements, sessionWorkspaces, type SessionWorkspace } from './session-workspaces-model.ts'
import { openSessionWorkspace, type SessionWorkspacePanel, type SessionWorkspaceScope } from './session-workspace-panel.ts'
import { openUiOverlay } from './ui-overlay.ts'

/**
 * Browse sessions by native workspace: list the Session Controller catalog,
 * group it by `workspaceRegistry` identity, and open one scope.
 * @param ctx - the commands context.
 * @param signal - the dispatching command's cancellation.
 * @param t - interaction translator.
 * @param cache - the listing cache retained by the command Fiber.
 * @returns the command result.
 */
export async function openSessions(ctx: Context, signal: AbortSignal, t: MayflyTranslate, cache = createSessionListCache(ctx)): Promise<CommandResult> {
  if (signal.aborted || ctx.mayflyOverlays.focus('mayfly.sessions.workspace') || ctx.mayflyOverlays.focus('mayfly.sessions')) return { kind: 'success' }
  const lifetime = new AbortController()
  const abort = AbortSignal.any([signal, lifetime.signal])
  const home = homedir()
  let handle: MayflyOverlayHandle | undefined
  let selected: SessionWorkspacePanel | undefined
  let groups: readonly SessionWorkspace[] = []
  let loading = true
  let message = ''
  let busy = false
  let repaint: ReturnType<typeof setTimeout> | undefined
  const cleanup = ctx.effect(() => () => { lifetime.abort(); clearTimeout(repaint) })
  const currentCwd = () => ctx.mayflyConversations.primary()?.session.header.cwd ?? process.cwd()
  /** The registered workspace holding the displayed conversation, when one does. */
  const currentWorkspaceId = async () => {
    try {
      return (await ctx.workspaceRegistry.resolveByPath(currentCwd()))?.id
    } catch {
      return undefined
    }
  }
  /** Group the retained catalog by native workspace identity. */
  const adopt = async (): Promise<void> => {
    const catalog = sessionListRows(ctx, cache)
    const placements = await sessionWorkspacePlacements(ctx.workspaceRegistry, catalog)
    const current = await currentWorkspaceId()
    groups = sessionWorkspaces(ctx.workspaceRegistry.list(), catalog, placements, current)
  }
  const node = () => ui.surface({ title: t('Sessions · Workspaces'), chrome: 'overlay', child: ui.stack.column([
    ...(loading ? [ui.loader({ message: t('Loading workspaces…') })] : []),
    ...(message === '' ? [] : [ui.text(message, { tone: 'warning' })]),
    ...(groups.length === 0 && loading ? [] : [ui.list({
      id: 'workspaces', role: 'browse', filterable: true, filterMode: 'slash', selectedIds: [],
      items: groups.map(group => sessionWorkspaceItem(group, currentCwd(), home, t)),
      empty: ui.empty({ title: t('No workspaces') }),
    })]),
    ui.actions({ id: 'workspace-actions', items: [
      { id: 'refresh', label: t('Refresh'), hintLabel: t('refresh'), semantic: 'refresh', hidden: true, disabled: loading },
      { id: 'search-all', label: t('Search all contents'), hintLabel: t('search all'), semantic: 'search', hidden: true, disabled: loading },
    ] }),
  ]) })
  const publish = () => {
    if (!abort.aborted && handle?.closed === false && !busy) handle.set(node())
  }
  const refresh = async (readSignal: AbortSignal) => {
    loading = true
    try {
      await refreshSessionList(ctx, cache, readSignal)
      readSignal.throwIfAborted()
      await adopt()
      readSignal.throwIfAborted()
      message = ''
    } finally {
      loading = false
      publish()
    }
  }
  const open = (scope: SessionWorkspaceScope) => {
    selected?.handle.close()
    selected = openSessionWorkspace(ctx, abort, t, cache, {
      scope, loading: () => loading, refresh,
      changed: publish,
      closeAll: () => handle?.close(),
      onClosed: () => { selected = undefined },
    })
  }
  try {
    handle = openUiOverlay(ctx, {
      id: 'mayfly.sessions', title: t('Sessions · Workspaces'), presentation: 'editor', capturing: true,
      onEvent: { action: async (event, context) => {
        busy = true
        const operation = AbortSignal.any([abort, context.signal])
        try {
          if (event.kind === 'selection-accept' && event.controlId === 'workspaces') {
            const workspace = groups.find(item => item.id === event.selectedIds[0])
            if (workspace === undefined) return { kind: 'failed', message: t('Workspace is no longer listed; refresh the catalog.') }
            open(workspace.workspaceId === undefined
              ? { kind: 'other' }
              : { kind: 'workspace', workspaceId: workspace.workspaceId, path: workspace.cwd ?? '', title: workspace.title ?? workspace.label ?? '' })
          } else if (event.kind === 'activate' && event.actionId === 'search-all') open({ kind: 'search' })
          else if (event.kind === 'activate' && event.actionId === 'refresh') {
            context.report({ message: t('Loading workspaces…'), severity: 'info' })
            await refresh(operation)
            if (operation.aborted) return { kind: 'cancelled' }
            selected?.catalogChanged()
            return { kind: 'accepted', node: node(), source: [] }
          }
          return { kind: 'completed' }
        } finally {
          busy = false
          clearTimeout(repaint)
          if (!abort.aborted) repaint = setTimeout(publish, 0)
        }
      } },
    }, node(), { signal: abort, reopen: 'replace', onClosed: () => { selected?.handle.close(); cleanup() } })
    void refresh(abort).then(() => {
      if (!abort.aborted) selected?.catalogChanged()
    }).catch(error => {
      if (abort.aborted) return
      message = t('Could not load workspaces: {error}', { error: String(error) })
      publish()
      selected?.catalogChanged(message)
    })
    return { kind: 'success' }
  } catch (error) {
    cleanup()
    return { kind: 'error', text: String(error) }
  }
}
