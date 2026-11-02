/** Native Host-wide reminder catalog view over the Schedule service.
 * @module @ephemeral-ai/mayfly/interaction/schedule-command
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-schedule'
import type { ScheduleRecord } from '@deepseek-ai/dsh-schedule/client'
import { ui, type MayflyOverlayHandle } from '@ephemeral-ai/mayfly-ui'
import { openAgentOverlay } from './agent-overlay.ts'
import { interactionTranslator, mountInteractionLocale, observeInteractionLocale } from './locale.ts'

export const name = 'mayfly-schedule-command'
export const inject = ['commands', 'mayflyCurrentAgent', 'mayflyOverlays', 'mayflyStatus', 'tools']

import { scheduleNode, SCHEDULE_TICK_MS } from './schedule-model.ts'
export { scheduleNode, formatReminderFrequency, formatReminderRelative, SCHEDULE_TICK_MS } from './schedule-model.ts'

export function apply(ctx: Context): void {
  mountInteractionLocale(ctx)
  const t = interactionTranslator(ctx)
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  const status = ctx.mayflyStatus.register({ id: 'mayfly.schedule', priority: 2, overflow: 'hide' }, null)
  let generation = 0
  let records: readonly ScheduleRecord[] | undefined
  const listeners = new Set<() => void>()
  const render = () => {
    status.set(records?.length ? ui.text(t('Reminders {count}', { count: records.length })) : null)
    for (const listener of listeners) listener()
  }
  // Capability is an exact-Agent question: the Host Schedule service attaches
  // reminder tools to every root Agent it observes, so the Agent's visible
  // toolset answers both whether the service is mounted and whether this
  // Agent's scope carries the tools.
  const capable = (agent: Agent): boolean => {
    try {
      return ctx.tools.schemas(agent).some(schema => schema.name === 'schedule_create')
    } catch {
      return false
    }
  }
  const refresh = async (agent: Agent): Promise<void> => {
    const service = ctx.get('schedule')
    const currentGeneration = ++generation
    if (service === undefined || !capable(agent)) {
      records = undefined
      render()
      return
    }
    try {
      const next = await service.list({ sessionId: agent.session.id })
      if (lifetime.signal.aborted || generation !== currentGeneration || ctx.mayflyCurrentAgent.current() !== agent) return
      records = next
    } catch {
      if (lifetime.signal.aborted || generation !== currentGeneration || ctx.mayflyCurrentAgent.current() !== agent) return
      records = undefined
    }
    render()
  }
  const refreshCurrent = () => {
    const agent = ctx.mayflyCurrentAgent.current()
    if (agent === null) {
      generation++
      records = undefined
      render()
      return
    }
    void refresh(agent)
  }
  ctx.commands.register({ name: 'schedule', description: t('Inspect session reminders'), handler: async invocation => {
    const agent = invocation.agent
    const signal = AbortSignal.any([lifetime.signal, invocation.signal])
    if (signal.aborted || ctx.mayflyCurrentAgent.current() !== agent) return { kind: 'success' }
    const node = () => scheduleNode(records, Date.now(), t, ctx.get('mayflyLocale')?.snapshot.locale)
    let handle: MayflyOverlayHandle | undefined
    handle = await openAgentOverlay(ctx, agent, { id: 'mayfly.schedule', presentation: 'editor', capturing: true }, node(), owner => {
      const update = () => { if (handle?.closed === false) handle.set(node()) }
      listeners.add(update)
      owner.effect(() => ctx.on('schedule/changed', refreshCurrent))
      owner.effect(() => observeInteractionLocale(owner, update))
      const timer = setInterval(update, SCHEDULE_TICK_MS)
      timer.unref()
      owner.effect(() => () => { listeners.delete(update); clearInterval(timer) })
      refreshCurrent()
      return () => ({ kind: 'completed' })
    }, { signal, reopen: 'focus' })
    return { kind: 'success' }
  } })
  ctx.effect(() => ctx.mayflyCurrentAgent.subscribe(() => refreshCurrent()))
  ctx.effect(() => ctx.on('schedule/changed', refreshCurrent))
  ctx.effect(() => observeInteractionLocale(ctx, () => render()))
  refreshCurrent()
  ctx.effect(() => () => status.dispose())
}
