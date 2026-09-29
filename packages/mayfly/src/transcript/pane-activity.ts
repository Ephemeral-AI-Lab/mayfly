/**
 * One activity row for the selected Agent — the sole owner of every live
 * fact: the transcript's only animated spinner, the turn's elapsed time, the
 * current phase and action, and live throughput, so progress stays visible
 * while the transcript is scrolled away and the transcript itself speaks only
 * in the past tense. The label reuses the process-title vocabulary in the
 * present tense: `Deep diving` while waiting on the model (and while a
 * subagent spawn runs, whose detail the agents pane owns), `Thinking`,
 * `Writing`, the running tool category (`Running commands`), or its
 * preparing form while a call's arguments stream. Standard (the work-details
 * `liveProcessDetail` capability) appends the running command, path, query,
 * or latest reasoning paragraph in the tail slot the teaching tip otherwise
 * takes; a file change the transcript already shows as a card adds none.
 * Responsive variants drop the tail, rate, counters, elapsed time, then the
 * label as space shrinks, truncating a long detail first. The row never
 * collapses while active, so the editor does not shift between phases. Idle
 * holds a spacer; editor dialogs hide the pane. A latched user interrupt
 * (the app-owned stop request still draining) renders one static `■
 * interrupting...` row — held for a minimum visible duration, because a plain
 * abort settles within one render frame — so the keypress reads as accepted
 * while the native turn unwinds.
 *
 * The phase and elapsed anchor come from the `mayflySessionFacts` bridge over
 * the official `mayflyConversationFacts` projection, so replay and live
 * updates share one whole value; the spinner ticks only animate the label.
 * The moon glyph is two cells wide; row width math goes through the live
 * `mayflyComponents.visibleWidth`.
 *
 * @module @ephemeral-ai/mayfly/transcript/pane-activity
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MayflyInlineSpan, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyComponents } from '../core/index.ts'
// Empty type import carries the app-owned opaque binding event merge.
import type {} from '../app/index.ts'
import type { ConversationFacts } from '../conversation/index.ts'
import { isSpawnToolName } from '../conversation/projection.ts'
import type { OutputProgress } from '../conversation/types.ts'
import { compactElapsedMs } from './agent-presentation.ts'
import { outputCounter, outputRate } from './output-rate.ts'
import { followPresentationSettings, TranscriptPresentationPolicy } from './presentation-policy.ts'
import { preparingLabel, runningLabel, toolActivity } from './process-activity.ts'
import type { SessionFactsService } from './session-facts.ts'
import { formatTokens } from './status-context.ts'
import { displayKey } from '../core/key-actions.ts'
import type { MayflyKeymap } from '../core/types.ts'
import { buildTipRotation } from './status-tips.ts'
import { toolDisplayName } from './tool-line.ts'
import { STATUS_TIPS } from './tips-content.ts'
import type { MayflyTranslate } from '../frontend/index.ts'
import {
  ACTIVITY_LOCALE,
  mountTranscriptLocale,
  observeTranscriptLocale,
  transcriptTranslator,
} from './locale.ts'
import {
  BRAILLE_SPINNER_FRAMES,
  BRAILLE_SPINNER_INTERVAL_MS,
  MOON_SPINNER_FRAMES,
  MOON_SPINNER_INTERVAL_MS,
} from '../core/glyphs.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-pane-activity'

/** Services required before the pane can mount. */
export const inject = ['mayflyPanes', 'mayflySessionFacts', 'mayflyComponents']

/** The joiner between the frame and the teaching tip (kimi format). */
const TIP_LEAD = ' · Tip: '

/** The label while the turn waits on the model (the retired turn header's phrase). */
const WAITING_LABEL = 'Deep diving'

/** The reasoning phase's label. */
const THINKING_LABEL = 'Thinking'

/** The answer-text phase's label. */
const WRITING_LABEL = 'Writing'

/** Cell budgets a long detail truncates to before it shows whole. */
const DETAIL_BUDGETS = [12, 24, 40, 64, 96]

/** The stopping row's label; the `■` marker rides in error red beside it. */
const STOPPING_LABEL = ' interrupting…'

/**
 * Minimum time the stopping acknowledgment stays up. A plain-text abort
 * settles within one render frame, so without a hold the row could lose the
 * race and never paint — the keypress must always read as accepted.
 */
const STOPPING_MIN_MS = 600

