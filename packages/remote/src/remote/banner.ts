/** Published Mayfly welcome banner driven by remote Session facts. @module */
import { composeBannerLines, shortenHome } from '@ephemeral-ai/mayfly/banner'
import { MAYFLY_VERSION } from '@ephemeral-ai/mayfly/banner-content'
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
    const rows = composeBannerLines({
      colors: this.options.colors?.() ?? this.colors,
      strong: text => components.strong(text),
      truncate: (text, target) => components.truncateToWidth(text, target, '…'),
      visibleWidth: text => components.visibleWidth(text),
      ascii: components.presentation?.glyphs === 'ascii',
    }, {
      version: MAYFLY_VERSION,
      model: current.model ?? 'default',
      provider: current.provider ?? 'default',
      cwd: shortenHome(current.cwd || this.options.directory?.() || 'unknown', this.options.home?.() ?? ''),
    }, width, components.presentation?.reducedMotion === true ? undefined : this.options.flyInAt?.())
    return ['', ...rows, '']
  }
}
