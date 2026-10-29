/**
 * Official Goal projection, activation, revision-checked writes, and Mayfly view.
 * @module @ephemeral-ai/mayfly/remote/features/goal
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { panel, ui, type MayflyPaneRegistration, type MayflyUiActionEvent, type MayflyUiActionReply } from '@ephemeral-ai/mayfly-ui'
import { memoizedLocaleTranslator, type MayflyTranslate } from '@ephemeral-ai/mayfly/frontend'
import type { HostClient } from '../../client/types.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from '../features.ts'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'
import {
  remoteGoalPanel,
  remoteGoalSummary,
  type RemoteGoalVerb,
  type RemoteGoalView,
} from '../panels/goal.ts'
import { requestOverlay, type RemoteRequestOverlay } from '../interactions/request-overlay.ts'
import { isRemoteFeatureSelection } from '../interactions/selection.ts'
import { RemoteFeatureLifecycle } from './lifecycle.ts'

const GOAL_DONE_LINGER_MS = 5_000
const USAGE = 'Usage: /goal [<objective>|create <objective>|edit <objective>|pause|resume|complete|clear]'

const zh: Readonly<Record<string, string>> = {
  'Set or view the goal for a long-running task': '设置或查看长任务目标',
  'No goal is currently set.': '当前未设置目标。',
  'Goal created': '目标已创建',
  'Goal updated': '目标已更新',
  'Goal paused': '目标已暂停',
  'Goal resumed': '目标已继续',
  'Goal complete': '目标已完成',
  'Goal cleared': '目标已清除',
  'Goal': '目标',
  'Edit goal': '编辑目标',
  'Objective': '目标内容',
  'Maximum rounds': '最大轮数',
  'Save': '保存',
  'The goal changed; open it again': '目标已变化，请重新打开',
  'No current goal': '当前没有目标',
  'Goal blocked · {code}: {message}': '目标受阻 · {code}：{message}',
  'goal': '目标',
  'resume': '继续',
  'pause': '暂停',
  'complete': '完成',
  'clear': '清除',
  'Clear': '清除',
  'Clear the goal?': '清除目标？',
  'Its history stays in the session log.': '其历史仍保留在会话日志中。',
  'blocked · {code}': '受阻 · {code}',
}

/** Exact official Goal view after projection and activation reconciliation. */
type GoalResult = Extract<Awaited<ReturnType<HostClient['remote']['goals']['get']>>, { readonly ok: true }>['value']

interface GoalEditorResult {
  readonly objective: string
  readonly maxGoalRounds?: number
}

class RemoteGoalController {
  private readonly options: RemoteFeatureContext
  private readonly t: MayflyTranslate
  private readonly lifecycle: RemoteFeatureLifecycle
  private readonly hostListeners = new Map<HostClient, () => void>()
  private readonly notifications: ReturnType<RemoteFeatureContext['ctx']['mayflyUiInteraction']['createNotificationOwner']>
  private readonly pane: MayflyPaneRegistration
  private readonly offTopology: () => void
  private goal: RemoteGoalView | undefined
  private done: { readonly rounds: number, total: number } | undefined
  private tracked: string | undefined
  private refreshTicket = 0
  private doneTimer: ReturnType<typeof setTimeout> | undefined
  private stopProjection: (() => void) | undefined
  private browser: RemoteBrowserPanel | undefined
  private editor: RemoteRequestOverlay<GoalEditorResult | undefined> | undefined
  private disposed = false

  constructor(options: RemoteFeatureContext) {
    this.options = options
    this.t = memoizedLocaleTranslator(options.ctx, 'remote-goal').translate
    this.lifecycle = new RemoteFeatureLifecycle(options, this.attach)
    this.notifications = options.ctx.mayflyUiInteraction.createNotificationOwner('remote.goal')
    this.pane = options.ctx.mayflyPanes.register({
      id: 'mayfly.view.goal',
      placement: 'views',
      priority: 13,
      onEvent: { action: event => this.act(event) },
    }, null)
    this.offTopology = options.hosts.subscribe(this.reconcileHosts)
    options.ctx.effect(() => options.ctx.mayflyLocale.register('remote-goal', {
      en: Object.freeze(Object.fromEntries(Object.keys(zh).map(key => [key, key]))),
      zh,
    }))
    this.reconcileHosts()
    this.lifecycle.start()
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.refreshTicket += 1
    this.lifecycle.dispose()
    this.offTopology()
    for (const dispose of this.hostListeners.values()) dispose()
    this.hostListeners.clear()
    this.stopProjection?.()
    this.stopProjection = undefined
    this.browser?.close()
    this.editor?.cancel()
    if (this.doneTimer !== undefined) clearTimeout(this.doneTimer)
    this.doneTimer = undefined
    this.notifications.dispose()
    this.pane.dispose()
  }

