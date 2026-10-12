/**
 * The activity row for the selected Agent — the one place that speaks in the present tense, so progress stays visible
 * while the transcript is scrolled away. This plugin owns the row's facts and `components/activity-row.ts` draws them:
 * the phase (`Deep diving` while waiting on the model, `Thinking`, `Writing`, the running tool category or its
 * preparing form, a wait on the user, or the latched stop), the turn's elapsed time and throughput, and under them one
 * line: the single action running now, else a teaching tip. The block is a constant three rows (header, that line, a
 * blank row before the editor). Motion belongs to core's one clock, so the plugin republishes once a second for the elapsed time and
 * throughput (data, not frames) and not at all while the phase is still. The pane stays up above an approval or question panel (the
 * decision wait) while hiding under every other editor dialog. A latched user interrupt renders one static `■`
 * row held for a minimum visible duration, because a plain abort settles within one render frame.
 *
 * The phase and elapsed anchor come from the `mayflySessionFacts` bridge over the official `mayflyConversationFacts`
 * projection, so replay and live updates share one whole value.
 *
 * @module @ephemeral-ai/mayfly/transcript/pane-activity
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MayflyTone, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { ActivityRow, type ActivityFacts, type ActivityPhase } from '../components/activity-row.ts'
import type { MayflyDecisionWait } from '../core/types.ts'
// Empty type import carries the app-owned opaque binding event merge.
import type {} from '../app/index.ts'
import type { ConversationFacts } from '../conversation/types.ts'
import { isSpawnToolName } from '../conversation/projection.ts'
import { compactElapsedMs } from './agent-presentation.ts'
import { outputCounter, outputRate } from './output-rate.ts'
import { preparingLabel, runningLabel, toolActivity } from './process-activity.ts'
import { toolDisplayName } from './present.ts'
import type { SessionFactsService } from './session-facts.ts'
import { formatTokens } from './status-context.ts'
import { buildTipRotation } from './status-tips.ts'
import { STATUS_TIPS } from './tips-content.ts'
import {
  ACTIVITY_LOCALE,
  mountTranscriptLocale,
  observeTranscriptLocale,
  transcriptTranslator,
} from './locale.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-pane-activity'

/** Services required before the pane can mount. */
export const inject = ['mayflyPanes', 'mayflySessionFacts']

/** The label while the turn waits on the model (the retired turn header's phrase). */
const WAITING_LABEL = 'Deep diving'

/**
 * The reasoning phase's label: a character that deepens with the seconds spent in the phase, one word per stage, its tone
 * stepping deeper with it. The phase clock restarts with each reasoning phase.
 */
const THINKING_STAGES: readonly { readonly from: number, readonly label: string, readonly tone: MayflyTone, readonly strong: boolean }[] = [
  { from: 0, label: 'Pondering', tone: 'muted', strong: false },
  { from: 5_000, label: 'Mulling', tone: 'default', strong: false },
  { from: 15_000, label: 'DeepThinking', tone: 'primary', strong: false },
  { from: 45_000, label: 'Fathoming', tone: 'accent', strong: true },
]

/** The stage of a reasoning phase that has lasted `ms`. */
function thinkingStage(ms: number): (typeof THINKING_STAGES)[number] {
  return THINKING_STAGES.findLast(stage => ms >= stage.from) ?? THINKING_STAGES[0]!
}

/** The answer-text phase's label. */
const WRITING_LABEL = 'Writing'

/** The stopping row's label; the `■` marker rides in error red beside it. */
const STOPPING_LABEL = 'interrupting…'

/** The labels of a wait on the user. */
const APPROVAL_LABEL = 'Waiting for your approval'
const ANSWER_LABEL = 'Waiting for your answer'

/** How often the elapsed time and the throughput are republished while a phase is live. */
const TICK_MS = 1000

/** Ticks a tip stays up before the next one replaces it. */
const TIP_TICKS = 15

/**
 * Minimum time the stopping acknowledgment stays up. A plain-text abort
 * settles within one render frame, so without a hold the row could lose the
 * race and never paint — the keypress must always read as accepted.
 */
const STOPPING_MIN_MS = 600

/** The timer primitives behind the clock tick and the stopping hold; replaceable in tests. */
export interface ActivityTimers {
  /** Start a repeating callback; mirrors the global `setInterval`. */
  setInterval: (callback: () => void, ms: number) => ReturnType<typeof setInterval>
  /** Stop a repeating callback; mirrors the global `clearInterval`. */
  clearInterval: (handle: ReturnType<typeof setInterval>) => void
  /** Start a one-shot callback; mirrors the global `setTimeout`. */
  setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  /** Stop a one-shot callback; mirrors the global `clearTimeout`. */
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void
}

