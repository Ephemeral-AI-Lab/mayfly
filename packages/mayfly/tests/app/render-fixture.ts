/** Published renderer primitives for standalone Frontend tests. @module */
import { MayflyComponentsService } from '../../src/core/components.ts'
import { visibleWidth } from '@earendil-works/pi-tui'
import type { MayflyComponents, MayflySemanticColors } from '../../src/core/types.ts'

const identity = (text: string): string => text

/** A full semantic palette without styling. */
export function plainColors(): MayflySemanticColors {
  return {
    text: identity, textStrong: identity, muted: identity, textMuted: identity,
    accent: identity, primary: identity, border: identity,
    success: identity, error: identity, warning: identity, selectedBg: identity,
    roleUser: identity, shellMode: identity,
    mdHeading: identity, mdLink: identity, mdLinkUrl: identity, mdCode: identity,
    mdCodeBlock: identity, mdCodeBlockBorder: identity, mdQuote: identity,
    mdQuoteBorder: identity, mdHr: identity, mdListBullet: identity,
    diffAdded: identity, diffRemoved: identity, diffMeta: identity,
    diffAddedBg: identity, diffRemovedBg: identity,
    modelHighlight: identity, logoInks: [identity, identity, identity, identity, identity],
  }
}

/** Width and wrap methods use the visual dependency's actual renderer implementation. */
export function fakeMayflyComponents(): MayflyComponents {
  const primitives = MayflyComponentsService.prototype
  return {
    strong: text => `\x1b[1m${text}\x1b[22m`, italic: text => `\x1b[3m${text}\x1b[23m`, strike: text => `\x1b[9m${text}\x1b[29m`,
    visibleWidth,
    truncateToWidth: (text, width, ellipsis) => primitives.truncateToWidth(text, width, ellipsis),
    wrapText: (text, width) => primitives.wrapText(text, width),
    topRule: (width, options) => primitives.topRule(width, options),
    createMarkdown(options = {}) {
      let text = options.text ?? ''
      return { setText(next) { text = next }, render: width => primitives.wrapText(text, width), invalidate() {} }
    },
    createEditor() { throw new Error('Editor creation is outside this fixture') },
    createImage(options) { return { render: () => [`<image ${options.data.length}B>`], invalidate() {} } },
    createSelectList() { throw new Error('Select list creation is outside this fixture') },
    imageProtocol: () => false, imageDimensions: () => undefined,
    fuzzyMatch() { throw new Error('Fuzzy matching is outside this fixture') },
    fuzzyFilter() { throw new Error('Fuzzy filtering is outside this fixture') },
  }
}

/** Compare terminal cells after removing invisible ANSI styles. */
export function plain(rows: readonly string[]): string[] {
  return rows.map(row => row.replace(/\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*\x07|\[[0-?]*[ -/]*[@-~])/gu, ''))
}