  private readonly reconcileHosts = (): void => {
    if (this.disposed) return
    const attached = new Set(this.options.hosts.list())
    for (const [client, dispose] of this.hostListeners) {
      if (attached.has(client)) continue
      dispose()
      this.hostListeners.delete(client)
    }
    for (const client of attached) {
      if (this.hostListeners.has(client)) continue
      this.hostListeners.set(client, client.remote.$on('goal/activation-changed', (event: { readonly sessionId: SessionId }) => {
        const current = this.options.hosts.current()
        if (current?.client === client && current.ref.sessionId === event.sessionId) void this.refresh(this.lifecycle.currentGeneration())
      }))
    }
  }

  private readonly attach = (generation: number): void => {
    if (this.disposed) return
    this.refreshTicket += 1
    this.stopProjection?.()
    this.stopProjection = undefined
    this.browser?.close()
    this.editor?.cancel()
    this.browser = undefined
    this.editor = undefined
    this.goal = undefined
    this.done = undefined
    this.tracked = undefined
    if (this.doneTimer !== undefined) clearTimeout(this.doneTimer)
    this.doneTimer = undefined
    this.notifications.clearAll()
    const current = this.lifecycle.selection(generation)
    if (current !== undefined) {
      this.stopProjection = current.binding.session.projections.faceOf('goal').subscribe(() => {
        if (this.lifecycle.owns(generation)) void this.refresh(generation)
      })
      void this.refresh(generation)
    }
    this.publish()
  }

  private async refresh(generation: number): Promise<void> {
    const current = this.lifecycle.selection(generation)
    if (current === undefined) return
    const ticket = ++this.refreshTicket
    let result: Awaited<ReturnType<HostClient['remote']['goals']['get']>>
    try {
      result = await current.client.remote.goals.get(current.ref.sessionId)
    } catch (error) {
      if (this.lifecycle.owns(generation) && ticket === this.refreshTicket) this.options.notice.set(error instanceof Error ? error.message : String(error))
      return
    }
    if (!this.lifecycle.owns(generation) || ticket !== this.refreshTicket) return
    if (!result.ok) {
      this.options.notice.set(result.error.message)
      return
    }
    this.accept(result.value, generation)
  }

  private accept(goal: GoalResult, generation: number): void {
    if (!this.lifecycle.owns(generation)) return
    if (this.doneTimer !== undefined) clearTimeout(this.doneTimer)
    this.doneTimer = undefined
    if (goal?.phase === 'complete') {
      if (this.tracked === goal.id) {
        this.done = { rounds: goal.roundsStarted, total: goal.maxGoalRounds }
        this.doneTimer = setTimeout(() => {
          this.done = undefined
          this.tracked = undefined
          if (!this.disposed) this.publish()
        }, GOAL_DONE_LINGER_MS)
        this.doneTimer.unref()
      }
    } else {
      this.tracked = goal?.id
      this.done = undefined
    }
    this.goal = goal
    this.publish()
    this.reportBlocked()
  }

  private reportBlocked(): void {
    if (this.goal?.phase !== 'blocked' || this.goal.blockedReason === undefined) {
      this.notifications.clear('blocked')
      return
    }
    const current = this.options.hosts.current()
    if (current === undefined) return
    this.notifications.report('blocked', { kind: 'session', sessionId: current.ref.sessionId }, {
      severity: 'warning',
      message: this.t('Goal blocked · {code}: {message}', { code: this.goal.blockedReason.code, message: this.goal.blockedReason.message }),
    })
  }

  private publish(): void {
    const state = { goal: this.goal, ...this.done === undefined ? {} : { done: this.done } }
    this.pane.set(remoteGoalPanel(state, this.t))
    this.pane.setSummary(remoteGoalSummary(state, this.t))
    this.browser?.refresh()
  }

