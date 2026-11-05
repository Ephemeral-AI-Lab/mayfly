/**
 * Remote user-question waterfalls, timed claims, and projection-backed continued answers.
 * @module @ephemeral-ai/mayfly/remote/interactions/questions
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { decisionArmMs, freezeWire, type MayflyUiActionEvent } from '@ephemeral-ai/mayfly-ui'
import type { HostClient, SessionRef } from '../../client/types.ts'
import type { RemoteFeatureContext } from '../features.ts'
import { officialUserQuestions, type OfficialQuestionWait, type QuestionAnswer, type QuestionCallId, type QuestionRequest, type RemotePendingQuestion, type RemoteQuestionProjection } from './official.ts'
import { planReviewAction, planReviewAnswer, planReviewCard, planReviewChoices } from './plan-review-panel.ts'
import { questionnaireAnswer, questionnaireView } from './questionnaire.ts'
import { requestOverlay, type RemoteRequestOverlay } from './request-overlay.ts'
import { isRemoteFeatureSelection } from './selection.ts'

const DELEGATE = Symbol('remote question delegates')
type Questions = QuestionRequest['questions']
type Overlay = RemoteRequestOverlay<QuestionAnswer | typeof DELEGATE>

interface Waterfall {
  readonly next: () => Promise<QuestionAnswer>
  readonly lifetime: AbortController
  signal?: AbortSignal | undefined
  settled: boolean
}

interface QuestionCard {
  readonly key: string
  readonly client: HostClient
  readonly ref: SessionRef
  readonly binding: SessionBinding
  readonly connectionGeneration: number
  questions: Questions
  readonly callId: QuestionCallId | undefined
  state: 'open' | 'continued'
  overlay?: Overlay | undefined
  waterfall?: Waterfall | undefined
  hidden: boolean
  removed: boolean
  answering: boolean
  deadline?: number | undefined
  timer?: ReturnType<typeof setInterval> | undefined
}

function questionError(code: 'ASK_ABORTED' | 'ASK_CANCELLED'): Error {
  const message = code === 'ASK_ABORTED'
    ? 'ask_user_question was aborted before the user answered'
    : 'the user cancelled ask_user_question'
  const error = new Error(message) as Error & { code: string }
  error.name = 'UserQuestionError'
  error.code = code
  return error
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function queuedReplies(snapshot: unknown): Set<string> {
  const inbox = record(snapshot)
  const queued = new Set<string>()
  for (const list of [inbox?.['next-step'], inbox?.['next-turn']]) {
    if (!Array.isArray(list)) continue
    for (const message of list) {
      const source = record(record(message)?.source)
      if (source?.kind === 'user-question-reply' && typeof source.callId === 'string') queued.add(source.callId)
    }
  }
  return queued
}

class RemoteQuestionController {
  private readonly listeners = new Map<HostClient, () => void>()
  private readonly cards = new Map<HostClient, Map<string, QuestionCard>>()
  private projected: {
    readonly client: HostClient
    readonly ref: SessionRef
    readonly binding: SessionBinding
    readonly stop: () => void
  } | undefined
  private readonly offTopology: () => void
  private sequence = 0
  private disposed = false

  constructor(private readonly options: RemoteFeatureContext) {
    this.reconcile()
    this.offTopology = this.options.hosts.subscribe(this.reconcile)
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.offTopology()
    this.projected?.stop()
    this.projected = undefined
    for (const dispose of this.listeners.values()) dispose()
    this.listeners.clear()
    for (const client of [...this.cards.keys()]) this.retireClient(client)
  }

  private readonly reconcile = (): void => {
    if (this.disposed) return
    const attached = new Set(this.options.hosts.list())
    for (const [client, dispose] of this.listeners) {
      if (attached.has(client)) continue
      dispose()
      this.listeners.delete(client)
      this.retireClient(client)
    }
    for (const client of attached) {
      if (this.listeners.has(client)) continue
      const controller = this
      const offRequest = client.remote.$on('user-questions/request', function (this: Context, request: QuestionRequest, next: () => Promise<QuestionAnswer>) {
        const sessionId = client.sessions.scopeOf(this)
        return controller.receive(client, sessionId, request, next)
      })
      let generation = client.state.getSnapshot().generation
      const offState = client.state.subscribe(() => {
        const next = client.state.getSnapshot().generation
        if (next === generation) return
        generation = next
        // Reconnection retires old answers. Wait for the native projection
        // baseline to publish before presenting continued questions again.
        this.retireClient(client)
      })
      this.listeners.set(client, () => { offRequest(); offState() })
    }
    this.reconcileProjection()
  }

  private receive(
    client: HostClient,
    sessionId: SessionId | undefined,
    request: QuestionRequest,
    next: () => Promise<QuestionAnswer>,
  ): Promise<QuestionAnswer> {
    if (this.disposed || sessionId === undefined || request.questions.length === 0) return next()
    const ref: SessionRef = { host: client.key, sessionId }
    const current = this.options.hosts.current()
    if (!isRemoteFeatureSelection(current, client, ref)) return next()
    if (request.signal?.aborted) return Promise.reject(questionError('ASK_ABORTED'))
    const callId = request.wait?.callId
    if (request.wait?.timed === true && callId === undefined) return next()
    const existing = callId === undefined ? undefined : this.cards.get(client)?.get(this.cardKey(sessionId, callId))
    if (existing !== undefined) {
      const previous = existing.waterfall
      if (previous !== undefined && !previous.settled) {
        if (previous.signal?.aborted !== true) return next()
        previous.settled = true
        previous.lifetime.abort()
        if (existing.timer !== undefined) clearInterval(existing.timer)
        existing.timer = undefined
        existing.deadline = undefined
        existing.waterfall = undefined
        existing.overlay?.cancel()
        existing.overlay = undefined
      }
    }
    const card = existing ?? this.createCard(client, ref, current.binding, request.questions, callId)
    if (card.waterfall !== undefined) return next()
    card.questions = freezeWire(request.questions)
    card.state = 'open'
    card.hidden = false
    card.answering = false
    const waterfall: Waterfall = { next, lifetime: new AbortController(), settled: false }
    card.waterfall = waterfall
    // Publish the native wait before the editor slot opens, preserving the
    // reference activity row and its current tip throughout the transition.
    this.publishWaiting()
    card.overlay?.cancel()
    card.overlay = undefined
    return this.answerWaterfall(card, waterfall, request)
  }

  private async answerWaterfall(card: QuestionCard, waterfall: Waterfall, request: QuestionRequest): Promise<QuestionAnswer> {
    const timed = request.wait?.timed === true && card.callId !== undefined
    const signal = request.signal === undefined ? waterfall.lifetime.signal : AbortSignal.any([waterfall.lifetime.signal, request.signal])
    waterfall.signal = signal
    let claim: OfficialQuestionWait | undefined
    let claimEnded: Promise<never> | undefined
    let claimReleased = false
    let overlay: Overlay | undefined
    const releaseClaim = async (): Promise<void> => {
      if (claimReleased) return
      claimReleased = true
      waterfall.lifetime.abort()
      claim?.dispose()
      if (claimEnded !== undefined) await Promise.allSettled([claimEnded])
    }
    try {
      if (timed && card.callId !== undefined) {
        claim = officialUserQuestions(card.client).attachWait(card.ref.sessionId, card.callId, signal)
        const iterator = claim[Symbol.asyncIterator]()
        let opening: IteratorResult<{ remainingMs: number }>
        try {
          opening = await iterator.next()
        } catch (error) {
          if (waterfall.settled) return waterfall.next()
          throw error
        }
        if (opening.done === true) return waterfall.next()
        if (waterfall.settled || signal.aborted) return waterfall.next()
        card.deadline = Date.now() + opening.value.remainingMs
        card.timer = setInterval(() => card.overlay?.refresh(), 1000)
        claimEnded = (async () => {
          await iterator.next()
          throw new Error('the foreground question wait ended')
        })()
      }
      this.showOverlay(card, true)
      overlay = card.overlay
      try {
        const answer = claimEnded === undefined
          ? await overlay!.result
          : await Promise.race([overlay!.result, claimEnded])
        if (answer === DELEGATE) {
          await releaseClaim()
          return waterfall.next()
        }
        return answer
      } catch (error) {
        if (error === DELEGATE || waterfall.settled) {
          await releaseClaim()
          return waterfall.next()
        }
        throw error
      }
    } finally {
      waterfall.settled = true
      if (card.waterfall === waterfall) {
        if (card.timer !== undefined) clearInterval(card.timer)
        card.timer = undefined
        card.deadline = undefined
      }
      if (!timed) waterfall.lifetime.abort()
      else if (claimEnded === undefined) await releaseClaim()
      else void Promise.allSettled([claimEnded]).then(() => releaseClaim())
      if (card.overlay === overlay) card.overlay = undefined
      overlay?.cancel()
      if (card.waterfall === waterfall) {
        card.waterfall = undefined
        if (card.callId === undefined || !this.projectionRows(card).has(card.key)) this.removeCard(card)
        else card.hidden = true
        this.publishWaiting()
      }
    }
  }

  private showOverlay(card: QuestionCard, live: boolean): void {
    if (card.overlay !== undefined) {
      card.overlay.reveal()
      return
    }
    const single = card.questions.length === 1 ? card.questions[0] : undefined
    const choices = single === undefined ? undefined : planReviewChoices(single)
    const review = single !== undefined && choices !== undefined
    const id = `remote.questions.${String(++this.sequence)}`
    card.hidden = false
    card.overlay = requestOverlay<QuestionAnswer | typeof DELEGATE>(this.options.ctx, {
      id,
      title: this.options.t('Questions'),
      scope: { kind: 'session', sessionId: card.ref.sessionId },
      isCurrent: () => this.isCurrent(card),
      subscribeLocale: this.options.subscribeLocale,
      ...card.waterfall?.signal === undefined ? {} : { signal: card.waterfall.signal },
      ...review ? { dismissal: 'discard' as const, contentScroll: true, armMs: decisionArmMs } : {},
      bare: true,
      hideOnDismiss: !review && (live && card.deadline !== undefined || !live),
      onHidden: () => { card.hidden = true },
      view: () => review ? planReviewCard(this.options.t) : questionnaireView(card.questions, this.options.t, this.remaining(card)),
      answer: event => review ? planReviewAnswer(single, choices, event) : questionnaireAnswer(card.questions, event),
      ...review ? { onAction: (event: MayflyUiActionEvent) => planReviewAction(event, this.options.t) } : {},
      cancelled: reason => {
        if (review && reason === 'dismiss') return { answers: [{ id: single.id, selected: [choices.decline.label] }] }
        if (reason === 'dismiss') throw questionError('ASK_CANCELLED')
        if (reason === 'abort') throw questionError('ASK_ABORTED')
        return DELEGATE
      },
    })
    if (!live) void this.answerContinued(card, card.overlay.result)
  }

  private async answerContinued(card: QuestionCard, result: Promise<QuestionAnswer | typeof DELEGATE>): Promise<void> {
    try {
      const answer = await result
      if (answer === DELEGATE || !this.isCurrent(card) || card.state !== 'continued' || this.queued(card)) return
      card.answering = true
      // Only a native projected row can enter the continued-answer lane.
      const accepted = await officialUserQuestions(card.client).answer(card.ref.sessionId, card.callId!, answer)
      if (!accepted.ok) throw new Error(accepted.error.message)
      if (!accepted.value) throw new Error('The question is no longer waiting for an answer')
      if (card.waterfall !== undefined || !this.isCurrent(card)) return
      this.removeCard(card)
    } catch (error) {
      if (error === DELEGATE || card.removed || card.waterfall !== undefined || !this.isCurrent(card)) return
      this.options.notice.set(error instanceof Error ? error.message : String(error))
      card.answering = false
      card.overlay = undefined
      this.reconcileProjected()
    }
  }

  private reconcileProjection(): void {
    const current = this.options.hosts.current()
    const previous = this.projected
    if (previous !== undefined && current !== undefined
      && previous.client === current.client && previous.binding === current.binding
      && previous.ref.host === current.ref.host && previous.ref.sessionId === current.ref.sessionId) {
      this.reconcileProjected()
      return
    }
    previous?.stop()
    this.projected = undefined
    for (const client of [...this.cards.keys()]) this.retireClient(client)
    if (current === undefined) return
    const questions = current.binding.session.projections.faceOf('userQuestions')
    const inbox = current.binding.session.projections.faceOf('inbox')
    const update = (): void => this.reconcileProjected()
    const stopQuestions = questions.subscribe(update)
    const stopInbox = inbox.subscribe(update)
    this.projected = {
      client: current.client,
      ref: current.ref,
      binding: current.binding,
      stop: () => { stopQuestions(); stopInbox() },
    }
    this.reconcileProjected()
  }

  private reconcileProjected(): void {
    const projected = this.projected
    if (projected === undefined || this.disposed) return
    if (!isRemoteFeatureSelection(this.options.hosts.current(), projected.client, projected.ref)
      || this.options.hosts.current()?.binding !== projected.binding) return
    const snapshot = projected.binding.session.projections.faceOf('userQuestions').getSnapshot() as RemoteQuestionProjection | undefined
    const queued = queuedReplies(projected.binding.session.projections.faceOf('inbox').getSnapshot())
    const rows = new Map<string, RemotePendingQuestion>()
    for (const row of snapshot?.active ?? []) {
      const key = this.cardKey(projected.ref.sessionId, row.callId)
      if (row.state === 'continued' && queued.has(String(row.callId))) continue
      rows.set(key, row)
    }
    for (const row of rows.values()) {
      if (row.state !== 'continued') {
        const existing = this.cards.get(projected.client)?.get(this.cardKey(projected.ref.sessionId, row.callId))
        if (existing !== undefined && existing.waterfall === undefined) existing.state = 'open'
        continue
      }
      const card = this.ensureCard(projected.client, projected.ref, projected.binding, row.questions, row.callId)
      const transitioned = card.state !== 'continued'
      card.state = 'continued'
      card.questions = freezeWire(row.questions)
      if (transitioned) card.hidden = false
      if (!card.hidden && card.waterfall === undefined && !card.answering) this.showOverlay(card, false)
    }
    for (const card of [...(this.cards.get(projected.client)?.values() ?? [])]) {
      if (card.ref.sessionId !== projected.ref.sessionId || card.waterfall !== undefined || rows.has(card.key)) continue
      this.removeCard(card)
    }
  }

  private createCard(
    client: HostClient,
    ref: SessionRef,
    binding: SessionBinding,
    questions: Questions,
    callId: QuestionCallId | undefined,
  ): QuestionCard {
    const key = callId === undefined ? `anonymous:${String(++this.sequence)}` : this.cardKey(ref.sessionId, callId)
    const card: QuestionCard = {
      key, client, ref, binding, connectionGeneration: client.state.getSnapshot().generation, questions: freezeWire(questions), callId,
      state: 'open', hidden: false, removed: false, answering: false,
    }
    const cards = this.cards.get(client) ?? new Map<string, QuestionCard>()
    cards.set(key, card)
    this.cards.set(client, cards)
    return card
  }

  private ensureCard(
    client: HostClient,
    ref: SessionRef,
    binding: SessionBinding,
    questions: Questions,
    callId: QuestionCallId,
  ): QuestionCard {
    return this.cards.get(client)?.get(this.cardKey(ref.sessionId, callId))
      ?? this.createCard(client, ref, binding, questions, callId)
  }

  private removeCard(card: QuestionCard): void {
    card.removed = true
    card.hidden = true
    if (card.timer !== undefined) clearInterval(card.timer)
    card.timer = undefined
    const waterfall = card.waterfall
    card.waterfall = undefined
    if (waterfall !== undefined && !waterfall.settled) {
      waterfall.settled = true
      waterfall.lifetime.abort()
    }
    card.overlay?.cancel()
    card.overlay = undefined
    // Removal clears the owned waterfall before cancelling its overlay, so a
    // retired continuation cannot re-enter this registered-card path.
    const cards = this.cards.get(card.client)!
    cards.delete(card.key)
    if (cards.size === 0) this.cards.delete(card.client)
    if (waterfall !== undefined) this.publishWaiting()
  }

  /** Derive pending presentation from owned native waterfalls without another wait store. */
  private publishWaiting(): void {
    const card = [...this.cards.values()].flatMap(cards => [...cards.values()])
      .findLast(card => card.waterfall !== undefined && !card.waterfall.settled && this.isCurrent(card))
    const single = card?.questions.length === 1 ? card.questions[0] : undefined
    const review = single !== undefined && planReviewChoices(single) !== undefined
    const callId = single?.intent?.kind === 'plan-review' ? single.intent.callId : undefined
    this.options.ctx.emit('mayfly/decision-requests-changed', 'plan', review ? [{
      type: 'plan', toolName: single.header ?? 'plan',
      ...callId === undefined ? {} : { callId: String(callId) },
    }] : [])
    this.options.ctx.emit('mayfly/decision-wait-changed', card === undefined ? undefined : { kind: review ? 'approval' : 'answer' })
  }

  private retireClient(client: HostClient): void {
    for (const card of [...(this.cards.get(client)?.values() ?? [])]) this.removeCard(card)
    this.cards.delete(client)
  }

  private isCurrent(card: QuestionCard): boolean {
    const current = this.options.hosts.current()
    return !this.disposed && !card.removed
      && this.options.hosts.list().includes(card.client)
      && card.client.state.getSnapshot().generation === card.connectionGeneration
      && isRemoteFeatureSelection(current, card.client, card.ref)
      && current.binding === card.binding
  }

  private projectionRows(card: QuestionCard): Map<string, RemotePendingQuestion> {
    const snapshot = card.binding.session.projections.faceOf('userQuestions').getSnapshot() as RemoteQuestionProjection | undefined
    return new Map((snapshot?.active ?? []).map(row => [this.cardKey(card.ref.sessionId, row.callId), row]))
  }

  private queued(card: QuestionCard): boolean {
    return queuedReplies(card.binding.session.projections.faceOf('inbox').getSnapshot()).has(String(card.callId))
  }

  private remaining(card: QuestionCard): string | undefined {
    if (card.deadline === undefined) return undefined
    const seconds = Math.max(0, Math.ceil((card.deadline - Date.now()) / 1000))
    return this.options.t('expires in {time}', { time: `${String(seconds)}s` })
  }

  private cardKey(sessionId: SessionId, callId: QuestionCallId): string {
    return `${String(sessionId)}:${String(callId)}`
  }
}

/** Mount per-Host question listeners and continued-question projections, delegating every live waterfall on teardown. */
export function mountQuestionInteractions(options: RemoteFeatureContext): () => void {
  const controller = new RemoteQuestionController(options)
  return controller.dispose
}
