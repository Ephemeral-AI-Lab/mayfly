/**
 * `mayfly-banner` plugin: the welcome banner, the scroll area's first child —
 * PR 22's compact banner (option B): the s10 mark beside four lines, the brand
 * word and its version, the slogan, the model and provider, and the working
 * directory. No labels, no help line, no frame. Below {@link BANNER_MIN_WIDTH}
 * columns, and in ASCII glyph mode (quadrant blocks have no ASCII form), the
 * four lines show without the mark. Every over-wide run truncates with `…`;
 * nothing wraps.
 *
 * When a fresh conversation first shows (startup, `/new`, its alias `/clear`)
 * the mark flies in once (`core/quad-mark.ts`): it enters from the right edge,
 * crosses the status column with the text appearing in its wake, lands, beats
 * its wings twice and rests, in 1.55 s. A conversation that already has turns
 * (a resumed or forked session) shows the mark at rest, and reduced motion
 * never plays it.
 *
 * While no session exists and the `startup` setting asks for it, the same slot
 * paints the launch screen instead (`./splash.ts`): the plugin tracks that
 * state and the recent sessions of the directory, and the banner returns when a
 * session is selected.
 *
 * The plugin holds the facts and the fly-in and injects no theme, so a
 * `/theme` swap, a presentation reload, or an auto scheme change restarts only
 * its painter (an inner plugin on `mayflyTheme` and `mayflyComponents`) and a
 * fly-in in progress carries on rather than replaying. The model line
 * re-derives from the live session snapshot (the S24a dogfood ruling). In the
 * bundle patch the row sits before `mayfly-transcript`, so the banner stays
 * the first scroll child across mounts and reloads.
 *
 * @module @ephemeral-ai/mayfly/transcript/banner
 */

import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { GutterComponent } from '../core/gutter.ts'
import { readPresentation } from '../core/presentation.ts'
import { FLY_IN_FRAME_MS, FLY_IN_TOTAL_MS } from '../core/quad-mark.ts'
import type { MayflyComponent, MayflyComponents } from '../core/types.ts'
// Empty type import carries the `agentDefaultModel` Context merge this
// plugin's inject resolves.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-session-projection'
// Empty type import carries the app-owned session reader service.
import type {} from '../app/index.ts'
import { composeBannerLines, shortenHome, SLOGAN, type BannerContent, type BannerDeps } from './banner-model.ts'
export { BANNER_MIN_WIDTH, composeBannerLines, shortenHome } from './banner-model.ts'
export type { BannerContent, BannerDeps } from './banner-model.ts'
import { composeSplashLines, SPLASH_RECENT_MAX, type SplashContent, type SplashSession } from './splash.ts'
import { basename } from 'node:path'
import { interactionTranslator } from '../interaction/locale.ts'
import { formatAgo } from '../interaction/session-list-model.ts'
import { createSessionListCache, refreshSessionList, sessionListRows, sessionListTitle, type SessionListRow } from '../interaction/session-list-reads.ts'
import { MAYFLY_VERSION } from './banner-content.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Stored sessions were added or changed outside this process's own sessions (the launch screen lists them again). */
    'mayfly/session-catalog-changed'(): void
  }
}

/** Stable Cordis plugin name. */
export const name = 'mayfly-banner'

/** Services required before the banner can mount; the painter adds the theme and the components. */
export const inject = ['mayflyScreen', 'mayflyCurrentAgent', 'mayflySessionStart', 'sessionProjections', 'agentDefaultModel', 'sessionController']

/** Banner configuration; the display override never changes Mayfly's release version. */
export interface Config {
  /** Optional profile-local identity shown instead of {@link MAYFLY_VERSION}. */
  readonly displayVersion?: string
}

/** How long the banner waits for its first conversation before it gives up on a fly-in and shows the mark at rest. */
const GREETING_WAIT_MS = 1000

/** What the plugin keeps across painter restarts: the facts and the fly-in in progress. */
interface BannerState {
  content: BannerContent
  /**
   * Whether the first conversation is known (or waited for long enough). Until then the mark is not drawn at rest, so a
   * fresh conversation's fly-in does not start by taking a resting mark away.
   */
  greeted: boolean
  /** `performance.now()` when the fly-in started, or undefined while the mark rests. */
  flyInStart: number | undefined
  /** The painter's hook for a fly-in that starts while it is mounted. */
  onFlyIn: (() => void) | undefined
  /** The launch screen's facts while it replaces the banner: no session yet and the setting asks for it. `undefined` shows the banner. */
  splash: () => SplashContent | 'pending' | undefined
}

