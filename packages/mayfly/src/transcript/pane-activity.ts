/**
 * One activity row for the selected Agent — the transcript's only animated
 * spinner, so progress stays visible while the transcript is scrolled away.
 * Waiting uses the moon spinner; a tool phase adds the running tool's name;
 * thinking and composing show their label, phase-local output count, and
 * estimated rate. Responsive variants drop the tip, rate, then counters as
 * space shrinks. The row never collapses while active, so the editor does not
 * shift between phases. Idle holds a spacer; editor dialogs hide the pane. A latched user interrupt
 * (the app-owned stop request still draining) renders one static `■
 * interrupting...` row — held for a minimum visible duration, because a plain
 * abort settles within one render frame — so the keypress reads as accepted
 * while the native turn unwinds.
 *
 * The phase comes from the `mayflySessionFacts` bridge over the official
 * `mayflyConversationFacts` projection, so replay and live updates share one
 * whole value. The moon glyph is two cells wide; row width math goes through
 * the live `mayflyComponents.visibleWidth`.
 *
 * @module @ephemeral-ai/mayfly/transcript/pane-activity
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MayflyInlineSpan, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyComponents } from '../core/index.ts'
// Empty type import carries the app-owned opaque binding event merge.
import type {} from '../app/index.ts'
import type { ConversationFacts } from '../conversation/index.ts'
import type { OutputProgress } from '../conversation/types.ts'
import { outputRate } from './output-rate.ts'
import type { SessionFactsService } from './session-facts.ts'
import { formatTokens } from './status-context.ts'
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
} from './spinners.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-pane-activity'

/** Services required before the pane can mount. */
export const inject = ['mayflyPanes', 'mayflySessionFacts', 'mayflyComponents']

/** The joiner between the frame and the teaching tip (kimi format). */
const TIP_LEAD = ' · Tip: '

/** The composing row's base: one frame cell, a space, the kimi label. */
const WORKING_LABEL = ' working...'

/** The thinking row's base label. */
const THINKING_LABEL = ' thinking...'

/** The stopping row's label; the `■` marker rides in error red beside it. */
const STOPPING_LABEL = ' interrupting...'

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

/**
 * Replace the animation timers (tests inject fakes here).
 * @param timers - the replacement, or `undefined` to restore the defaults.
 */
export function setActivityTimers(timers: ActivityTimers | undefined): void {
  activityTimers = timers ?? defaultActivityTimers
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
  /** The running tool's display name during a tool phase; '' otherwise. */
  tool: string
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
  const down = Math.floor(flow.downChars / 4)
  const parts: string[] = []
  if (flow.up !== undefined) parts.push(`↑${formatTokens(flow.up)}`)
  if (down > 0) parts.push(`↓${formatTokens(down)}`)
  return parts.join(' ')
}

/** Build the one-row canonical activity node for the current state. */
function activityNode(state: ActivityState, t: MayflyTranslate, components: MayflyComponents): MayflyUiNode {
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
  const frame = moon
    ? MOON_SPINNER_FRAMES[state.frame % MOON_SPINNER_FRAMES.length]!
    : BRAILLE_SPINNER_FRAMES[state.frame % BRAILLE_SPINNER_FRAMES.length]!
  const rate = outputRate(state.outputProgress, Date.now())
  const label = state.mode === 'thinking' ? t(THINKING_LABEL) : state.mode === 'composing' ? t(WORKING_LABEL) : state.tool === '' ? '' : ` ${state.tool}`
  const spans: MayflyInlineSpan[] = [
    { text: frame, tone: 'accent', styles: ['strong'] },
    ...(label === '' ? [] : [{ text: label } as const]),
  ]
  const variants = [spans.slice()]
  for (const text of [
    state.flow === '' ? '' : ` ${state.flow}`,
    rate === '' ? '' : ` · ${rate}`,
    `${t(TIP_LEAD)}${t(state.tip)}`,
  ]) {
    if (text === '') continue
    spans.push({ text, tone: 'muted' })
    variants.push(spans.slice())
  }
  const widths = variants.map(parts => components.visibleWidth(parts.map(part => part.text).join('')))
  return {
    kind: 'stack', direction: 'column',
    children: variants.map((parts, index) => ({
      node: { kind: 'rich-text', spans: parts },
      when: {
        ...(index === 0 ? {} : { minWidth: widths[index]! }),
        ...(index === variants.length - 1 ? {} : { maxWidth: widths[index + 1]! - 1 }),
      },
    })),
  }
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
    mode: 'idle', frame: 0, tip: '', flow: '', tool: '', dialog: false,
  }
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
  let stoppingSince = stopPending ? Date.now() : 0
  /** Deferred release of a stopping acknowledgment still inside its hold. */
  let stoppingHold: ReturnType<typeof setTimeout> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let timerMs = 0
  let tipKind: TipKind | undefined
  const rotation = buildTipRotation(STATUS_TIPS)
  let tipIndex = 0
  const currentNode = (): MayflyUiNode | null => state.mode === 'hidden'
    ? null
    : activityNode(state, t, ctx.mayflyComponents)
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
    const nextTool = mode === 'tool' && facts.activity?.kind === 'tool' && facts.activity.name !== undefined ? toolDisplayName(facts.activity.name) : ''
    const changed = mode !== state.mode || tipChanged || nextFlow !== state.flow || progress !== state.outputProgress || nextTool !== state.tool
    state.mode = mode
    state.flow = nextFlow
    state.tool = nextTool
    state.outputProgress = progress
    if (changed) publish()
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
      stoppingSince = Date.now()
    } else {
      // The native turn settled. A stop that lands inside the hold keeps the
      // acknowledgment up for the rest of its minimum visible duration.
      const remaining = STOPPING_MIN_MS - (Date.now() - stoppingSince)
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
