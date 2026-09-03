/**
 * `mayfly-banner` plugin: the welcome banner, mounted once at boot as the
 * scroll area's first child — a frameless horizontal block: the Mayfly mark
 * logo on the left; the right-hand status column leads with the bold brand
 * word and the tagline, and the help line tucks against the three info
 * rows at the bottom, no box frame.
 * Below {@link BANNER_MIN_WIDTH} the banner renders nothing.
 *
 * The banner is a boot snapshot except the model line: it reads the app-owned
 * renderer-neutral session snapshot and re-derives whenever that snapshot
 * changes (the S24a dogfood ruling). In the bundle patch the row sits before
 * `mayfly-transcript` so the two fibers resolve in the same `mayflyComponents`
 * activation round in row order — the banner stays the first scroll child
 * across initial mounts and `/theme` reloads.
 *
 * Every over-wide run truncates; nothing ever wraps. Styling uses only
 * frozen theme tokens — the logo and the bold brand line share `primary`,
 * the labels stay muted and the model value accent, so the banner reads as
 * one brand color unit.
 *
 * @module @ephemeral-ai/mayfly/transcript/banner
 */

import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  GutterComponent,
  type MayflyComponent,
  type MayflyComponents,
  type MayflySemanticColors,
} from '../core/index.ts'
// Empty type import carries the `agentDefaultModel` Context merge this
// plugin's inject resolves.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-session-projection'
// Empty type import carries the app-owned session reader service.
import type {} from '../app/index.ts'
import { LOGO_ART, LOGO_ROWS } from './banner-art.ts'
import { MAYFLY_VERSION } from './banner-content.ts'
import type { MayflyTranslate } from '../frontend/index.ts'
import {
  BANNER_LOCALE,
  mountTranscriptLocale,
  observeTranscriptLocale,
  transcriptTranslator,
} from './locale.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-banner'

/** Services required before the banner can mount. */
export const inject = ['mayflyScreen', 'mayflyTheme', 'mayflyComponents', 'mayflyCurrentAgent', 'sessionProjections', 'agentDefaultModel']

/** Banner configuration; the display override never changes Mayfly's release version. */
export interface Config {
  /** Optional profile-local identity shown instead of {@link MAYFLY_VERSION}. */
  readonly displayVersion?: string
}

/** Below this viewport width the banner renders zero rows rather than overflow. */
export const BANNER_MIN_WIDTH = 40

/** Blank columns between the logo block and the right-hand status column. */
const LOGO_TEXT_GAP = 2

/** The info rows' labels, hand-aligned to {@link LABEL_WIDTH} columns. */
export const DIRECTORY_LABEL = 'Directory: '
const MODEL_LABEL = 'Model:     '
const VERSION_LABEL = 'Version:   '

/** The visible width every info-row label occupies. */
const LABEL_WIDTH = 11

/** One width computation for a banner render. */
export interface BannerLayout {
  /** The viewport width budget; every line stays within this many columns. */
  readonly total: number
  /** The width each status value may use, after the logo and its labels. */
  readonly valueWidth: number
}

/**
 * The banner's width plan for a viewport: `null` below
 * {@link BANNER_MIN_WIDTH}; otherwise the frameless horizontal budget. The
 * logo block and its gap are fixed furniture; the value column gets the rest.
 * @param width - current viewport width in columns.
 * @returns the layout, or `null` when the banner renders nothing.
 */
export function bannerLayout(width: number): BannerLayout | null {
  if (width < BANNER_MIN_WIDTH) return null
  const logoWidth = Math.max(...LOGO_ART.map(art => art.length))
  const valueWidth = Math.max(0, width - logoWidth - LOGO_TEXT_GAP - LABEL_WIDTH)
  return { total: width, valueWidth }
}

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

/** The banner's rendered facts, snapshotted once at mount. */
export interface BannerContent {
  /** The version shown in the Version row. */
  readonly version: string
  /** The default model id for the model row. */
  readonly model: string
  /** The default provider route for the model row. */
  readonly provider: string
  /** The working directory, already home-shortened. */
  readonly cwd: string
}

