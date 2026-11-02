/** Native Goal status reads and revision-checked actions; slash commands stay with the Host. @module */
import type { GoalProjection, GoalView } from '@deepseek-ai/dsh-goal/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { goalPanel, goalSummary, GOAL_DONE_LINGER_MS, type GoalVerb } from '@ephemeral-ai/mayfly/command-panels'
import { mountTranscriptLocale, transcriptTranslator, observeTranscriptLocale, TRANSCRIPT_LOCALE } from '@ephemeral-ai/mayfly/transcript'
import type { MayflyPaneRegistration, MayflyTranslate, MayflyUiActionEvent, MayflyUiActionReply, MayflyUiEventContext } from '@ephemeral-ai/mayfly-ui'
import type { HostClient } from '../../client/types.ts'
import type { RemoteFeatureContext } from '../features.ts'
import { RemoteFeatureLifecycle } from './lifecycle.ts'
import { RemoteFeatureController, type RemoteFeatureOperation } from './official.ts'

class RemoteGoalController extends RemoteFeatureController<RemoteFeatureContext> {
  private readonly t: MayflyTranslate
  private readonly lifecycle: RemoteFeatureLifecycle
  private readonly hostListeners = new Map<HostClient, () => void>()
  private readonly notifications: ReturnType<RemoteFeatureContext['ctx']['mayflyUiInteraction']['createNotificationOwner']>
  private readonly pane: MayflyPaneRegistration
  private readonly offHostTopology: () => void
  private readonly offLocale: () => void
  private owner: RemoteFeatureOperation | undefined
  private goal: GoalView | undefined
  private done: { readonly rounds: number, readonly total: number } | undefined
  private tracked: string | undefined
  private refreshTicket = 0
  private doneTimer: ReturnType<typeof setTimeout> | undefined
  private retired = false

  constructor(private readonly options: RemoteFeatureContext) {
    super(options)
    mountTranscriptLocale(options.ctx, 'remote-goal', TRANSCRIPT_LOCALE)
    this.t = transcriptTranslator(options.ctx, 'remote-goal')
    this.lifecycle = new RemoteFeatureLifecycle(options, this.attach)
    this.notifications = options.ctx.mayflyUiInteraction.createNotificationOwner('remote.goal')
    this.pane = options.ctx.mayflyPanes.register({ id: 'mayfly.view.goal', placement: 'views', priority: 13, onEvent: { action: this.act } }, null)
    this.offHostTopology = options.hosts.subscribe(this.reconcileHosts)
    this.offLocale = observeTranscriptLocale(options.ctx, () => { if (!this.retired) this.publish() })
    this.reconcileHosts()
    this.lifecycle.start()
  }

  override readonly dispose = (): void => {
    if (this.retired) return
    this.retired = true
    super.dispose()
    this.refreshTicket += 1
    this.lifecycle.dispose()
    this.offHostTopology()
    this.offLocale()
    for (const dispose of this.hostListeners.values()) dispose()
    this.hostListeners.clear()
    if (this.doneTimer !== undefined) clearTimeout(this.doneTimer)
    this.doneTimer = undefined
    this.notifications.dispose()
    this.pane.dispose()
  }

  private readonly reconcileHosts = (): void => {
    if (this.retired) return
    const attached = new Set(this.options.hosts.list())
    for (const [client, dispose] of this.hostListeners) {
      if (attached.has(client)) continue
      dispose()
      this.hostListeners.delete(client)
    }
    for (const client of attached) {
      if (this.hostListeners.has(client)) continue
      let active = true
      const off = client.remote.$on('goal/activation-changed', (event: { readonly sessionId: SessionId }) => {
        const owner = this.owner
        if (active && owner?.valid() && owner.client === client && owner.selection!.ref.sessionId === event.sessionId) void this.refresh(owner)
      })
      this.hostListeners.set(client, () => { active = false; off() })
    }
  }

  private readonly attach = (generation: number): void => {
    this.refreshTicket += 1
    this.owner?.dispose()
    this.owner = undefined
    this.goal = undefined
    this.done = undefined
    this.tracked = undefined
    if (this.doneTimer !== undefined) clearTimeout(this.doneTimer)
    this.doneTimer = undefined
    this.notifications.clearAll()
    const current = this.lifecycle.selection(generation)
    if (current !== undefined) {
      const owner = this.sessionOperation(current)!
      this.owner = owner
      owner.onDispose(current.binding.session.projections.faceOf('goal').subscribe(() => { if (owner.valid()) void this.refresh(owner) }))
      void this.refresh(owner)
    }
    this.publish()
  }