/** The process timer primitives. */
const defaultActivityTimers: ActivityTimers = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: handle => clearInterval(handle),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle),
}

let activityTimers: ActivityTimers = defaultActivityTimers

let activityNow: () => number = () => Date.now()

/**
 * Replace the timers (tests inject fakes here).
 * @param timers - the replacement, or `undefined` to restore the defaults.
 */
export function setActivityTimers(timers: ActivityTimers | undefined): void {
  activityTimers = timers ?? defaultActivityTimers
}

/**
 * Replace the clock behind the elapsed label, the output rate, and the
 * stopping hold (tests pin it here).
 * @param now - the replacement, or `undefined` to restore `Date.now`.
 */
export function setActivityClock(now: (() => number) | undefined): void {
  activityNow = now ?? (() => Date.now())
}

/** What the pane renders; `hidden` covers the dialog hangup. */
type ActivityMode = 'hidden' | 'idle' | 'stopping' | 'waiting' | ActivityPhase

/** Whether the line under the header teaches (a rotating tip while no action runs) or stays blank. */
type QuietHints = 'full' | 'off'

/** The pane's render state, reconciled by the `sync` closure in `apply`. */
interface ActivityState {
  /** The resolved mode the row renders from. */
  mode: ActivityMode
  /** The teaching tip that fills the line under the header while no action runs. */
  tip: string
  /** The phase or running-action label (an untranslated locale key). */
  label: string
  /** The running action's detail. */
  detail: string
  /** The turn the tip rotation belongs to. */
  turn: number
  /** The active turn's start (a session timestamp), the elapsed anchor. */
  turnStartedAt?: number | undefined
  /** When the current reasoning phase began. */
  thinkingSince?: number | undefined
  /** When the current decision wait began. */
  waitingSince?: number | undefined
  /** The decision the user is being asked for. */
  decision?: MayflyDecisionWait | undefined
  /** Whether a dialog panel occupies the editor slot. */
  dialog: boolean
  quietHints: QuietHints
  /** Whether the stream hides the process of a running turn (Compact), so this row carries the detail. */
  compact: boolean
}

/** The tail of counts after the label: `↑30.2k ↓4.1k`, parts omitted at zero. */
function flowCounter(up: number | undefined, downChars: number): string {
  const down = outputCounter(downChars)
  const parts: string[] = []
  if (up !== undefined) parts.push(`↑${formatTokens(up)}`)
  if (down !== '') parts.push(down)
  return parts.join(' ')
}

/** The phase of one mode, for the modes that draw a header. */
function phaseOf(mode: ActivityMode): ActivityPhase | undefined {
  return mode === 'hidden' || mode === 'idle' ? undefined : mode
}

/**
 * The present-tense label for one mode: the phase, or the running (or
 * preparing) tool category. Subagent spawns keep the waiting label because
 * the agents pane owns them, and a durable tool marker left from an earlier
 * step never labels a waiting row.
 */
function activityLabel(mode: ActivityMode, facts: ConversationFacts, decision: MayflyDecisionWait | undefined): string {
  if (mode === 'stopping') return STOPPING_LABEL
  if (mode === 'waiting') return decision?.kind === 'answer' ? ANSWER_LABEL : APPROVAL_LABEL
  if (mode === 'thinking') return THINKING_STAGES[0]!.label
  if (mode === 'writing') return WRITING_LABEL
  const activity = facts.activity
  const name = activity?.kind === 'tool' && activity.name !== undefined && !isSpawnToolName(activity.name) ? activity.name : undefined
  if (name === undefined) return WAITING_LABEL
  if (mode === 'tool') return runningLabel(toolActivity(name))
  return activity?.preparing === true ? preparingLabel(toolActivity(name)) : WAITING_LABEL
}

/**
 * The detail of the single action running now: the latest reasoning paragraph while thinking, or the running call's
 * salient argument (a generic tool falls back to its name). Only Compact draws it, because the stream shows no process there.
 */
function activityDetail(mode: ActivityMode, facts: ConversationFacts): string {
  const activity = facts.activity
  if (mode === 'thinking') return activity?.kind === 'reasoning' ? activity.detail ?? '' : ''
  if (mode !== 'tool' || activity?.kind !== 'tool' || activity.name === undefined || isSpawnToolName(activity.name)) return ''
  const detail = activity.detail ?? ''
  return detail === '' && toolActivity(activity.name) === 'tools' ? toolDisplayName(activity.name) : detail
}

