/** Published Mayfly welcome banner driven by remote Session facts. @module */
import { composeBannerLines, shortenHome } from '../transcript/banner-model.ts'
import { composeSplashLines, type SplashContent } from '../transcript/splash.ts'
import { MAYFLY_VERSION } from '../transcript/banner-content.ts'
import { GutterComponent } from '../core/gutter.ts'
import type { MayflyComponent, MayflyComponents, MayflySemanticColors } from '../core/types.ts'
import type { RemotePresentationFacts } from '../transcript/remote-model.ts'

/** Renderer-owned live sources; the Host owns directory and home values. */
interface RemoteBannerOptions {
  /** The physical Host Client owns one greeting, including before its first Session. */
  readonly identity?: () => unknown
  readonly home?: () => string
  readonly directory?: () => string
  /** Elapsed milliseconds of the reference fly-in, or undefined at rest. */
  readonly flyInAt?: () => number | undefined
  readonly colors?: () => MayflySemanticColors
  readonly components?: () => MayflyComponents
  /** The reference launch screen replaces the compact banner before a Session exists. */
  readonly splash?: () => SplashContent | 'pending' | undefined
  readonly rows?: () => number
}

/** The rc.2 banner composer and one-column gutter, including its opening/closing rows. */
export class RemoteBannerComponent implements MayflyComponent {
  private readonly gutter: GutterComponent
  private identity: unknown
  private session: RemotePresentationFacts['ref']
  private greeting: Pick<RemotePresentationFacts, 'model' | 'provider'> | undefined
  private composed: { readonly inputs: readonly unknown[], readonly lines: string[] } | undefined

  constructor(
    private readonly colors: MayflySemanticColors,
    private readonly components: MayflyComponents,
    private readonly facts: () => RemotePresentationFacts,
    private readonly options: RemoteBannerOptions = {},
  ) {
    this.gutter = new GutterComponent({ render: width => this.compose(width), invalidate: () => { this.composed = undefined } })
  }

  render(width: number): string[] {
    return width <= 0 ? [] : this.gutter.render(width)
  }

  invalidate(): void {
    this.gutter.invalidate()
  }

  private compose(width: number): string[] {
    const current = this.facts()
    const identity = this.options.identity?.()
    if (identity !== this.identity || current.ref?.host !== this.session?.host || current.ref?.sessionId !== this.session?.sessionId) {
      this.identity = identity
      this.session = current.ref
      this.greeting = undefined
    }
    // The reference greeting observes Session selections. Before a Session
    // exists, changing the next-request default updates the footer only.
    if (this.greeting === undefined || this.greeting.model === undefined || this.greeting.provider === undefined) {
      this.greeting = { model: current.model, provider: current.provider }
    }
    const route = current.ref === undefined ? this.greeting : current
    const components = this.options.components?.() ?? this.components
    const colors = this.options.colors?.() ?? this.colors
    const at = components.presentation?.reducedMotion === true ? undefined : this.options.flyInAt?.()
    const splash = this.options.splash?.()
    if (splash === 'pending') return []
    const rows = splash === undefined ? undefined : this.options.rows?.() ?? 1
    const cwd = splash === undefined ? shortenHome(current.cwd || this.options.directory?.() || 'unknown', this.options.home?.() ?? '') : ''
    // Every frame renders the banner. Its rows change only with these inputs,
    // and returning the same rows lets the gutter keep its cached frame too.
    const ascii = components.presentation?.glyphs === 'ascii'
    const inputs = [width, components, colors, ascii, at, splash, rows, route.model, route.provider, cwd]
    if (this.composed !== undefined && inputs.every((input, index) => Object.is(input, this.composed!.inputs[index]))) return this.composed.lines
    const deps = {
      colors,
      strong: (text: string) => components.strong(text),
      truncate: (text: string, target: number) => components.truncateToWidth(text, target, '…'),
      visibleWidth: (text: string) => components.visibleWidth(text),
      ascii,
    }
    const lines = splash !== undefined
      ? composeSplashLines(deps, splash, width, rows!, at)
      : ['', ...composeBannerLines(deps, {
        version: MAYFLY_VERSION,
        model: route.model ?? 'default',
        provider: route.provider ?? 'default',
        cwd,
      }, width, at), '']
    this.composed = { inputs, lines }
    return lines
  }
}