  private async refresh(owner: RemoteFeatureOperation): Promise<void> {
    if (!owner.valid()) return
    const ticket = ++this.refreshTicket
    const current = owner.selection!
    const projected = current.binding.session.projections.faceOf('goal').getSnapshot() as GoalProjection | null | undefined
    let activation: GoalView['activation'] = 'disarmed'
    if (projected !== undefined && projected !== null) {
      try {
        const result = await current.client.remote.goals.get(current.ref.sessionId)
        if (!owner.valid() || ticket !== this.refreshTicket) return
        if (result.ok && result.value?.id === projected.goal.id && result.value.revision === projected.goal.revision) activation = result.value.activation
      } catch {
        if (!owner.valid() || ticket !== this.refreshTicket) return
        // The durable goal stays visible when its native process-local activation cannot be read.
      }
    }
    if (!owner.valid() || ticket !== this.refreshTicket) return
    this.accept(projected === undefined || projected === null ? undefined : { ...projected.goal, roundsStarted: projected.roundsStarted, createdAt: projected.createdAt, updatedAt: projected.updatedAt, activation }, owner)
  }

  private accept(goal: GoalView | undefined, owner: RemoteFeatureOperation): void {
    if (goal?.phase === 'complete') {
      if (this.tracked === goal.id && this.done === undefined) {
        this.done = { rounds: goal.roundsStarted, total: goal.maxGoalRounds }
        this.doneTimer = setTimeout(() => {
          if (!owner.valid()) return
          this.done = undefined
          this.tracked = undefined
          this.doneTimer = undefined
          this.publish()
        }, GOAL_DONE_LINGER_MS)
        this.doneTimer.unref()
      }
    } else {
      this.tracked = goal?.id
      this.done = undefined
      if (this.doneTimer !== undefined) clearTimeout(this.doneTimer)
      this.doneTimer = undefined
    }
    this.goal = goal
    this.publish()
    if (!owner.valid()) return
    if (goal?.phase !== 'blocked' || goal.blockedReason === undefined) this.notifications.clear('blocked')
    else this.notifications.report('blocked', { kind: 'session', sessionId: owner.selection!.ref.sessionId }, {
      severity: 'warning', message: this.t('Goal blocked · {code}: {message}', { code: goal.blockedReason.code, message: goal.blockedReason.message }),
    })
  }

  private publish(): void {
    const state = { goal: this.goal, ...this.done === undefined ? {} : { done: this.done } }
    this.pane.set(goalPanel(state, this.t))
    this.pane.setSummary(goalSummary(state, this.t))
  }

  private readonly act = async (event: MayflyUiActionEvent, context: MayflyUiEventContext): Promise<MayflyUiActionReply> => {
    if (event.kind !== 'activate') return { kind: 'completed' }
    if (this.retired || context.signal.aborted) return { kind: 'cancelled' }
    const owner = this.owner
    const goal = this.goal
    const [verb, revision] = event.actionId.replace(/^goal-/u, '').split(':')
    if (owner?.valid() !== true || goal === undefined || String(goal.revision) !== revision) return { kind: 'failed', message: this.t('The goal changed; open it again') }
    const current = owner.selection!
    const operation = this.sessionOperation(current, context.signal)!
    try {
      if (!operation.valid()) return { kind: 'cancelled' }
      if (verb === 'edit') {
        return this.options.editPrompt?.(`/goal edit ${goal.objective}`, () => operation.valid()) === true
          ? { kind: 'completed' } : { kind: 'failed', message: this.t('The prompt is not available') }
      }
      if (verb !== 'pause' && verb !== 'resume' && verb !== 'clear') return { kind: 'failed', message: this.t('Unknown goal action') }
      const result = await current.client.remote.goals[verb as Exclude<GoalVerb, 'edit'>](current.ref.sessionId, { id: goal.id, revision: goal.revision })
      if (!operation.valid()) return { kind: 'cancelled' }
      if (!result.ok) return { kind: 'failed', message: result.error.message }
      void this.refresh(owner)
      return { kind: 'completed' }
    } catch (error) {
      return operation.valid() ? { kind: 'failed', message: error instanceof Error ? error.message : String(error) } : { kind: 'cancelled' }
    } finally { operation.dispose() }
  }
}

/** Mount the reference Goal status; the native Host command catalog owns every /goal invocation. */
export function mountGoalFeature(options: RemoteFeatureContext): () => void {
  const controller = new RemoteGoalController(options)
  return controller.dispose
}