/** Resolve the mode from editor occupancy, the decision wait, the stop latch, projection activity, and Agent status. */
function activityMode(state: ActivityState, facts: ConversationFacts, statusActive: boolean, stopPending: boolean): ActivityMode {
  // A dialog hides the row, except a decision dialog: the wait the user is being asked for stays named above it.
  if (state.dialog && state.decision === undefined) return 'hidden'
  // A latched interrupt outranks the projection phase: the user's stop is the
  // most recent truth even while the native turn drains.
  if (stopPending) return 'stopping'
  if (state.decision !== undefined) return 'waiting'
  if (facts.active) {
    switch (facts.phase) {
      case 'thinking': return 'thinking'
      case 'composing': return 'writing'
      case 'tool': return 'tool'
      default: return 'diving'
    }
  }
  return statusActive ? 'diving' : 'idle'
}

/** Read the preferences this row follows from the resolved `mayfly` settings section. */
function readPreferences(ctx: Context): { readonly quietHints: QuietHints, readonly compact: boolean } {
  const settings = ctx.get('mayflyInteractionState')?.settingsSource()
  return { quietHints: settings?.quietHints === 'off' ? 'off' : 'full', compact: settings?.transcriptView === 'compact' }
}

/**
 * Mount the activity pane. The row reconciles against five facts: the
 * editor-slot occupancy (dialogs hide the pane, decision dialogs excepted), the decision wait, the app-owned stop
 * latch (a latched interrupt renders the static stopping row), the current
 * session's admitted status (idle parks the placeholder), and the
 * projection-backed phase. One interval republishes the elapsed time and the
 * throughput each second while a phase is live; `sync` publishes at once when the
 * mode, label, detail, or tip changed. Unloading the fiber unmounts the pane and stops the timers.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  mountTranscriptLocale(ctx, 'transcript.activity', ACTIVITY_LOCALE)
  const t = transcriptTranslator(ctx, 'transcript.activity')
  const state: ActivityState = {
    mode: 'idle', tip: '', label: WAITING_LABEL, detail: '', turn: 0, dialog: false, ...readPreferences(ctx),
  }
  const factsService = ctx.get('mayflySessionFacts') as SessionFactsService | undefined
  /* mayflySessionFacts is an injected service; the fallback
     keeps direct thin-host construction renderer-neutral but cannot occur in
     a Cordis activation that satisfies this plugin's contract. */
  let facts: ConversationFacts = factsService?.current ?? {
    phase: 'idle', active: false, turn: 0, flowDownChars: 0, todos: [], contextTokens: 0, agentCalls: [],
  }
  let statusActive = factsService?.currentAgent?.status === 'running'
  // Best-effort initial read: the latch lives on the app-owned request
  // controller, which may not be provided in a thin-host construction.
  let stopPending = ctx.get('mayflyRequests')?.stopPending() ?? false
  /** When the current stopping acknowledgment started, for the minimum hold. */
  let stoppingSince = stopPending ? activityNow() : 0
  /** Deferred release of a stopping acknowledgment still inside its hold. */
  let stoppingHold: ReturnType<typeof setTimeout> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let ticks = 0
  /** The facts that decide the row's shape; a change publishes at once, the counters wait for the tick. */
  let shape = ''
  const rotation = buildTipRotation(STATUS_TIPS)
  let tipIndex = 0
  /** The line under the header when no action runs: the tip, or nothing. */
  const tipOf = (): string | undefined => state.quietHints === 'off' || state.tip === '' ? undefined : `${t('Tip: ')}${t(state.tip)}`
  const nextTip = (): void => {
    if (rotation.length === 0) return
    state.tip = rotation[tipIndex % rotation.length]!.text
    tipIndex += 1
  }

  const currentNode = (): MayflyUiNode | null => {
    if (state.mode === 'hidden') return null
    const phase = phaseOf(state.mode)
    if (phase === undefined) return { kind: 'spacer' }
    const tip = tipOf()
    const now = activityNow()
    const stage = phase === 'thinking' ? thinkingStage(state.thinkingSince === undefined ? 0 : now - state.thinkingSince) : undefined
    const facing: ActivityFacts = {
      phase,
      label: t(stage?.label ?? state.label),
      ...stage === undefined ? {} : { labelTone: stage.tone, labelStrong: stage.strong },
      ...state.detail === '' ? {} : { detail: state.detail },
      ...tip === undefined ? {} : { tip },
    }
    // A running call and its time are the stream's (a pending line), so the row names only the phase.
    if (phase === 'stopping' || phase === 'tool') return ActivityRow(facing)
    // The time of the phase the row names: how long the model has thought, how long the wait lasts, else the turn's.
    const since = phase === 'waiting' ? state.waitingSince : phase === 'thinking' ? state.thinkingSince : state.turnStartedAt
    const elapsed = since === undefined ? '' : compactElapsedMs(Math.max(0, now - since))
    const counters = phase === 'waiting' ? '' : flowCounter(facts.flowUp, facts.outputProgress?.chars ?? facts.flowDownChars)
    const rate = phase === 'waiting' ? '' : outputRate(facts.outputProgress, now)
    return ActivityRow({ ...facing, tail: [elapsed, counters, rate].filter(text => text !== '') })
  }
  const pane = ctx.mayflyPanes.register({
    id: 'mayfly.pane.activity',
    placement: 'bottom',
    priority: 10,
    narrow: 'bottom',
  }, currentNode())
  const publish = (): void => pane.set(currentNode())

  const stopTimer = (): void => {
    if (timer === undefined) return
    activityTimers.clearInterval(timer)
    timer = undefined
  }

  /** The interval republishes the time-dependent tail only while a phase is live. */
  const ensureTimer = (): void => {
    if (timer !== undefined) return
    timer = activityTimers.setInterval(() => {
      ticks += 1
      if (ticks % TIP_TICKS === 0) nextTip()
      publish()
    }, TICK_MS)
  }

  /** Reconcile the row (mode, tip, detail, timer) with the pane's facts. */
  const sync = (): void => {
    const mode = activityMode(state, facts, statusActive, stopPending)
    const label = activityLabel(mode, facts, state.decision)
    const detail = state.compact ? activityDetail(mode, facts) : ''
    if (mode === 'thinking' && state.mode !== 'thinking') state.thinkingSince = activityNow()
    if (mode !== 'thinking') state.thinkingSince = undefined
    // A fresh tip when a turn's row appears; the interval rotates it while the turn runs.
    const live = mode !== 'hidden' && mode !== 'idle'
    if (live && (state.mode === 'idle' || state.mode === 'hidden' || facts.turn !== state.turn)) nextTip()
    state.turn = facts.turn
    if (live && mode !== 'stopping') ensureTimer()
    else stopTimer()
    const nextStart = facts.active ? facts.turnStartedAt : undefined
    // The stage is part of the shape, so a stage change publishes at once, whatever moment the facts arrive at.
    const stage = mode === 'thinking' ? thinkingStage(activityNow() - (state.thinkingSince ?? activityNow())).label : ''
    const next = JSON.stringify([mode, label, stage, detail, state.tip, state.quietHints, state.compact, facts.flowUp, nextStart, state.waitingSince, state.thinkingSince])
    state.mode = mode
    state.label = label
    state.detail = detail
    state.turnStartedAt = nextStart
    if (next === shape) return
    shape = next
    publish()
  }
  const offFacts = factsService?.subscribe(next => {
    facts = next
    if (!next.active && next.turn > 0) statusActive = false
    sync()
  })
  const offAgent = factsService?.subscribeAgent((agent) => {
    statusActive = agent?.status === 'running'
    sync()
  })
  const offStop = ctx.on('mayfly/request-stop-changed', (pending) => {
    if (pending) {
      if (stoppingHold !== undefined) {
        activityTimers.clearTimeout(stoppingHold)
        stoppingHold = undefined
      }
      stopPending = true
      stoppingSince = activityNow()
    } else {
      // The native turn settled. A stop that lands inside the hold keeps the
      // acknowledgment up for the rest of its minimum visible duration.
      const remaining = STOPPING_MIN_MS - (activityNow() - stoppingSince)
      if (remaining > 0) {
        if (stoppingHold === undefined) {
          stoppingHold = activityTimers.setTimeout(() => {
            stoppingHold = undefined
            stopPending = false
            sync()
          }, remaining)
        }
        return
      }
      stopPending = false
    }
    sync()
  })
  ctx.effect(() => () => offFacts?.())
  ctx.effect(() => () => offAgent?.())
  ctx.effect(() => offStop)
  ctx.on('mayfly/editor-slot-swapped', (occupied) => {
    state.dialog = occupied
    sync()
  })
  ctx.on('mayfly/decision-wait-changed', (wait) => {
    if (wait !== undefined && state.decision === undefined) state.waitingSince = activityNow()
    if (wait === undefined) state.waitingSince = undefined
    state.decision = wait
    sync()
  })
  ctx.on('settings/document-updated', (namespace) => {
    if (String(namespace) !== 'mayfly') return
    const next = readPreferences(ctx)
    if (next.quietHints === state.quietHints && next.compact === state.compact) return
    state.quietHints = next.quietHints
    state.compact = next.compact
    sync()
  })

  const offLocale = observeTranscriptLocale(ctx, () => {
    publish()
  })
  ctx.effect(() => offLocale)
  // The cue is resolved from the keymap at every publish, so a rebound key shows at the next tick.
  // Effect-bound so unloading this fiber stops the timers and any pending
  // stopping hold.
  ctx.effect(() => () => {
    stopTimer()
    if (stoppingHold !== undefined) {
      activityTimers.clearTimeout(stoppingHold)
      stoppingHold = undefined
    }
    pane.dispose()
  })
}
