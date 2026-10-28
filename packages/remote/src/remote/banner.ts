/**
 * Mayfly welcome banner projected from the selected remote Session.
 * @module @ephemeral-ai/mayfly/remote/banner
 */

import { composeBannerLines } from '@ephemeral-ai/mayfly/banner'
import { MAYFLY_VERSION } from '@ephemeral-ai/mayfly/banner-content'
import type { MayflyComponent, MayflyComponents, MayflySemanticColors } from '@ephemeral-ai/mayfly/core'
import type { RemotePresentationFacts } from '../transcript/remote-model.ts'

/** Width-safe remote banner; all mutable facts come from the current Session snapshot. */
export class RemoteBannerComponent implements MayflyComponent {
  constructor(
    private readonly colors: MayflySemanticColors,
    private readonly components: MayflyComponents,
    private readonly facts: () => RemotePresentationFacts,
  ) {}

  render(width: number): string[] {
    const current = this.facts()
    return composeBannerLines({
      colors: this.colors,
      strong: text => this.components.strong(text),
      truncate: (text, target) => this.components.truncateToWidth(text, target),
      visibleWidth: text => this.components.visibleWidth(text),
    }, {
      version: MAYFLY_VERSION,
      model: current.model ?? 'default',
      provider: current.provider ?? 'default',
      cwd: current.cwd || 'unknown',
    }, width)
  }

  invalidate(): void {}
}