  private async act(event: MayflyUiActionEvent): Promise<MayflyUiActionReply> {
    if (event.kind !== 'activate' || !event.actionId.startsWith('goal-')) return { kind: 'completed' }
    const match = /^goal-(resume|pause|edit|complete|clear):(\d+)$/u.exec(event.actionId)
    if (match === null) return { kind: 'completed' }
    const verb = match[1] as RemoteGoalVerb
    const revision = Number(match[2])
    const current = this.options.hosts.current()
    const goal = this.goal
    if (current === undefined || goal === undefined || goal.revision !== revision) {
      return { kind: 'failed', message: this.t('The goal changed; open it again') }
    }
    if (verb === 'edit') {
      this.openEditor(current, goal)
      return { kind: 'completed' }
    }
    const error = await this.mutate(current, goal, verb)
    return error === undefined ? { kind: 'completed' } : { kind: 'failed', message: error }
  }

  private async mutate(
    current: RemoteFeatureSelection,
    goal: RemoteGoalView,
    verb: Exclude<RemoteGoalVerb, 'edit'>,
  ): Promise<string | undefined> {
    if (!isRemoteFeatureSelection(this.options.hosts.current(), current.client, current.ref)) return this.t('The goal changed; open it again')
    const generation = this.lifecycle.currentGeneration()
    const ref = { id: goal.id, revision: goal.revision }
    const result = verb === 'pause'
      ? await current.client.remote.goals.pause(current.ref.sessionId, ref)
      : verb === 'resume'
        ? await current.client.remote.goals.resume(current.ref.sessionId, ref)
        : verb === 'complete'
          ? await current.client.remote.goals.complete(current.ref.sessionId, ref)
          : await current.client.remote.goals.clear(current.ref.sessionId, ref)
    if (!this.lifecycle.owns(generation) || !isRemoteFeatureSelection(this.options.hosts.current(), current.client, current.ref)) return undefined
    if (!result.ok) return result.error.message
    const notice = verb === 'pause' ? 'Goal paused' : verb === 'resume' ? 'Goal resumed' : verb === 'complete' ? 'Goal complete' : 'Goal cleared'
    this.options.notice.set(this.t(notice))
    await this.refresh(generation)
    return undefined
  }

  private openEditor(current: RemoteFeatureSelection, goal: RemoteGoalView): void {
    this.editor?.cancel()
    const generation = this.lifecycle.currentGeneration()
    this.editor = requestOverlay<GoalEditorResult | undefined>(this.options.ctx, {
      id: 'remote.goal.edit',
      title: this.t('Edit goal'),
      scope: { kind: 'session', sessionId: current.ref.sessionId },
      isCurrent: () => this.lifecycle.owns(generation)
        && isRemoteFeatureSelection(this.options.hosts.current(), current.client, current.ref)
        && this.goal?.id === goal.id && this.goal.revision === goal.revision,
      subscribeLocale: this.options.subscribeLocale,
      dismissal: 'confirm-dirty',
      view: () => ui.stack.column([
        ui.form({ id: 'goal-edit', enterSubmits: 'save', fields: [
          { kind: 'input', id: 'objective', label: this.t('Objective'), value: goal.objective },
          { kind: 'input', id: 'rounds', label: this.t('Maximum rounds'), value: String(goal.maxGoalRounds) },
        ] }),
        ui.actions({ id: 'goal-edit-actions', items: [{ id: 'save', label: this.t('Save'), semantic: 'save', read: [{ pagePath: [], formId: 'goal-edit' }] }] }),
      ]),
      answer: event => {
        if (event.kind !== 'activate' || event.actionId !== 'save') return undefined
        const fields = event.inputs?.forms[0]?.fields ?? []
        const objective = fields.find(field => field.id === 'objective')?.value
        const roundsText = fields.find(field => field.id === 'rounds')?.value
        if (typeof objective !== 'string' || objective.trim() === '') return undefined
        const rounds = typeof roundsText === 'string' && roundsText.trim() !== '' ? Number(roundsText) : undefined
        if (rounds !== undefined && (!Number.isSafeInteger(rounds) || rounds <= 0)) return undefined
        return { objective: objective.trim(), ...rounds === undefined ? {} : { maxGoalRounds: rounds } }
      },
      cancelled: () => undefined,
    })
    void this.editor.result.then(async edit => {
      if (edit === undefined || !isRemoteFeatureSelection(this.options.hosts.current(), current.client, current.ref)) return
      const result = await current.client.remote.goals.edit(current.ref.sessionId, { id: goal.id, revision: goal.revision }, {
        objective: edit.objective,
        ...edit.maxGoalRounds === undefined ? {} : { maxGoalRounds: edit.maxGoalRounds },
      })
      if (!this.lifecycle.owns(generation) || !isRemoteFeatureSelection(this.options.hosts.current(), current.client, current.ref)) return
      if (!result.ok) this.options.notice.set(result.error.message)
      else {
        this.options.notice.set(this.t('Goal updated'))
        await this.refresh(generation)
      }
    }).catch((error: unknown) => {
      if (!this.disposed) this.options.notice.set(error instanceof Error ? error.message : String(error))
    })
  }