/** The timer primitives behind the spinner animation; replaceable in tests. */
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
 * Replace the animation timers (tests inject fakes here).
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
export type ActivityPaneMode = 'hidden' | 'waiting' | 'thinking' | 'composing' | 'tool' | 'stopping' | 'idle'

/** The loading kinds that carry a teaching tip (kimi `loadingTipKind`). */
type TipKind = 'moon' | 'composing'

/** The pane's render state, reconciled by the `sync` closure in `apply`. */
interface ActivityState {
  /** The resolved mode the row renders from. */
  mode: ActivityPaneMode
  /** The current spinner frame counter (moon and braille share it). */
  frame: number
  /** The teaching tip riding the spinner row; '' outside the spinner states. */
  tip: string
  /** The live turn-flow counter riding the spinner row; '' before any data. */
  flow: string
  /** The phase or running-action label (an untranslated locale key). */
  label: string
  /** The running action's detail, when the policy shows one; '' otherwise. */
  detail: string
  /** The active turn's start (a session timestamp), the elapsed anchor. */
  turnStartedAt?: number | undefined
  outputProgress?: OutputProgress | undefined
  /** Whether a dialog panel occupies the editor slot. */
  dialog: boolean
}

/**
 * Input usage and output character counts from the facts projection.
 * Composing counts only the current text phase; waiting/tools retain the
 * existing step total. Output uses the Harness four-characters/token estimate.
 */
interface TurnFlow {
  /** Context tokens of the latest `assistant/message` usage this turn. */
  up: number | undefined
  /** Streamed text + reasoning characters this turn. */
  downChars: number
}

