/**
 * Conversation-derived activity and official notification-lane panes for Remote.
 * @module @ephemeral-ai/mayfly/remote/features/activity
 */

import type { ConversationFacts, ConversationProjection } from '@ephemeral-ai/mayfly-host/types'
import type { MayflyPaneRegistration, MayflyTone, MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import { memoizedLocaleTranslator } from '../../frontend/locale.ts'
import { ACTIVITY_LOCALE, mountTranscriptLocale } from '../../transcript/locale.ts'
import { buildTipRotation } from '../../transcript/status-tips.ts'
import { resumedSessionMessage } from '../../transcript/resume-notice.ts'
import { STATUS_TIPS } from '../../transcript/tips-content.ts'
import { type MayflyDecisionWait } from '../../core/types.ts'
import { contextPercent } from '../../transcript/status-context-model.ts'
import type { RemoteFeatureContext } from '../features.ts'
import { ActivityRow as RemoteActivityRow, type ActivityPhase as RemoteActivityPhase } from '../../components/activity-row.ts'
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
const CONTEXT_THRESHOLDS = [92, 95, 98] as const
const THINKING_STAGES: readonly { readonly from: number, readonly label: string, readonly tone: MayflyTone, readonly strong: boolean }[] = [
  { from: 0, label: 'Pondering', tone: 'muted', strong: false },
  { from: 5_000, label: 'Mulling', tone: 'default', strong: false },
  { from: 15_000, label: 'DeepThinking', tone: 'primary', strong: false },
  { from: 45_000, label: 'Fathoming', tone: 'accent', strong: true },
]

/** Retry-notification copy owned by this lane; the shared `remote-activity` namespace stays with the locale lane. */
const zh: Readonly<Record<string, string>> = {
  'retrying in {seconds}s · {attempt}': '{seconds} 秒后重试 · {attempt}',
  'rate limited': '已被限流',
}

interface ContextPressure {
  readonly projectedTokens?: number
  readonly pressureTokens?: number
  readonly contextWindow?: number
}

class RemoteActivityController {
  private readonly options: RemoteFeatureContext
  private readonly t: MayflyTranslate
  private readonly tr: MayflyTranslate
  private readonly lifecycle: RemoteFeatureLifecycle
  private readonly activityPane: MayflyPaneRegistration
  private readonly notifications: ReturnType<RemoteFeatureContext['ctx']['mayflyUiInteraction']['createNotificationOwner']>
  private readonly offLocale: () => void
  private readonly offDecision: () => void
  private readonly offPanel: () => void
  private readonly rotation = buildTipRotation(STATUS_TIPS)
  private readonly seen = new Set<string>()
  private subscriptions: readonly (() => void)[] = []
  private activity = EMPTY_ACTIVITY
  private waiting = false
  private decision: MayflyDecisionWait | undefined
  private dialog = false
  private live = false
  private turn = 0
  private waitingSince: number | undefined
  private phaseSeenAt: number | undefined
  private tip = ''
  private tipIndex = 0
  private ticks = 0
  private now = Date.now()
  private pressure: ContextPressure | undefined
  private reportedContext = 0
  private retrying: ConversationFacts['retrying'] | undefined
  private readonly timer: ReturnType<typeof setInterval>
  private disposed = false

  constructor(options: RemoteFeatureContext) {
    this.options = options
    mountTranscriptLocale(options.ctx, 'transcript.activity', ACTIVITY_LOCALE)
    this.t = memoizedLocaleTranslator(options.ctx, 'transcript.activity').translate
    this.tr = memoizedLocaleTranslator(options.ctx, 'remote-activity-retry').translate
    this.lifecycle = new RemoteFeatureLifecycle(options, this.attach)
    this.activityPane = options.ctx.mayflyPanes.register({ id: 'mayfly.pane.activity', placement: 'bottom', priority: 10, narrow: 'bottom' }, null)
    this.notifications = options.ctx.mayflyUiInteraction.createNotificationOwner('remote.activity')
    options.ctx.effect(() => options.ctx.mayflyLocale.register('remote-activity-retry', {
      en: Object.freeze(Object.fromEntries(Object.keys(zh).map(key => [key, key]))),
      zh,
    }))
    this.offLocale = options.subscribeLocale(() => {
      this.publishActivity()
      this.publishRetry()
      this.publishNotifications()
    })
    this.offDecision = options.ctx.on('mayfly/decision-wait-changed', decision => {
      this.decision = decision
      this.syncWaiting()
      this.publishActivity()
    })
    this.offPanel = options.ctx.on('mayfly/editor-slot-swapped', open => {
      this.dialog = open
      this.publishActivity()
    })
    this.lifecycle.start()
    this.timer = setInterval(() => {
      this.now = Date.now()
      if (this.live) {
        this.ticks += 1
        if (this.ticks % 15 === 0) this.nextTip()
      }
      this.publishActivity()
      this.publishRetry()
    }, 1_000)
    this.timer.unref()
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.lifecycle.dispose()
    this.offLocale()
    this.offDecision()
    this.offPanel()
    for (const dispose of this.subscriptions) dispose()
    this.subscriptions = []
    clearInterval(this.timer)
    this.notifications.dispose()
    this.activityPane.dispose()
  }

  private readonly attach = (generation: number): void => {
    for (const dispose of this.subscriptions) dispose()
    this.subscriptions = []
    this.activity = EMPTY_ACTIVITY
    this.waiting = false
    this.decision = undefined
    // Rebinding an unchanged live row does not start another teaching tip.
    // The reconciler advances only when the row appears or its turn changes.
    this.waitingSince = undefined
    this.phaseSeenAt = undefined
    this.pressure = undefined
    this.reportedContext = 0
    this.retrying = undefined
    this.notifications.clearAll()
    const current = this.lifecycle.selection(generation)
    if (current !== undefined) {
      const conversation = current.binding.session.projections.faceOf('mayflyConversation')
      const facts = current.binding.session.projections.faceOf('mayflyConversationFacts')
      const questions = current.binding.session.projections.faceOf('userQuestions')
      const pressure = current.binding.session.projections.faceOf('contextPressure')
      const update = (): void => {
        if (!this.lifecycle.owns(generation)) return
        const factsValue = facts.getSnapshot() as ConversationFacts | undefined
        this.activity = deriveRemoteActivity(conversation.getSnapshot() as ConversationProjection | undefined, current.binding.session.getSnapshot(), factsValue)
        this.retrying = factsValue?.retrying
        const projectedQuestions = questions.getSnapshot() as { readonly active?: readonly unknown[] } | undefined
        this.waiting = (projectedQuestions?.active?.length ?? 0) > 0
        this.syncWaiting()
        this.pressure = pressure.getSnapshot() as ContextPressure | undefined
        this.publishActivity()
        this.publishRetry()
        this.publishNotifications()
      }
      this.subscriptions = [
        conversation.subscribe(update),
        facts.subscribe(update),
        questions.subscribe(update),
        pressure.subscribe(update),
        current.binding.session.subscribe(update),
      ]
      update()
      const key = `${current.ref.host}\0${current.ref.sessionId}`
      const first = !this.seen.has(key)
      this.seen.add(key)
      if ((current.kind === undefined || current.kind === 'primary') && first && this.activity.turn > 0 && !this.activity.active) {
        const history = facts.getSnapshot() as ConversationFacts | undefined
        this.notifications.report('resumed', { kind: 'session', sessionId: current.ref.sessionId }, {
          severity: 'info',
          message: resumedSessionMessage(this.activity.turn, history?.endedAt, Date.now(), this.t),
        })
      }
    }
    this.publishActivity()
    this.publishRetry()
    this.publishNotifications()
  }

  private nextTip(): void {
    this.tip = this.rotation[this.tipIndex % this.rotation.length]!.text
    this.tipIndex += 1
  }

  private syncWaiting(): void {
    this.now = Date.now()
    if (this.waiting || this.decision !== undefined) this.waitingSince ??= this.now
    else this.waitingSince = undefined
  }

  private publishActivity(): void {
    if (this.disposed) return
    const waiting = this.waiting || this.decision !== undefined
    if ((!this.activity.active && !waiting) || (this.dialog && this.decision === undefined && !this.waiting)) {
      this.live = false
      this.activityPane.set(null)
      return
    }
    if (!this.live || this.activity.turn !== this.turn) this.nextTip()
    this.live = true
    this.turn = this.activity.turn
    // The inactive guard above excludes the derivation's idle snapshots.
    const phase = waiting ? 'waiting' : this.activity.phase as RemoteActivityPhase
    let stage: (typeof THINKING_STAGES)[number] | undefined
    if (phase === 'thinking') {
      this.phaseSeenAt ??= this.now
      const since = this.activity.outputProgress?.startedAt ?? this.phaseSeenAt
      stage = THINKING_STAGES.findLast(candidate => this.now - since >= candidate.from) ?? THINKING_STAGES[0]!
    } else this.phaseSeenAt = undefined
    const flight = phase === 'tool' ? remoteFlightLabel(this.activity.inFlight) : { key: phase === 'waiting' ? this.decision?.kind === 'approval' ? 'Waiting for your approval' : 'Waiting for your answer' : phase === 'writing' ? 'Writing' : 'Deep diving' }
    const since = phase === 'waiting' ? this.waitingSince : phase === 'thinking' ? this.activity.outputProgress?.startedAt ?? this.phaseSeenAt : this.activity.turnStartedAt
    const elapsed = since === undefined ? '' : remoteCompactElapsedMs(Math.max(0, this.now - since))
    const tail = phase === 'tool' ? [] : [elapsed, phase === 'waiting' ? '' : remoteOutputCounter(this.activity.flowDownChars), phase === 'waiting' ? '' : remoteOutputRate(this.activity.outputProgress, this.now)].filter(text => text !== '')
    const details = phase === 'tool'
      ? [...new Set(this.activity.inFlight.flatMap(call => call.preparing === true || call.detail === undefined || call.detail === '' ? [] : [call.detail]))]
      : []
    const info = details.length === 0 ? undefined : `${details.slice(0, 3).join(' · ')}${details.length > 3 ? ` ${this.t('+{count} more', { count: details.length - 3 })}` : ''}`
    this.activityPane.set(RemoteActivityRow({
      phase,
      label: this.t(stage?.label ?? flight.key, 'values' in flight ? flight.values : undefined),
      ...stage === undefined ? {} : { labelTone: stage.tone, labelStrong: stage.strong },
      tail,
      ...info === undefined ? {} : { info },
      ...info === undefined ? { tip: `${this.t('Tip: ')}${this.t(this.tip)}` } : {},
    }))
  }

  /** Report or withdraw the retry countdown; the 1s tick keeps the remaining seconds current. */
  private publishRetry(): void {
    if (this.disposed) return
    const current = this.options.hosts.current()
    const retrying = this.retrying
    if (retrying === undefined || current === undefined) {
      this.notifications.clear('retry')
      return
    }
    const seconds = Math.max(0, Math.ceil((retrying.at + retrying.delayMs - this.now) / 1_000))
    const attempt = `${String(retrying.retry)}/${String(retrying.maxRetries)}`
    const parts = [
      ...retrying.status === undefined ? [] : [retrying.status === 429 ? this.tr('rate limited') : `HTTP ${String(retrying.status)}`],
      ...retrying.reason === undefined || retrying.reason === '' ? [] : [retrying.reason],
      this.tr('retrying in {seconds}s · {attempt}', { seconds, attempt }),
    ]
    this.notifications.report('retry', { kind: 'session', sessionId: current.ref.sessionId }, {
      severity: 'warning',
      purpose: 'progress',
      message: parts.join(' · '),
      tail: attempt,
    })
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
  }
}

/** Mount activity and notification panes over official projections and the shared notification owner. */
export function mountActivityFeature(options: RemoteFeatureContext): () => void {
  const controller = new RemoteActivityController(options)
  return controller.dispose
}
