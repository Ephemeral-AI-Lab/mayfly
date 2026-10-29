/**
 * Conversation-derived activity and official notification-lane panes for Remote.
 * @module @ephemeral-ai/mayfly/remote/features/activity
 */

import type { ConversationProjection } from '@ephemeral-ai/mayfly-host/types'
import type { MayflyPaneRegistration, MayflyTone, MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import { contextPercent } from '@ephemeral-ai/mayfly/status-context'
import type { RemoteFeatureContext } from '../features.ts'
import { RemoteActivityRow } from '../panels/activity-row.ts'
import { RemoteNotificationLine, selectRemoteNotification } from '../panels/notification-line.ts'
import {
  deriveRemoteActivity,
  remoteCompactElapsedMs,
  remoteFlightLabel,
  remoteOutputCounter,
  remoteOutputRate,
  type RemoteActivitySnapshot,
} from '../status/activity.ts'
import { RemoteFeatureLifecycle } from './lifecycle.ts'

const EMPTY_ACTIVITY: RemoteActivitySnapshot = { active: false, phase: 'idle', turn: 0, flowDownChars: 0, inFlight: [] }
const TIPS = ['Esc to interrupt the turn', '/help: show commands', 'type / to browse commands; matching is fuzzy'] as const
const CONTEXT_THRESHOLDS = [92, 95, 98] as const
const THINKING_STAGES: readonly { readonly from: number, readonly label: string, readonly tone: MayflyTone, readonly strong: boolean }[] = [
  { from: 0, label: 'Pondering', tone: 'muted', strong: false },
  { from: 5_000, label: 'Mulling', tone: 'default', strong: false },
  { from: 15_000, label: 'DeepThinking', tone: 'primary', strong: false },
  { from: 45_000, label: 'Fathoming', tone: 'accent', strong: true },
]

interface ContextPressure {
  readonly projectedTokens?: number
  readonly pressureTokens?: number
  readonly contextWindow?: number
}

class RemoteActivityController {
  private readonly options: RemoteFeatureContext
  private readonly t: MayflyTranslate
  private readonly lifecycle: RemoteFeatureLifecycle
  private readonly activityPane: MayflyPaneRegistration
  private readonly notificationPane: MayflyPaneRegistration
  private readonly notifications: ReturnType<RemoteFeatureContext['ctx']['mayflyUiInteraction']['createNotificationOwner']>
  private readonly offLocale: () => void
  private readonly offInteraction: () => void
  private readonly seen = new Set<string>()
  private subscriptions: readonly (() => void)[] = []
  private activity = EMPTY_ACTIVITY
  private waiting = false
  private waitingSince: number | undefined
  private phaseSeenAt: number | undefined
  private tip = ''
  private tipIndex = 0
  private ticks = 0
  private now = Date.now()
  private pressure: ContextPressure | undefined
  private reportedContext = 0
  private timer: ReturnType<typeof setInterval> | undefined
  private disposed = false

  constructor(options: RemoteFeatureContext) {
    this.options = options
    this.t = memoizedLocaleTranslator(options.ctx, 'remote-activity').translate
    this.lifecycle = new RemoteFeatureLifecycle(options, this.attach)
    this.activityPane = options.ctx.mayflyPanes.register({ id: 'mayfly.pane.activity', placement: 'bottom', priority: 10, narrow: 'bottom' }, null)
    this.notificationPane = options.ctx.mayflyPanes.register({ id: 'mayfly.pane.notification', placement: 'bottom', priority: 9, narrow: 'bottom' }, RemoteNotificationLine(undefined))
    this.notifications = options.ctx.mayflyUiInteraction.createNotificationOwner('remote.activity')
    this.offInteraction = options.ctx.mayflyUiInteraction.subscribe(this.publishNotifications)
    this.offLocale = options.subscribeLocale(() => {
      this.publishActivity()
      this.publishNotifications()
    })
    this.lifecycle.start()
    this.timer = setInterval(() => {
      this.now = Date.now()
      this.ticks += 1
      if (this.ticks % 15 === 0) this.nextTip()
      this.publishActivity()
    }, 1_000)
    this.timer.unref()
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.lifecycle.dispose()
    this.offInteraction()
    this.offLocale()
    for (const dispose of this.subscriptions) dispose()
    this.subscriptions = []
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    this.notifications.dispose()
    this.activityPane.dispose()
    this.notificationPane.dispose()
  }

  private readonly attach = (generation: number): void => {
    if (this.disposed) return
    for (const dispose of this.subscriptions) dispose()
    this.subscriptions = []
    this.activity = EMPTY_ACTIVITY
    this.waiting = false
    this.waitingSince = undefined
    this.phaseSeenAt = undefined
    this.pressure = undefined
    this.reportedContext = 0
    this.notifications.clearAll()
    const current = this.lifecycle.selection(generation)
    if (current !== undefined) {
      const conversation = current.binding.session.projections.faceOf('mayflyConversation')
      const questions = current.binding.session.projections.faceOf('userQuestions')
      const pressure = current.binding.session.projections.faceOf('contextPressure')
      const update = (): void => {
        if (!this.lifecycle.owns(generation)) return
        this.activity = deriveRemoteActivity(conversation.getSnapshot() as ConversationProjection | undefined, current.binding.session.getSnapshot())
        const projectedQuestions = questions.getSnapshot() as { readonly active?: readonly unknown[] } | undefined
        this.waiting = (projectedQuestions?.active?.length ?? 0) > 0
        if (this.waiting && this.waitingSince === undefined) this.waitingSince = Date.now()
        if (!this.waiting) this.waitingSince = undefined
        this.pressure = pressure.getSnapshot() as ContextPressure | undefined
        this.publishActivity()
        this.publishNotifications()
      }
      this.subscriptions = [
        conversation.subscribe(update),
        questions.subscribe(update),
        pressure.subscribe(update),
        current.binding.session.subscribe(update),
      ]
      update()
      const key = `${current.ref.host}\0${current.ref.sessionId}`
      if (!this.seen.has(key) && this.activity.turn > 0 && !this.activity.active) {
        this.seen.add(key)
        this.notifications.report('resumed', { kind: 'session', sessionId: current.ref.sessionId }, {
          severity: 'info',
          message: `${this.t('Resumed session')} · ${this.t(this.activity.turn === 1 ? '1 turn' : '{count} turns', { count: this.activity.turn })}`,
        })
      }
    }
    this.publishActivity()
    this.publishNotifications()
  }

  private nextTip(): void {
    this.tip = TIPS[this.tipIndex % TIPS.length]!
    this.tipIndex += 1
  }

  private publishActivity(): void {
    if (this.disposed) return
    if (!this.activity.active && !this.waiting) {
      this.activityPane.set(null)
      return
    }
    const phase = this.waiting ? 'waiting' : this.activity.phase === 'idle' ? 'diving' : this.activity.phase
    if (phase === 'thinking' && this.phaseSeenAt === undefined) this.phaseSeenAt = this.now
    if (phase !== 'thinking') this.phaseSeenAt = undefined
    if (this.tip === '') this.nextTip()
    const flight = phase === 'tool' ? remoteFlightLabel(this.activity.inFlight) : { key: phase === 'waiting' ? 'Waiting for your answer' : phase === 'writing' ? 'Writing' : 'Deep diving' }
    const stage = phase === 'thinking'
      ? THINKING_STAGES.findLast(candidate => this.now - (this.activity.outputProgress?.startedAt ?? this.phaseSeenAt ?? this.now) >= candidate.from) ?? THINKING_STAGES[0]!
      : undefined
    const since = phase === 'waiting' ? this.waitingSince : phase === 'thinking' ? this.activity.outputProgress?.startedAt ?? this.phaseSeenAt : this.activity.turnStartedAt
    const elapsed = since === undefined ? '' : remoteCompactElapsedMs(Math.max(0, this.now - since))
    const tail = phase === 'tool' ? [] : [elapsed, phase === 'waiting' ? '' : remoteOutputCounter(this.activity.flowDownChars), phase === 'waiting' ? '' : remoteOutputRate(this.activity.outputProgress, this.now)].filter(text => text !== '')
    const details = phase === 'tool'
      ? [...new Set(this.activity.inFlight.flatMap(call => call.detail === undefined || call.detail === '' ? [] : [call.detail]))]
      : []
    const info = details.length === 0 ? undefined : `${details.slice(0, 3).join(' · ')}${details.length > 3 ? ` ${this.t('+{count} more', { count: details.length - 3 })}` : ''}`
    this.activityPane.set(RemoteActivityRow({
      phase,
      label: this.t(stage?.label ?? flight.key, 'values' in flight ? flight.values : undefined),
      ...stage === undefined ? {} : { labelTone: stage.tone, labelStrong: stage.strong },
      tail,
      ...info === undefined ? {} : { info },
      ...info === undefined && phase !== 'tool' ? { tip: `${this.t('Tip: ')}${this.t(this.tip)}` } : {},
    }))
  }

  private publishNotifications(): void {
    if (this.disposed) return
    const window = this.pressure?.contextWindow
    const used = this.pressure?.projectedTokens ?? this.pressure?.pressureTokens
    const percent = window === undefined || used === undefined ? 0 : contextPercent(used, window)
    const threshold = window === undefined || used === undefined ? undefined : CONTEXT_THRESHOLDS.findLast(each => percent >= each)
    const current = this.options.hosts.current()
    if (threshold === undefined) {
      this.reportedContext = 0
      this.notifications.clear('context')
    } else if (threshold > this.reportedContext && current !== undefined) {
      this.reportedContext = threshold
      this.notifications.report('context', { kind: 'session', sessionId: current.ref.sessionId }, {
        severity: 'warning',
        message: this.t('Context {percent}% full · /compact now', { percent }),
      })
    }
    const notice = selectRemoteNotification(this.options.ctx.mayflyUiInteraction.notificationSnapshot(), current?.ref.sessionId)
    this.notificationPane.set(RemoteNotificationLine(notice === undefined ? undefined : { notice }))
  }
}

/** Mount activity and notification panes over official projections and the shared notification owner. */
export function mountActivityFeature(options: RemoteFeatureContext): () => void {
  const controller = new RemoteActivityController(options)
  return controller.dispose
}
