/** Native session projections and application metadata in shared readonly overlays.
 * @module @ephemeral-ai/mayfly/interaction/session-commands
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-session-stats'
import { isDeepStrictEqual } from 'node:util'
import { ui, type MayflyOverlayHandle, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { MAYFLY_VERSION } from '../transcript/banner-content.ts'
import { CHANGELOG_ENTRIES } from './changelog-content.ts'
import { interactionTranslator, mountInteractionLocale, observeInteractionLocale } from './locale.ts'
import { openUiOverlay } from './ui-overlay.ts'
import { openAgentOverlay } from './agent-overlay.ts'
import { changelogNode, statusNode, usageNode, versionNode, type SessionInfoFacts } from './session-info-model.ts'

export const name = 'mayfly-session-information'
export const inject = ['commands', 'mayflyOverlays']
export interface Config { readonly displayVersion?: string }
const KEYS = ['sessionStats', 'tokenUsage', 'contextPressure', 'contextBreakdown', 'modelSelection'] as const
const HARNESS_LINE = '0.1.2-alpha.5'

/** One native snapshot gives every displayed projection the same session cursor. */
export function sessionInfoFacts(ctx: Context, agent: Agent): SessionInfoFacts {
  const values = ctx.sessionProjections.snapshot(agent.session, KEYS).values
  const usage = values.tokenUsage
  const pressure = values.contextPressure
  const breakdown = values.contextBreakdown
  const model = values.modelSelection?.next ?? values.modelSelection?.lastUsed ?? ctx.get('agentDefaultModel')?.currentSelection()
  return {
    id: String(agent.id), createdAt: agent.session.header.createdAt, status: agent.status,
    ...agent.session.header.cwd === undefined ? {} : { cwd: agent.session.header.cwd },
    turns: values.sessionStats?.turns ?? 0, steps: values.sessionStats?.steps ?? 0,
    ...model === undefined ? {} : { model },
    usage: {
      buckets: { input: usage?.uncachedInputTokens ?? 0, cacheRead: usage?.cacheReadTokens ?? 0, cacheWrite: usage?.cacheWriteTokens ?? 0, output: usage?.outputTokens ?? 0 },
      context: {
        ...pressure?.projectedTokens === undefined && pressure?.pressureTokens === undefined ? {} : { used: pressure.projectedTokens ?? pressure.pressureTokens },
        ...pressure?.contextWindow === undefined ? {} : { window: pressure.contextWindow },
      },
    },
    ...breakdown === undefined ? {} : { composition: { system: breakdown.systemTokens, tools: breakdown.toolsTokens, messages: breakdown.messageTokens } },
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  mountInteractionLocale(ctx)
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  const version = { mayfly: config.displayVersion ?? MAYFLY_VERSION, harness: HARNESS_LINE }
  const t = interactionTranslator(ctx)
  const frame = (title: string, body: MayflyUiNode, scrollable = true): MayflyUiNode => ui.surface({ title: t(title), chrome: 'overlay', padding: 1, child: ui.stack.column([
    ...(scrollable ? [ui.child(ui.scroll(body, { scrollbar: true }), { basis: 0, grow: 1, minSize: 1 })] : [body]),
    ui.actions({ id: 'information-actions', items: [{ id: 'refresh', label: t('Refresh') }, { id: 'close', label: t('Close'), dismiss: true }] }),
  ]) })
  for (const command of ['version', 'changelog'] as const) ctx.commands.register({
    name: command, description: t(command === 'version' ? 'Show the Mayfly and harness versions' : "Show the release changelog (what's new)"),
    handler: invocation => {
      if (lifetime.signal.aborted || invocation.signal.aborted) return { kind: 'success' }
      const id = `mayfly.${command}`
      if (ctx.mayflyOverlays.focus(id)) return { kind: 'success' }
      const view = () => frame(command === 'version' ? 'Version' : 'Changelog', command === 'version' ? versionNode(version) : changelogNode(CHANGELOG_ENTRIES, t), command !== 'version')
      const handle = openUiOverlay(ctx, { id, presentation: 'editor', capturing: true, scope: { kind: 'app', targetId: command }, onEvent: { action: event => {
        if (event.kind === 'activate' && event.actionId === 'refresh') handle.set(view())
        return { kind: 'completed' }
      } } }, view(), lifetime.signal)
      const offLocale = observeInteractionLocale(ctx, () => { handle.set(view()) })
      let cleanup!: () => void
      const off = ctx.mayflyOverlays.subscribe(delta => { if (delta.kind === 'remove' && delta.id === id && handle.closed) cleanup() })
      cleanup = ctx.effect(() => () => { offLocale(); off() })
      if (handle.closed) cleanup()
      return { kind: 'success' }
    },
  })
  ctx.inject(['mayflyCurrentAgent', 'sessionProjections'], owner => {
    for (const command of ['status', 'context'] as const) owner.commands.register({
      name: command, description: t(command === 'status' ? 'Show the session header, model, and context status' : 'Show token usage and the context window'),
      handler: async invocation => {
        const agent = invocation.agent
        if (lifetime.signal.aborted || invocation.signal.aborted) return { kind: 'success' }
        if (owner.mayflyCurrentAgent.current() !== agent) return { kind: 'error', text: t('no session is live yet') }
        const id = `mayfly.${command}`
        if (owner.mayflyOverlays.focus(id)) return { kind: 'success' }
        const read = () => {
          const title = command === 'status' ? 'Status' : 'Context'
          try {
            const facts = sessionInfoFacts(owner, agent)
            return { ok: true, node: frame(title, command === 'status' ? statusNode(facts, version, t) : usageNode(facts, t)) }
          } catch { return { ok: false, node: frame(title, ui.text(t('Session information unavailable'), { tone: 'danger' })) } }
        }
        let node = read().node
        let handle: MayflyOverlayHandle | undefined
        const refresh = () => {
          if (handle?.closed !== false) return false
          const result = read()
          const next = result.node
          if (!isDeepStrictEqual(next, node)) { node = next; handle.set(next) }
          return result.ok
        }
        let scheduled = false
        const schedule = () => {
          if (scheduled) return
          scheduled = true
          queueMicrotask(() => { scheduled = false; refresh() })
        }
        handle = await openAgentOverlay(owner, agent, { id, presentation: 'editor', capturing: true }, node, scope => {
          const offProjection = owner.sessionProjections.onChanged((session, key) => { if (session === agent.session && KEYS.some(item => item === key)) schedule() })
          scope.effect(() => offProjection)
          scope.on('agent/status', ({ agent: changed }) => { if (changed === agent) schedule() })
          scope.effect(() => observeInteractionLocale(scope, schedule))
          return event => event.kind === 'activate' && event.actionId === 'refresh' && !refresh() ? { kind: 'failed', message: t('Session information unavailable') } : { kind: 'completed' }
        }, lifetime.signal)
        if (invocation.signal.aborted) handle?.close()
        refresh()
        return { kind: 'success' }
      },
    })
  })
}