/**
 * The welcome banner's painter: while a fly-in plays every render composes a fresh frame; at rest the rows re-compose
 * only when the width or the facts change and are otherwise returned by identity, so the prelude never invalidates
 * the content frame on a pure scroll.
 */
class BannerComponent implements MayflyComponent {
  private cache: { readonly width: number, readonly content: BannerContent, readonly lines: string[] } | undefined

  /**
   * @param state - the plugin's facts and fly-in.
   * @param deps - the theme and measuring primitives.
   */
  constructor(
    private readonly state: BannerState,
    private readonly deps: BannerDeps,
    private readonly reducedMotion: boolean,
    /** The rows between the top of the screen and the editor, for the launch screen's vertical centering. */
    private readonly rows: () => number,
  ) {}

  /**
   * @param width - the content width in columns.
   * @returns the banner lines between the blank rows that open and close them.
   */
  render(width: number): string[] {
    const splash = this.state.splash()
    if (splash === 'pending') return []
    if (splash !== undefined) {
      const start = this.state.flyInStart
      const at = start === undefined ? undefined : performance.now() - start
      return composeSplashLines(this.deps, splash, width, this.rows(), at !== undefined && at < FLY_IN_TOTAL_MS ? at : undefined)
    }
    // Before the first conversation is known: the fly-in's first frame, the four lines held and the mark still off screen.
    if (!this.state.greeted && !this.reducedMotion) return closed(composeBannerLines(this.deps, this.state.content, width, 0))
    const start = this.state.flyInStart
    const at = start === undefined ? undefined : performance.now() - start
    if (at !== undefined && at < FLY_IN_TOTAL_MS) return closed(composeBannerLines(this.deps, this.state.content, width, at))
    const cached = this.cache
    if (cached?.width === width && cached.content === this.state.content) return cached.lines
    const lines = closed(composeBannerLines(this.deps, this.state.content, width))
    this.cache = { width, content: this.state.content, lines }
    return lines
  }

  /** Drop the composed rows; the next render re-composes. */
  invalidate(): void {
    this.cache = undefined
  }
}

/** One blank row opens the banner, under the top of the screen, and one closes it, the gap every turn after it has. */
function closed(lines: string[]): string[] {
  /* The gutter admits a positive content width; the banner then has four rows. */
  return ['', ...lines, '']
}

/**
 * Mount the painter: the banner component in the prelude, and the frame clock while a fly-in plays. It restarts with
 * the theme, the components, and the presentation; a fly-in in progress resumes at its own time, and reduced motion
 * ends it at rest.
 * @param ctx - the painter's context.
 * @param state - the plugin's facts and fly-in.
 */
function mountPainter(ctx: Context, state: BannerState): void {
  const components: MayflyComponents = ctx.mayflyComponents
  const banner = new BannerComponent(state, {
    colors: ctx.mayflyTheme.colors,
    strong: text => components.strong(text),
    truncate: (text, target) => components.truncateToWidth(text, target, '…'),
    visibleWidth: text => components.visibleWidth(text),
    ascii: components.presentation?.glyphs === 'ascii',
  }, components.presentation?.reducedMotion === true, () => Math.max(1, ctx.mayflyScreen.rows - ctx.mayflyScreen.editorRowsFromBottom))
  let timer: ReturnType<typeof setInterval> | undefined
  let active = true
  const stop = (): void => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
  const play = (): void => {
    if (components.presentation?.reducedMotion === true) state.flyInStart = undefined
    if (state.flyInStart === undefined || timer !== undefined) return
    timer = setInterval(() => {
      if (!active) return
      const start = state.flyInStart
      if (start === undefined || performance.now() - start >= FLY_IN_TOTAL_MS) {
        stop()
        state.flyInStart = undefined
      }
      ctx.mayflyScreen.requestRender()
    }, FLY_IN_FRAME_MS)
    timer.unref()
  }
  ctx.effect(() => {
    state.onFlyIn = play
    return () => {
      active = false
      state.onFlyIn = undefined
      stop()
    }
  })
  // Effect-bound so unloading the painter unmounts the banner.
  ctx.effect(() => {
    const slot = ctx.mayflyScreen.mountContentSlot('transcript.prelude', new GutterComponent(banner))
    return () => slot.dispose()
  })
  play()
  // addChild schedules no render on its own.
  ctx.mayflyScreen.requestRender()
}

