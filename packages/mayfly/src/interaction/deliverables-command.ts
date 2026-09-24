/** Explicit file actions over recorded native deliveries and the selected filesystem.
 * @module @ephemeral-ai/mayfly/interaction/deliverables-command
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import { ui, type MayflyOverlayHandle } from '@ephemeral-ai/mayfly-ui'
import type {} from '../conversation/deliverables.ts'
import { openAgentOverlay } from './agent-overlay.ts'
import { copyTextToClipboard } from './clipboard-write.ts'

export const name = 'mayfly-deliverables-command'
export const inject = ['commands', 'sessionProjections', 'sessionController', 'mayflyCurrentAgent', 'mayflyOverlays']

export function apply(ctx: Context): void {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  ctx.commands.register({ name: 'files', description: 'Browse files delivered by the agent', handler: async invocation => {
    const agent = invocation.agent
    if (ctx.mayflyCurrentAgent.current() !== agent) return { kind: 'error', text: 'No current Agent' }
    const files = () => ctx.sessionProjections.snapshot(agent.session, ['mayflyDeliverables']).values.mayflyDeliverables ?? []
    const node = () => ui.surface({ title: 'Delivered files', chrome: 'overlay', child: ui.stack.column([
      ui.list({ id: 'files', role: 'browse', filterable: true, selectedIds: [], items: files().map(file => ({ id: file.id, label: file.path, ...(file.description === undefined ? {} : { detail: file.description }) })), empty: ui.empty({ title: 'No delivered files' }) }),
      ui.actions({ id: 'files-actions', items: [{ id: 'close', label: 'Close', dismiss: true }] }),
    ]) })
    let handle: MayflyOverlayHandle | undefined
    handle = await openAgentOverlay(ctx, agent, { id: 'mayfly.files', title: 'Delivered files', presentation: 'editor', capturing: true }, node(), owner => {
      owner.effect(() => ctx.sessionProjections.onChanged((session, key) => { if (session === agent.session && key === 'mayflyDeliverables') handle?.set(node()) }))
      return async (event, context) => {
        if (event.kind !== 'selection-accept') return { kind: 'completed' }
        const file = files().find(file => file.id === event.selectedIds[0])
        if (file === undefined) return { kind: 'cancelled' }
        const fs = agent.ctx.fs
        const target = await fs.resolve(file.path, { ...(agent.session.header.cwd === undefined ? {} : { cwd: agent.session.header.cwd }), signal: context.signal })
        const stat = await fs.stat(target, context.signal)
        if (context.signal.aborted || ctx.mayflyCurrentAgent.current() !== agent) return { kind: 'cancelled' }
        const path = fs.processPath(target)
        await openAgentOverlay(owner, agent, { id: 'mayfly.files.detail', title: file.path, presentation: 'editor', capturing: true }, ui.surface({ title: file.path, chrome: 'overlay', child: ui.stack.column([
          ui.text(`${file.description ?? ''}\n${target.displayPath}\n${stat === undefined ? 'File unavailable' : `${stat.type} · ${stat.size ?? 'unknown'} bytes`}`),
          ui.actions({ id: 'file-actions', items: [
            { id: 'copy', label: 'Copy path' },
            ...(stat?.type === 'file' ? [{ id: 'preview', label: 'Preview text' }, ...(ctx.sessionController.canOpenWorkspacePath() ? [{ id: 'open', label: 'Open' }] : [])] : []),
            { id: 'close', label: 'Close', dismiss: true },
          ] }),
        ]) }), scope => async (action, operation) => {
          if (action.kind !== 'activate') return { kind: 'completed' }
          if (action.actionId === 'copy') { await copyTextToClipboard(path)
          return { kind: 'completed', feedback: { severity: 'success', message: 'Path copied' } } }
          if (action.actionId === 'open') { await ctx.sessionController.openWorkspacePath({ path }, operation.signal)
          return { kind: 'completed', feedback: { severity: 'info', message: 'Open request handed to the host application' } } }
          if (action.actionId === 'preview') {
            const bytes = await fs.readBytes(target, operation.signal, 256 * 1024)
            const text = bytes.includes(0) ? 'Binary file; use Open in an external application.' : new TextDecoder().decode(bytes)
            await openAgentOverlay(scope, agent, { id: 'mayfly.files.preview', title: file.path, presentation: 'editor', capturing: true }, ui.surface({ title: file.path, chrome: 'overlay', child: ui.stack.column([
              ui.scroll(ui.text(text), { scrollbar: true }), ui.actions({ id: 'preview-actions', items: [{ id: 'close', label: 'Close', dismiss: true }] }),
            ]) }), () => () => ({ kind: 'completed' }), { signal: lifetime.signal, reopen: 'replace' })
          }
          return { kind: 'completed' }
        }, { signal: lifetime.signal, reopen: 'replace' })
        return { kind: 'completed' }
      }
    }, { signal: lifetime.signal, reopen: 'focus' })
    return { kind: 'success' }
  } })
}
