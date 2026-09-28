/** Workspace-first session browsing over native catalog headers.
 * @module @ephemeral-ai/mayfly/interaction/native-sessions
 */
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { ui, type MayflyOverlayHandle } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/index.ts'
import { createSessionListCache, refreshSessionList, sessionListHeaders } from './session-list-reads.ts'
import { sessionWorkspaceItem, sessionWorkspaces, type SessionWorkspace } from './session-workspaces-model.ts'
import { openSessionWorkspace, type SessionWorkspacePanel, type SessionWorkspaceScope } from './session-workspace-panel.ts'
import { openUiOverlay } from './ui-overlay.ts'

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
  const currentCwd = () => ctx.mayflyCurrentAgent.current()?.session.header.cwd ?? process.cwd()
  const adopt = () => { groups = sessionWorkspaces(sessionListHeaders(ctx, cache), currentCwd()) }
  const node = () => ui.surface({ title: t('Sessions · Workspaces'), chrome: 'overlay', child: ui.stack.column([
    ...(loading ? [ui.loader({ message: t('Loading workspaces…') })] : []),
    ...(message === '' ? [] : [ui.text(message, { tone: 'warning' })]),
    ...(groups.length === 0 && loading ? [] : [ui.list({
      id: 'workspaces', role: 'browse', filterable: true, selectedIds: [],
      items: groups.map(group => sessionWorkspaceItem(group, currentCwd(), home, t)),
      empty: ui.empty({ title: t('No workspaces') }),
    })]),
    ui.actions({ id: 'workspace-actions', items: [
      { id: 'refresh', label: t('Refresh'), disabled: loading },
      { id: 'search-all', label: t('Search all contents'), disabled: loading },
      { id: 'close', label: t('Close'), dismiss: true },
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
      adopt()
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
    adopt()
    handle = openUiOverlay(ctx, {
      id: 'mayfly.sessions', title: t('Sessions · Workspaces'), presentation: 'editor', capturing: true,
      onEvent: { action: async (event, context) => {
        busy = true
        const operation = AbortSignal.any([abort, context.signal])
        try {
          if (event.kind === 'selection-accept' && event.controlId === 'workspaces') {
            const workspace = groups.find(item => item.id === event.selectedIds[0])
            if (workspace === undefined) return { kind: 'failed', message: t('Workspace is no longer listed; refresh the catalog.') }
            open({ kind: 'workspace', cwd: workspace.cwd })
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
