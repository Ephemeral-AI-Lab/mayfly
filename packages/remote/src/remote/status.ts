/**
 * Session-facts footer for the independent remote Frontend.
 * @module @ephemeral-ai/mayfly/remote/status
 */

import { shortenCwd } from '@ephemeral-ai/mayfly/status-cwd'
import { contextPercent, formatTokens } from '@ephemeral-ai/mayfly/status-context'
import type { MayflyComponent, MayflyComponents, MayflySemanticColors } from '@ephemeral-ai/mayfly/core'
import type { RemotePresentationFacts } from '../transcript/remote-model.ts'

/** Two-band model/cwd/title/context footer with no transient command state. */
export class RemoteStatusComponent implements MayflyComponent {
  constructor(
    private readonly components: MayflyComponents,
    private readonly colors: MayflySemanticColors,
    private readonly facts: () => RemotePresentationFacts,
  ) {}

  render(width: number): string[] {
    const current = this.facts()
    const model = current.ref === undefined ? '' : current.model ?? 'default'
    const cwd = shortenCwd(current.cwd, '')
    const left = [
      ...(model === '' ? [] : [model]),
      ...(cwd === '' ? [] : [this.colors.muted(cwd)]),
    ].join('  ')
    const title = current.title === undefined ? '' : this.colors.muted(current.title)
    const context = current.contextTokens <= 0
      ? ''
      : current.contextWindow === undefined
        ? `ctx ${formatTokens(current.contextTokens)}`
        : `context: ${String(contextPercent(current.contextTokens, current.contextWindow))}% (${formatTokens(current.contextTokens)}/${formatTokens(current.contextWindow)})`
    return [
      ...(left === '' && title === '' ? [] : [this.align(left, title, width)]),
      ...(context === '' ? [] : [this.align('', context, width)]),
    ]
  }

  invalidate(): void {}

  private align(left: string, right: string, width: number): string {
    if (width <= 0) return ''
    const leftText = this.components.truncateToWidth(left, width)
    const leftWidth = this.components.visibleWidth(leftText)
    const budget = right === '' ? 0 : Math.max(0, width - leftWidth - (leftText === '' ? 0 : 2))
    const rightText = budget <= 0 ? '' : this.components.truncateToWidth(right, budget)
    const rightWidth = this.components.visibleWidth(rightText)
    const gap = Math.max(leftText === '' || rightText === '' ? 0 : 2, width - leftWidth - rightWidth)
    return this.components.truncateToWidth(`${leftText}${' '.repeat(gap)}${rightText}`, width)
  }
}
