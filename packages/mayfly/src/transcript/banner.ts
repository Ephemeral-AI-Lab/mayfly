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
import { FLY_IN_FRAME_MS, FLY_IN_TOTAL_MS, flyInRows, markColumns, restRows, type MarkTextRun } from '../core/quad-mark.ts'
import type { MayflyColorFn, MayflyComponent, MayflyComponents, MayflySemanticColors } from '../core/types.ts'
// Empty type import carries the `agentDefaultModel` Context merge this
// plugin's inject resolves.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-session-projection'
// Empty type import carries the app-owned session reader service.
import type {} from '../app/index.ts'
import { MARK_BEAT, MARK_ROWS } from './banner-art.ts'
import { MAYFLY_VERSION } from './banner-content.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-banner'

/** Services required before the banner can mount; the painter adds the theme and the components. */
export const inject = ['mayflyScreen', 'mayflyCurrentAgent', 'sessionProjections', 'agentDefaultModel']

/** Banner configuration; the display override never changes Mayfly's release version. */
export interface Config {
  /** Optional profile-local identity shown instead of {@link MAYFLY_VERSION}. */
  readonly displayVersion?: string
}

/** Below this content width the banner drops the mark and shows its four lines alone. */
export const BANNER_MIN_WIDTH = 40

/** Blank columns between the mark and the four lines. */
const MARK_GAP = 2

/** The slogan; brand identity stays English in every locale. */
const SLOGAN = 'ephemeral agents, enduring works'

/**
 * Shorten a path by replacing the home-directory prefix with `~` — the exact
 * home and anything not under it (or an empty home) passes through.
 * @param path - the path to shorten.
 * @param home - the home directory, already normalized the same way.
 * @returns the shortened path.
 */
export function shortenHome(path: string, home: string): string {
  if (home === '') return path
  if (path === home) return '~'
  if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`
  return path
}

/** The banner's rendered facts. */
export interface BannerContent {
  /** The version beside the brand word. */
  readonly version: string
  /** The model id for the model line. */
  readonly model: string
  /** The provider route for the model line. */
  readonly provider: string
  /** The working directory, already home-shortened. */
  readonly cwd: string
}

/** The theme and measuring primitives `composeBannerLines` needs. */
export interface BannerDeps {
  /** The semantic color table. */
  readonly colors: MayflySemanticColors
  /** Renderer-owned strong emphasis. */
  readonly strong: (text: string) => string
  /** ANSI-aware truncation to a width, ending in `…` when it cuts. */
  readonly truncate: (text: string, width: number) => string
  /** ANSI-aware visible-width measurement. */
  readonly visibleWidth: (text: string) => number
  /** ASCII glyph mode: the mark is left out. */
  readonly ascii?: boolean
}

/** The version as shown beside the brand word: a release number reads `v0.1.3`, any other identity as it is. */
function versionLabel(version: string): string {
  return /^\d/u.test(version) ? `v${version}` : version
}

/** Styled runs cut to `max` columns; the run that does not fit ends in `…` and the rest are dropped. */
function fit(deps: BannerDeps, runs: readonly MarkTextRun[], max: number): MarkTextRun[] {
  const out: MarkTextRun[] = []
  let room = max
  for (const run of runs) {
    if (room <= 0) break
    const span = deps.visibleWidth(run.text)
    if (span <= room) {
      out.push(run)
      room -= span
      continue
    }
    out.push({ text: deps.truncate(run.text, room), paint: run.paint })
    room = 0
  }
  return out
}

/**
 * Compose the banner's lines for one width — the pure layout core the painter delegates to. Identity color functions
 * (the spec fakes) yield plain, measurable text.
 * @param deps - colors plus the truncate/measure primitives and the glyph mode.
 * @param content - the banner facts.
 * @param width - the content width in columns.
 * @param flyInAt - milliseconds into the fly-in, or undefined for the mark at rest.
 * @returns the four lines, the mark beside them when the width and glyph mode allow it.
 */
export function composeBannerLines(deps: BannerDeps, content: BannerContent, width: number, flyInAt?: number): string[] {
  if (width <= 0) return []
  const { colors } = deps
  const withMark = deps.ascii !== true && width >= BANNER_MIN_WIDTH
  const textWidth = withMark ? width - markColumns(MARK_ROWS) - MARK_GAP : width
  const brand: MayflyColorFn = text => deps.strong(colors.primary(text))
  const lines = [
    [{ text: 'mayfly', paint: brand }, { text: ` ${versionLabel(content.version)}`, paint: colors.textMuted }],
    [{ text: SLOGAN, paint: colors.accent }],
    [{ text: `${content.model} · ${content.provider}`, paint: colors.modelHighlight }],
    [{ text: content.cwd, paint: colors.muted }],
  ].map(runs => fit(deps, runs, textWidth))
  if (!withMark) return lines.map(runs => runs.map(run => run.paint(run.text)).join(''))
  const scene = { rows: MARK_ROWS, beat: MARK_BEAT, inks: colors.logoInks, gap: MARK_GAP, lines, width }
  return flyInAt === undefined ? restRows(scene) : flyInRows(scene, flyInAt)
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
  constructor(private readonly state: BannerState, private readonly deps: BannerDeps, private readonly reducedMotion: boolean) {}

  /**
   * @param width - the content width in columns.
   * @returns the banner lines and the blank row that closes them.
   */
  render(width: number): string[] {
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

/** One blank row closes the banner, the gap every turn after it has. */
function closed(lines: string[]): string[] {
  return lines.length === 0 ? lines : [...lines, '']
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
  }, components.presentation?.reducedMotion === true)
  let timer: ReturnType<typeof setInterval> | undefined
  const stop = (): void => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
  const play = (): void => {
    if (components.presentation?.reducedMotion === true) state.flyInStart = undefined
    if (state.flyInStart === undefined || timer !== undefined) return
    timer = setInterval(() => {
      const start = state.flyInStart
      if (start === undefined || performance.now() - start >= FLY_IN_TOTAL_MS) {
        stop()
        state.flyInStart = undefined
      }
      ctx.mayflyScreen.requestRender()
    }, FLY_IN_FRAME_MS)
    timer.unref?.()
  }
  ctx.effect(() => {
    state.onFlyIn = play
    return () => {
      if (state.onFlyIn === play) state.onFlyIn = undefined
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
  const greet = (): void => {
    const agent = ctx.mayflyCurrentAgent.primary()
    if (agent === null || seen.has(agent.session.id)) return
    seen.add(agent.session.id)
    state.greeted = true
    if (readPresentation(ctx).reducedMotion || agent.session.snapshotEvents().some(event => event.type === 'turn/start')) {
      ctx.mayflyScreen.requestRender()
      return
    }
    state.flyInStart = performance.now()
    state.onFlyIn?.()
  }
  const offAgent = ctx.mayflyCurrentAgent.subscribe(agent => {
    rederive(agent)
    greet()
  })
  const offProjection = ctx.sessionProjections.onChanged((session, key) => {
    if (key === 'modelSelection' && session === ctx.mayflyCurrentAgent.current()?.session) rederive(ctx.mayflyCurrentAgent.current())
  })
  ctx.effect(() => () => offAgent())
  ctx.effect(() => () => offProjection())
  greet()
  // A host that never shows a conversation still gets its banner, at rest.
  ctx.effect(() => {
    const wait = setTimeout(() => {
      if (state.greeted) return
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