/** The spinner row's counter text: `↑30.2k ↓4.1k`, parts omitted at zero. */
function flowCounter(flow: TurnFlow): string {
  const down = outputCounter(flow.downChars)
  const parts: string[] = []
  if (flow.up !== undefined) parts.push(`↑${formatTokens(flow.up)}`)
  if (down !== '') parts.push(down)
  return parts.join(' ')
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Truncate plain text to a cell budget, ending in `…`. */
function fitCells(text: string, cells: number, width: (text: string) => number): string {
  let out = ''
  let used = 0
  for (const { segment } of graphemes.segment(text)) {
    const cost = width(segment)
    if (used + cost > cells - 1) break
    out += segment
    used += cost
  }
  return `${out.trimEnd()}…`
}

/**
 * Build the one-row canonical activity node for the current state: width
 * variants from the bare frame up to the full row, each wider than the last,
 * so the narrowest fitting one never wraps.
 */
function activityNode(state: ActivityState, t: MayflyTranslate, components: MayflyComponents, keymap?: MayflyKeymap): MayflyUiNode {
  if (state.mode === 'idle') return { kind: 'spacer' }
  // The latched interrupt is static by design: no frame advances, so the row
  // cannot read as the spinner that ignored the keypress.
  if (state.mode === 'stopping') {
    return {
      kind: 'rich-text',
      spans: [
        { text: '■', tone: 'danger', styles: ['strong'] },
        { text: t(STOPPING_LABEL), tone: 'muted' },
      ],
    }
  }
  const moon = state.mode === 'waiting' || state.mode === 'tool'
  const frame = components.asciiGlyphs === true ? (components.reducedMotion === true ? '-' : ['-', '\\', '|', '/'][state.frame % 4]!) : moon
    ? MOON_SPINNER_FRAMES[(components.reducedMotion === true ? 0 : state.frame) % MOON_SPINNER_FRAMES.length]!
    : BRAILLE_SPINNER_FRAMES[(components.reducedMotion === true ? 0 : state.frame) % BRAILLE_SPINNER_FRAMES.length]!
  const now = activityNow()
  const rate = outputRate(state.outputProgress, now)
  const elapsed = state.turnStartedAt === undefined ? '' : compactElapsedMs(Math.max(0, now - state.turnStartedAt))
  const width = (parts: readonly MayflyInlineSpan[]): number => components.visibleWidth(parts.map(part => part.text).join(''))
  const spans: MayflyInlineSpan[] = [{ text: frame, tone: 'accent', styles: ['strong'] }]
  const variants = [spans.slice()]
  const grow = (span: MayflyInlineSpan): void => {
    spans.push(span)
    variants.push(spans.slice())
  }
  grow({ text: ` ${t(state.label)}` })
  for (const text of [elapsed, state.flow, rate]) {
    if (text !== '') grow({ text: ` · ${text}`, tone: 'muted' })
  }
  if (state.detail !== '') {
    // The detail takes the tail slot: truncated budgets first, then whole.
    const full = components.visibleWidth(state.detail)
    for (const cells of DETAIL_BUDGETS) {
      if (cells < full) variants.push([...spans, { text: ` · ${fitCells(state.detail, cells, components.visibleWidth)}` }])
    }
    grow({ text: ` · ${state.detail}` })
  } else {
    const action = STATUS_TIPS.find(tip => tip.text === state.tip)?.keyAction
    const key = action === undefined ? '' : keymap?.getKeys(action).map(displayKey).join('/') ?? ''
    if (action === undefined || key !== '') grow({ text: `${t(TIP_LEAD)}${t(state.tip, { key })}`, tone: 'muted' })
  }
  const ladder: { readonly parts: MayflyInlineSpan[], readonly width: number }[] = []
  for (const parts of variants) {
    const cells = width(parts)
    if (ladder.length === 0 || cells > ladder.at(-1)!.width) ladder.push({ parts, width: cells })
  }
  return {
    kind: 'stack', direction: 'column',
    children: ladder.map((variant, index) => ({
      node: { kind: 'rich-text', spans: variant.parts },
      when: {
        ...(index === 0 ? {} : { minWidth: variant.width }),
        ...(index === ladder.length - 1 ? {} : { maxWidth: ladder[index + 1]!.width - 1 }),
      },
    })),
  }
}

/**
 * The present-tense label for one mode: the phase, or the running (or
 * preparing) tool category. Subagent spawns keep the waiting label because
 * the agents pane owns them, and a durable tool marker left from an earlier
 * step never labels a waiting row.
 */
function activityLabel(mode: ActivityPaneMode, facts: ConversationFacts): string {
  if (mode === 'thinking') return THINKING_LABEL
  if (mode === 'composing') return WRITING_LABEL
  const activity = facts.activity
  const name = activity?.kind === 'tool' && activity.name !== undefined && !isSpawnToolName(activity.name) ? activity.name : undefined
  if (name === undefined) return WAITING_LABEL
  if (mode === 'tool') return runningLabel(toolActivity(name))
  return mode === 'waiting' && activity?.preparing === true ? preparingLabel(toolActivity(name)) : WAITING_LABEL
}

/**
 * The running action's detail under a policy: the latest reasoning paragraph
 * while thinking, else the running call's salient argument (a generic tool
 * falls back to its name). File changes that render as transcript cards, and
 * everything under a policy without live detail, carry none.
 */
function activityDetail(mode: ActivityPaneMode, facts: ConversationFacts, policy: TranscriptPresentationPolicy): string {
  const process = policy.snapshot().process
  if (!process.liveProcessDetail) return ''
  const activity = facts.activity
  if (mode === 'thinking') return activity?.kind === 'reasoning' ? activity.detail ?? '' : ''
  if (mode !== 'tool' || activity?.kind !== 'tool' || activity.name === undefined || isSpawnToolName(activity.name)) return ''
  const category = toolActivity(activity.name)
  if (process.fileChanges === 'content' && (category === 'edit' || category === 'write')) return ''
  const detail = activity.detail ?? ''
  return detail === '' && category === 'tools' ? toolDisplayName(activity.name) : detail
}

/** Resolve the pane mode from editor occupancy, the stop latch, projection activity, and Agent status. */
function activityMode(state: ActivityState, facts: ConversationFacts, statusActive: boolean, stopPending: boolean): ActivityPaneMode {
  if (state.dialog) return 'hidden'
  // A latched interrupt outranks the projection phase: the user's stop is the
  // most recent truth even while the native turn drains.
  if (stopPending) return 'stopping'
  if (facts.active) return facts.phase
  return statusActive ? 'waiting' : 'idle'
}

/**
 * Mount the activity pane. The row reconciles against four facts: the
 * editor-slot occupancy (dialogs hide the pane), the app-owned stop latch
 * (a latched interrupt renders the static stopping row), the current
 * session's admitted status (idle parks the placeholder), and the
 * projection-backed phase. The
 * frame timer runs only while a spinner
 * state is live, at the style's interval (moon 120 ms, braille 80 ms); each
 * tick advances the shared frame counter and requests a redraw. `sync`
 * requests a redraw only when the mode or the tip actually changed.
 * Unloading the fiber unmounts the pane and stops the timer.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  mountTranscriptLocale(ctx, 'transcript.activity', ACTIVITY_LOCALE)
  const t = transcriptTranslator(ctx, 'transcript.activity')
  const state: ActivityState = {
    mode: 'idle', frame: 0, tip: '', flow: '', label: WAITING_LABEL, detail: '', dialog: false,
  }
  const policy = new TranscriptPresentationPolicy()
  const factsService = ctx.get('mayflySessionFacts') as SessionFactsService | undefined
  /* v8 ignore next -- mayflySessionFacts is an injected service; the fallback
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
  let timerMs = 0
  let tipKind: TipKind | undefined
  let flowUp: number | undefined
  const availableTips = () => STATUS_TIPS.filter(tip => tip.keyAction === undefined || (ctx.get('mayflyKeymap')?.getKeys(tip.keyAction).length ?? 0) > 0)
  let rotation = buildTipRotation(availableTips())
  let tipIndex = 0
  const currentNode = (): MayflyUiNode | null => state.mode === 'hidden'
    ? null
    : activityNode(state, t, ctx.mayflyComponents, ctx.get('mayflyKeymap'))
  const pane = ctx.mayflyPanes.register({
    id: 'mayfly.pane.activity',
    placement: 'bottom',
    priority: 10,
    size: { preferred: 1, max: 1 },
    narrow: 'bottom',
  }, currentNode())
  const publish = (): void => pane.set(currentNode())

  const stopTimer = (): void => {
    if (timer === undefined) return
    activityTimers.clearInterval(timer)
    timer = undefined
    timerMs = 0
  }

  const ensureTimer = (ms: number): void => {
    if (ctx.mayflyComponents.reducedMotion === true) ms = 1000
    if (timer !== undefined && timerMs === ms) return
    stopTimer()
    timerMs = ms
    timer = activityTimers.setInterval(() => {
      state.frame += 1
      publish()
    }, ms)
  }

  /** Reconcile the row (mode, tip, timer) with the pane's four facts. */
  const sync = (): void => {
    const mode = activityMode(state, facts, statusActive, stopPending)
    const kind: TipKind | undefined = mode === 'composing' || mode === 'thinking'
      ? 'composing'
      : mode === 'waiting' || mode === 'tool' ? 'moon' : undefined
    let tipChanged = false
    if (kind !== tipKind) {
      // A fresh tip when the loading kind changes, none when it goes away;
      // a continuous burst of tool calls never flips it (kimi semantics).
      tipKind = kind
      if (kind === undefined || rotation.length === 0) {
        state.tip = ''
      } else {
        state.tip = rotation[tipIndex % rotation.length]!.text
        tipIndex += 1
      }
      tipChanged = true
    }
    const spinner = kind !== undefined
    if (spinner) {
      ensureTimer(kind === 'composing' ? BRAILLE_SPINNER_INTERVAL_MS : MOON_SPINNER_INTERVAL_MS)
    } else {
      stopTimer()
    }
    const progress = kind === 'composing' ? facts.outputProgress : undefined
    const nextFlow = flowCounter({ up: facts.flowUp, downChars: progress?.chars ?? facts.flowDownChars })
    const nextLabel = activityLabel(mode, facts)
    const nextDetail = activityDetail(mode, facts, policy)
    const nextStart = facts.active ? facts.turnStartedAt : undefined
    // A running spinner republishes every frame, so streamed output counters
    // ride its tick instead of recompiling the row on every delta; a usage
    // (↑) change lands once per step and publishes at once.
    const upChanged = facts.flowUp !== flowUp
    flowUp = facts.flowUp
    const counters = nextFlow !== state.flow || progress !== state.outputProgress
    const changed = mode !== state.mode || tipChanged || (counters && (!spinner || upChanged))
      || nextLabel !== state.label || nextDetail !== state.detail || nextStart !== state.turnStartedAt
    state.mode = mode
    state.flow = nextFlow
    state.label = nextLabel
    state.detail = nextDetail
    state.turnStartedAt = nextStart
    state.outputProgress = progress
    if (changed) publish()
  }
  ctx.on('settings/document-updated', () => { sync(); publish() })
  ctx.on('mayfly/keymap-changed', () => { rotation = buildTipRotation(availableTips()); tipKind = undefined; sync(); publish() })
  // The work-details mode decides whether the row carries the live detail.
  followPresentationSettings(ctx, policy, sync)

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

  const offLocale = observeTranscriptLocale(ctx, () => {
    publish()
  })
  ctx.effect(() => offLocale)
  // Effect-bound so unloading this fiber stops the animation and any pending
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