/** The theme tokens the banner paints with, keyed by segment role. */
type BannerStyle = 'raw' | 'logo' | 'strong' | 'accent' | 'muted' | 'text' | 'highlight'

/** One styled run of a rendered banner line. */
interface BannerSegment {
  readonly text: string
  readonly style: BannerStyle
}

/** The theme-wrapping and measuring primitives `composeBannerLines` needs. */
export interface BannerDeps {
  /** The semantic color table. */
  readonly colors: MayflySemanticColors
  /** Renderer-owned strong emphasis. */
  readonly strong: (text: string) => string
  /** ANSI-aware truncation; must never return wider input than asked for. */
  readonly truncate: (text: string, width: number) => string
  /** ANSI-aware visible-width measurement. */
  readonly visibleWidth: (text: string) => number
  /** Dynamic translator for banner-owned copy. */
  readonly t?: MayflyTranslate
}

/** The right-hand status lines, one per banner row. */
interface StatusLine {
  readonly text: string
  readonly style: BannerStyle
}

/**
 * Compose the banner's lines for one viewport width — the pure layout core
 * the component delegates to. Identity color functions (the spec fakes)
 * yield plain, measurable text. The frameless horizontal block stacks the
 * Mayfly mark rows down the left and places the status column's six lines
 * at fixed rows beside it; nothing ever wraps — an over-wide status value
 * or tagline truncates first.
 * @param deps - colors plus the truncate/measure primitives.
 * @param content - the snapshotted banner facts.
 * @param width - current viewport width in columns.
 * @returns the lines; none below {@link BANNER_MIN_WIDTH}.
 */
export function composeBannerLines(
  deps: BannerDeps,
  content: BannerContent,
  width: number,
): string[] {
  const layout = bannerLayout(width)
  if (layout === null) return []
  const { valueWidth } = layout
  const t = deps.t ?? ((key: string): string => key)
  const paint: Record<BannerStyle, (text: string) => string> = {
    raw: text => text,
    logo: deps.colors.primary,
    strong: text => deps.strong(deps.colors.primary(text)),
    accent: deps.colors.accent,
    muted: deps.colors.muted,
    text: deps.colors.text,
    highlight: deps.colors.modelHighlight ?? deps.colors.accent,
  }
  const line = (segments: readonly BannerSegment[]): string =>
    segments.map(segment => paint[segment.style](segment.text)).join('')

  // The right-hand status column: the bold brand word leads (row 1) with
  // the tagline right beneath it (brand identity stays English in every
  // locale); the localized help line tucks against the three info rows at
  // the bottom. Keyed by absolute row index against the logo's eight rows.
  const status: ReadonlyMap<number, StatusLine> = new Map([
    [1, { text: 'mayfly', style: 'strong' }],
    [2, { text: 'ephemeral agents, enduring works', style: 'accent' }],
    [4, { text: t('Send /help for help information.'), style: 'muted' }],
    [5, { text: `${t(DIRECTORY_LABEL)}${content.cwd}`, style: 'text' }],
    [6, { text: `${t(MODEL_LABEL)}${content.model} · ${content.provider}`, style: 'highlight' }],
    [7, { text: `${t(VERSION_LABEL)}${content.version}`, style: 'text' }],
  ])

  const fit = (text: string, style: BannerStyle, max: number): BannerSegment => {
    const truncated = deps.truncate(text, max)
    const widthOfFit = deps.visibleWidth(truncated)
    const pad = Math.max(0, max - widthOfFit)
    return { text: `${truncated}${' '.repeat(pad)}`, style }
  }

  const rows: string[] = []
  for (let i = 0; i < LOGO_ROWS; i += 1) {
    const statusLine = status.get(i)
    const segments: BannerSegment[] = [
      { text: (deps.colors.logoGradient[i] ?? deps.colors.primary)(LOGO_ART[i]!), style: 'raw' },
      { text: ' '.repeat(LOGO_TEXT_GAP), style: 'logo' },
    ]
    if (statusLine !== undefined) {
      segments.push(fit(statusLine.text, statusLine.style, valueWidth))
    }
    rows.push(line(segments))
  }
  return rows
}