  private open(): void {
    const current = this.options.hosts.current()
    if (current === undefined) {
      this.options.notice.set(this.t('No goal is currently set.'))
      return
    }
    this.browser?.close()
    this.browser = openRemoteBrowser(this.options, {
      id: 'remote.goal',
      scope: { kind: 'session', sessionId: current.ref.sessionId },
      isCurrent: () => isRemoteFeatureSelection(this.options.hosts.current(), current.client, current.ref),
      view: () => panel({
        title: this.t('Goal'),
        escapeLabel: 'close',
        body: remoteGoalPanel({ goal: this.goal }, this.t) ?? ui.text(`${this.t('No goal is currently set.')}\n${USAGE}`),
      }),
      action: event => this.act(event),
      onClosed: () => { this.browser = undefined },
    })
    void this.refresh(this.lifecycle.currentGeneration())
  }

  readonly execute = async (rawInput: string, signal: AbortSignal): Promise<void> => {
    const input = rawInput.trim()
    if (input === '') {
      this.open()
      return
    }
    signal.throwIfAborted()
    const current = this.options.hosts.current()
    if (current === undefined) throw new Error(this.t('No current goal'))
    const generation = this.lifecycle.currentGeneration()
    const [verb, rest] = input.startsWith('create ') ? ['create', input.slice(7).trim()] as const
      : input.startsWith('edit ') ? ['edit', input.slice(5).trim()] as const
        : input === 'pause' || input === 'resume' || input === 'complete' || input === 'clear'
          ? [input, ''] as const
          : ['create', input] as const
    if ((verb === 'create' || verb === 'edit') && rest === '') throw new Error(USAGE)
    if (verb === 'create') {
      const result = await current.client.remote.goals.create(current.ref.sessionId, { objective: rest })
      if (!this.lifecycle.owns(generation) || !isRemoteFeatureSelection(this.options.hosts.current(), current.client, current.ref)) return
      if (!result.ok) throw result.error
      this.options.notice.set(this.t('Goal created'))
      await this.refresh(generation)
      return
    }
    const goal = this.goal
    if (goal === undefined) {
      if (verb === 'clear') {
        this.options.notice.set(this.t('No goal is currently set.'))
        return
      }
      throw new Error(this.t('No current goal'))
    }
    if (verb === 'edit') {
      const result = await current.client.remote.goals.edit(current.ref.sessionId, { id: goal.id, revision: goal.revision }, { objective: rest })
      if (!this.lifecycle.owns(generation) || !isRemoteFeatureSelection(this.options.hosts.current(), current.client, current.ref)) return
      if (!result.ok) throw result.error
      this.options.notice.set(this.t('Goal updated'))
      await this.refresh(generation)
      return
    }
    const error = await this.mutate(current, goal, verb)
    if (error !== undefined) throw new Error(error)
  }
}

/** Mount official Goal reads, writes, activation events, and its status view. */
export function mountGoalFeature(options: RemoteFeatureContext): () => void {
  const controller = new RemoteGoalController(options)
  const unregister = options.commands.register({
    name: 'goal',
    description: 'Set or view the goal for a long-running task',
    input: { hint: '[<objective>|clear|edit <objective>|pause|resume|complete]' },
    execute: controller.execute,
  })
  return () => {
    unregister()
    controller.dispose()
  }
}
