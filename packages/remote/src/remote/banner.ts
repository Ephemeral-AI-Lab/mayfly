/** Published Mayfly welcome banner driven by remote Session facts. @module */
import { composeBannerLines, shortenHome } from '@ephemeral-ai/mayfly/banner'
import { composeSplashLines, MAYFLY_VERSION, type SplashContent } from '@ephemeral-ai/mayfly/banner-content'
import { GutterComponent, type MayflyComponent, type MayflyComponents, type MayflySemanticColors } from '@ephemeral-ai/mayfly/core'
import type { RemotePresentationFacts } from '../transcript/remote-model.ts'

/** Renderer-owned live sources; the Host owns directory and home values. */
export interface RemoteBannerOptions {
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

  constructor(
    private readonly colors: MayflySemanticColors,
    private readonly components: MayflyComponents,
    private readonly facts: () => RemotePresentationFacts,
    private readonly options: RemoteBannerOptions = {},
  ) {
    this.gutter = new GutterComponent({ render: width => this.compose(width), invalidate: () => {} })
  }

  render(width: number): string[] {
    return width <= 0 ? [] : this.gutter.render(width)
  }

  invalidate(): void {
    this.gutter.invalidate()
  }

  private compose(width: number): string[] {
    const current = this.facts()
    const components = this.options.components?.() ?? this.components
    const deps = {
      colors: this.options.colors?.() ?? this.colors,
      strong: (text: string) => components.strong(text),
      truncate: (text: string, target: number) => components.truncateToWidth(text, target, '…'),
      visibleWidth: (text: string) => components.visibleWidth(text),
      ascii: components.presentation?.glyphs === 'ascii',
    }
    const at = components.presentation?.reducedMotion === true ? undefined : this.options.flyInAt?.()
    const splash = this.options.splash?.()
    if (splash === 'pending') return []
    if (splash !== undefined) return composeSplashLines(deps, splash, width, this.options.rows?.() ?? 1, at)
    const rows = composeBannerLines(deps, {
      version: MAYFLY_VERSION,
      model: current.model ?? 'default',
      provider: current.provider ?? 'default',
      cwd: shortenHome(current.cwd || this.options.directory?.() || 'unknown', this.options.home?.() ?? ''),
    }, width, at)
    return ['', ...rows, '']
  }
}