/**
 * The welcome banner: every render re-composes from the current content,
 * so it tracks viewport resizes; the model row tracks the live selection
 * through {@link BannerComponent.update} (the cwd stays the boot snapshot
 * — the S24a dogfood ruling only pulled the model line into the live
 * tier).
 */
class BannerComponent implements MayflyComponent {
  private content: BannerContent

  /**
   * @param colors - the semantic color table.
   * @param components - the component factory providing truncation.
   * @param content - the boot-time banner facts.
   */
  constructor(
    private readonly colors: MayflySemanticColors,
    private readonly components: MayflyComponents,
    private readonly t: MayflyTranslate,
    content: BannerContent,
  ) {
    this.content = content
  }

  /** Swap the banner facts; the next render re-composes. */
  update(content: BannerContent): void {
    this.content = content
  }

  /**
   * @param width - current viewport width in columns.
   * @returns the banner lines; none below {@link BANNER_MIN_WIDTH}.
   */
  render(width: number): string[] {
    return composeBannerLines({
      colors: this.colors,
      strong: text => this.components.strong(text),
      truncate: (text, target) => this.components.truncateToWidth(text, target),
      visibleWidth: text => this.components.visibleWidth(text),
      t: this.t,
    }, this.content, width)
  }

  /** Stateless render; nothing to drop. */
  invalidate(): void {}
}

/**
 * Mount the welcome banner as the scroll area's first child. The cwd
 * snapshots at boot; the model line re-derives from the live session
 * snapshot on session switches and committed model picks (the S24a
 * dogfood ruling — the banner used to freeze the boot-time default,
 * surviving `/model` switches and even `/new`), falling back to the
 * default-model service before the app publishes a selection. The mount is
 * effect-bound so unloading this fiber (a `/theme` swap) unmounts and
 * re-mounts it in place.
 * @param ctx - plugin context.
 * @param config - optional profile-local display identity.
 */
export function apply(ctx: Context, config: Config = {}): void {
  mountTranscriptLocale(ctx, 'transcript.banner', BANNER_LOCALE)
  const t = transcriptTranslator(ctx, 'transcript.banner')
  const displayVersion = config.displayVersion ?? MAYFLY_VERSION
  const boot = ctx.agentDefaultModel.currentSelection()
  const banner = new BannerComponent(ctx.mayflyTheme.colors, ctx.mayflyComponents, t, {
    version: displayVersion,
    model: boot.model,
    provider: boot.provider,
    cwd: shortenHome(process.cwd(), homedir()),
  })
  const rederive = (agent: Agent | null): void => {
    const fallback = ctx.agentDefaultModel.currentSelection()
    const projected = agent === null
      ? undefined
      : ctx.sessionProjections.snapshot(agent.session, ['modelSelection']).values.modelSelection as {
          readonly next?: { readonly provider: string, readonly model: string } | null
        } | undefined
    const selection = projected?.next ?? agent?.session.requestHeader()?.config
    banner.update({
      version: displayVersion,
      model: selection?.model ?? fallback.model,
      provider: selection?.provider ?? fallback.provider,
      cwd: shortenHome(process.cwd(), homedir()),
    })
    ctx.mayflyScreen.requestRender()
  }
  const offAgent = ctx.mayflyCurrentAgent.subscribe(rederive)
  const offProjection = ctx.sessionProjections.onChanged((session, key) => {
    if (key === 'modelSelection' && session === ctx.mayflyCurrentAgent.current()?.session) rederive(ctx.mayflyCurrentAgent.current())
  })
  ctx.effect(() => () => offAgent())
  ctx.effect(() => () => offProjection())
  // Effect-bound so unloading this fiber unmounts the banner.
  ctx.effect(() => {
    const slot = ctx.mayflyScreen.mountContentSlot('transcript.prelude', new GutterComponent(banner))
    return () => slot.dispose()
  })
  const offLocale = observeTranscriptLocale(ctx, () => {
    banner.invalidate()
    ctx.mayflyScreen.requestRender(true)
  })
  ctx.effect(() => offLocale)
  // addChild schedules no render on its own.
  ctx.mayflyScreen.requestRender()
}
