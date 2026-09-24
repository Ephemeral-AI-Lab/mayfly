/** Web-aligned roster, task board, and ordinary teammate navigation.
 * @module @ephemeral-ai/mayfly/interaction/team-command
 */
import type { Context } from '@deepseek-ai/cordis'
import type { TeamProjection, TeamTaskView } from '@deepseek-ai/dsh-experimental-agent-team/client'
import { ui, type MayflyOverlayHandle, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { openUiOverlay } from './ui-overlay.ts'

export const name = 'mayfly-team-command'
export const inject = ['commands', 'mayflyCurrentAgent', 'mayflyOverlays', 'mayflyStatus', 'sessionProjections', 'agents']

/** Current roster activity is distinct from durable provisioning and task state. */
export function teamNode(team: TeamProjection | undefined, current: string, activity: ReadonlyMap<string, string>, models: ReadonlyMap<string, string>): MayflyUiNode {
  return ui.surface({ title: 'Agent Team', chrome: 'overlay', child: ui.stack.column([
    ...(team?.failure === undefined ? [] : [ui.text(team.failure, { tone: 'danger' })]),
    ...(team === undefined ? [ui.empty({ title: 'Team unavailable', description: 'Start or resume a lead session to inspect its team.' })] : [
      ui.text(`Members (${team.members.length}) · Tasks (${team.tasks.length})`),
      ui.list({ id: 'team-members', role: 'browse', filterable: true, selectedIds: [], items: team.members.map(member => ({
        id: member.id, label: member.name, badge: member.id === current ? 'Current chat' : member.role,
        disabled: member.id === current || member.phase !== 'active',
        detail: [member.phase === 'active' ? activity.get(member.id) ?? 'inactive' : member.phase, models.get(member.id), member.error].filter(Boolean).join(' · '),
      })) }),
      ui.list({ id: 'team-tasks', role: 'browse', filterable: true, selectedIds: [], items: team.tasks.map(task => ({
        id: task.id, label: task.subject, badge: task.status === 'pending' ? task.ready ? 'ready' : 'blocked' : task.status,
        detail: `${task.id} · ${task.ownerName ?? 'unowned'}${task.blockedBy.length === 0 ? '' : ` · blocked by ${task.blockedBy.join(', ')}`}`,
      })), empty: ui.empty({ title: 'No shared tasks' }) }),
    ]),
    ui.actions({ id: 'team-actions', items: [{ id: 'close', label: 'Close', dismiss: true }] }),
  ]) })
}

function taskNode(task: TeamTaskView): MayflyUiNode {
  return ui.surface({ title: task.subject, chrome: 'overlay', child: ui.stack.column([
    ui.scroll(ui.text([task.description, `Owner: ${task.ownerName ?? 'unowned'}`, `Status: ${task.status}`, `Ready: ${task.ready}`, `Blocked by: ${task.blockedBy.join(', ')}`, `Advisory write scopes: ${task.writeScopes.join(', ')}`, ...task.writeScopeWarnings].join('\n')), { scrollbar: true }),
    ui.actions({ id: 'task-actions', items: [{ id: 'close', label: 'Close', dismiss: true }] }),
  ]) })
}

export function apply(ctx: Context): void {
  let handle: MayflyOverlayHandle | undefined
  let taskDetail: MayflyOverlayHandle | undefined
  let taskId: string | undefined
  let projection: TeamProjection | undefined
  let leadId: string | undefined
  const status = ctx.mayflyStatus.register({ id: 'mayfly.team', priority: 2, overflow: 'hide' }, null)
  const read = () => {
    const primary = ctx.mayflyCurrentAgent.primary()
    leadId = primary === null ? undefined : String(primary.id)
    projection = primary === null ? undefined : ctx.sessionProjections.snapshot(primary.session, ['agentTeam']).values.agentTeam
    if (taskDetail?.closed === false) {
      const task = projection?.tasks.find(task => task.id === taskId)
      if (task === undefined) taskDetail.close()
      else taskDetail.set(taskNode(task))
    }
    const view = ctx.mayflyCurrentAgent.view()
    const current = view.displayed === 'auxiliary' ? view.auxiliary!.sessionId : leadId ?? ''
    const activity = new Map<string, string>()
    const models = new Map<string, string>()
    for (const member of projection?.members ?? []) {
      const agent = ctx.agents.get(member.id)
      if (agent === undefined) continue
      activity.set(member.id, agent.status === 'running' ? 'running' : 'inactive')
      const selection = ctx.sessionProjections.snapshot(agent.session, ['modelSelection']).values.modelSelection
      if (selection?.next != null) models.set(member.id, selection.next.model)
    }
    status.set(projection === undefined ? null : ui.text(`Team ${projection.members.length} · ${projection.tasks.filter(task => task.status !== 'completed').length} tasks`))
    if (handle?.closed === false) handle.set(teamNode(projection, current, activity, models))
    return teamNode(projection, current, activity, models)
  }
  ctx.commands.register({ name: 'team', description: 'Inspect the Team roster and shared tasks', handler: () => {
    handle = openUiOverlay(ctx, { id: 'mayfly.team', title: 'Agent Team', presentation: 'editor', capturing: true, onEvent: { action: event => {
      if (event.kind !== 'selection-accept') return { kind: 'completed' }
      const id = event.selectedIds[0]
      if (event.controlId === 'team-tasks') {
        const task = projection?.tasks.find(task => task.id === id)
        if (task === undefined) return { kind: 'cancelled' }
        taskId = task.id
        taskDetail = openUiOverlay(ctx, { id: 'mayfly.team.task', title: task.subject, presentation: 'editor', capturing: true, onEvent: { action: () => ({ kind: 'completed' }) } },
          taskNode(task), { reopen: 'replace' })
        return { kind: 'completed' }
      }
      const member = projection?.members.find(member => member.id === id)
      if (member === undefined || member.phase !== 'active' || leadId === undefined) return { kind: 'cancelled' }
      if (member.role === 'lead') ctx.mayflyCurrentAgent.closeAuxiliary()
      else ctx.mayflyCurrentAgent.openAuxiliary({ kind: 'subagent', sessionId: member.id, parentSessionId: leadId, label: member.name, mode: 'continuable' })
      return { kind: 'completed', dismiss: true }
    } } }, read(), { reopen: 'replace', onClosed: () => taskDetail?.close() })
    return { kind: 'success' }
  } })
  ctx.effect(() => ctx.sessionProjections.onChanged((session, key) => {
    if ((String(session.id) === leadId && key === 'agentTeam') || key === 'modelSelection') read()
  }))
  ctx.effect(() => ctx.mayflyCurrentAgent.subscribeView(() => {
    handle?.close()
    read()
  }))
  ctx.on('agent/status', () => { read() })
  ctx.on('agent/created', () => { read() })
  ctx.on('agent/disposed', () => { read() })
  ctx.effect(() => () => { status.dispose() })
}