/**
 * Mount the welcome banner. The cwd snapshots at boot; the model line
 * re-derives from the live session snapshot on session switches and committed
 * model picks, falling back to the default-model service before the app
 * publishes a selection. A primary conversation seen for the first time with
 * no turn yet starts the fly-in.
 * @param ctx - plugin context.
 * @param config - optional profile-local display identity.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const displayVersion = config.displayVersion ?? MAYFLY_VERSION
  const boot = ctx.agentDefaultModel.currentSelection()
  const state: BannerState = {
    content: { version: displayVersion, model: boot.model, provider: boot.provider, cwd: shortenHome(process.cwd(), homedir()) },
    greeted: false,
    flyInStart: undefined,
    onFlyIn: undefined,
    splash: () => {
      if (startup !== 'splash' || ctx.mayflyCurrentAgent.primary() !== null) return undefined
      if (!booted) return 'pending'
      return {
        version: displayVersion,
        labels: {
          slogan: SLOGAN,
          recent: t('Recent sessions'),
          more: t('↑ browse · /sessions for all'),
          moreFocused: t('↵ resume · esc back'),
          empty: t('No sessions here yet'),
          emptyHint: t('Describe a task below to start one.'),
        },
        recent,
        focus: ctx.get('mayflyInteractionState')?.splash.focus,
      }
    },
  }
  const rederive = (agent: Agent | null): void => {
    const fallback = ctx.agentDefaultModel.currentSelection()
    const projected = agent === null
      ? undefined
      : ctx.sessionProjections.snapshot(agent.session, ['modelSelection']).values.modelSelection as {
          readonly next?: { readonly provider: string, readonly model: string } | null
        } | undefined
    const selection = projected?.next ?? agent?.session.requestHeader()?.config
    state.content = {
      version: displayVersion,
      model: selection?.model ?? fallback.model,
      provider: selection?.provider ?? fallback.provider,
      cwd: shortenHome(process.cwd(), homedir()),
    }
    ctx.mayflyScreen.requestRender()
  }
  // The primary conversations the banner has shown: each plays the fly-in at most once, and only while it is fresh.
  const seen = new Set<string>()
  // The start surface (no session yet) plays it once per appearance; a session taking its place does not play it again.
  let startShown = false
  let booted = false
  const greet = (): void => {
    const agent = ctx.mayflyCurrentAgent.primary()
    if (agent === null) {
      if (!booted || startShown) return
      startShown = true
      state.greeted = true
      if (readPresentation(ctx).reducedMotion) {
        ctx.mayflyScreen.requestRender()
        return
      }
      state.flyInStart = performance.now()
      state.onFlyIn?.()
      return
    }
    // A session that takes the start surface's place (the first message, from the launch screen or the empty
    // conversation) has been greeted already: the mark does not fly in a second time, and one still flying stops.
    const fromStart = startShown
    startShown = false
    if (seen.has(agent.session.id)) return
    seen.add(agent.session.id)
    state.greeted = true
    if (fromStart) state.flyInStart = undefined
    if (fromStart || readPresentation(ctx).reducedMotion || agent.session.snapshotEvents().some(event => event.type === 'turn/start')) {
      ctx.mayflyScreen.requestRender()
      return
    }
    state.flyInStart = performance.now()
    state.onFlyIn?.()
  }
  // The launch screen: shown while no session exists and the `startup` setting asks for it.
  const t = interactionTranslator(ctx)
  // The settings owner loads after this plugin may: the source answers the default until it is ready.
  const readStartup = (): 'conversation' | 'splash' => ctx.get('mayflyInteractionState')?.settingsSource().startup ?? 'conversation'
  let startup = readStartup()
  let recent: SplashSession[] | undefined
  let loading = false
  const listCache = createSessionListCache(ctx)
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  /** Hand the editor the ids on show, so `↑` can browse them; a focused row that no longer exists is let go. */
  const publishBrowse = (entries: readonly SplashSession[]): void => {
    const browse = ctx.get('mayflyInteractionState')?.splash
    if (browse === undefined || startup !== 'splash' || ctx.mayflyCurrentAgent.primary() !== null) return
    browse.ids = entries.map(entry => entry.id)
    if (browse.focus !== undefined && browse.focus >= browse.ids.length) browse.focus = undefined
  }
  /** The list is not on screen (a session took its place, or the setting is off): nothing to browse. */
  const clearBrowse = (): void => {
    const browse = ctx.get('mayflyInteractionState')?.splash
    if (browse === undefined) return
    browse.ids = []
    browse.focus = undefined
  }
  /** Read this directory's newest sessions from one controller listing, once at a time. */
  const loadRecent = (): void => {
    if (loading || !booted || startup !== 'splash' || ctx.mayflyCurrentAgent.primary() !== null) return
    loading = true
    void refreshSessionList(ctx, listCache, lifetime.signal).then(() => {
      if (lifetime.signal.aborted) return
      const now = Date.now()
      const cwd = process.cwd()
      const usable = sessionListRows(ctx, listCache)
        .filter(row => !row.blank && row.parentSessionId === undefined)
      // This directory's sessions come first; other projects fill the rest in native activity order.
      const here = usable.filter(row => row.cwd === cwd)
      const others = here.length >= SPLASH_RECENT_MAX ? [] : usable.filter(row => row.cwd !== cwd)
      const shown = [...here, ...others].slice(0, SPLASH_RECENT_MAX)
      const item = (row: SessionListRow): SplashSession => ({
        id: String(row.sessionId),
        title: sessionListTitle(row) ?? t('Untitled'),
        project: basename(row.cwd ?? ''),
        age: row.running ? t('running') : formatAgo(now - row.updatedAt, t),
        live: row.running,
      })
      recent = shown.map(item)
      publishBrowse(recent)
    }).catch((error: unknown) => {
      if (lifetime.signal.aborted) return
      ctx.logger.warn(`splash: recent sessions unavailable: ${String(error)}`)
      recent = []
    }).finally(() => {
      loading = false
      if (!lifetime.signal.aborted) ctx.mayflyScreen.requestRender()
    })
  }
  const followStartup = (): void => {
    const next = readStartup()
    if (next === startup) return
    startup = next
    if (next === 'splash') loadRecent()
    else clearBrowse()
    ctx.mayflyScreen.requestRender()
  }
  ctx.effect(() => ctx.on('settings/document-updated', (ns) => { if (String(ns) === 'mayfly') followStartup() }))
  ctx.effect(() => ctx.on('mayfly/settings-source-ready', followStartup))
  ctx.effect(() => ctx.on('mayfly/session-catalog-changed', loadRecent))
  const offAgent = ctx.mayflyCurrentAgent.subscribe(agent => {
    rederive(agent)
    greet()
    if (agent === null) loadRecent()
    else clearBrowse()
  })
  // A launch with no session greets only once startup settled: a resume or a task selects its session first.
  const offBooted = ctx.mayflySessionStart.onBooted(() => {
    booted = true
    greet()
    loadRecent()
    ctx.mayflyScreen.requestRender()
  })
  const offProjection = ctx.sessionProjections.onChanged((session, key) => {
    if (key === 'modelSelection' && session === ctx.mayflyCurrentAgent.current()?.session) rederive(ctx.mayflyCurrentAgent.current())
  })
  ctx.effect(() => () => offAgent())
  ctx.effect(() => offBooted)
  ctx.effect(() => () => offProjection())
  greet()
  // A host that never shows a conversation still gets its banner, at rest.
  ctx.effect(() => {
    const wait = setTimeout(() => {
      if (lifetime.signal.aborted || state.greeted) return
      state.greeted = true
      ctx.mayflyScreen.requestRender()
    }, GREETING_WAIT_MS)
    wait.unref?.()
    return () => clearTimeout(wait)
  })
  ctx.plugin({
    name: 'mayfly-banner-painter',
    inject: ['mayflyScreen', 'mayflyTheme', 'mayflyComponents'],
    apply(painter: Context) {
      mountPainter(painter, state)
    },
  })
}
