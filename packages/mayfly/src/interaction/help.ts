/**
 * `/help` domain rows adapted onto the shared read-only information panel.
 * @module @ephemeral-ai/mayfly/interaction/help
 */

import type { MayflyTone } from '@ephemeral-ai/mayfly-ui'
import type { MayflyComponents, MayflyFocusable, MayflyKeymap, MayflyTheme } from '../core/index.ts'
import { interpolateLocaleMessage, type MayflyTranslate } from '../frontend/index.ts'
import { InfoPanel, type InfoSection, type InfoStyle } from './info-panel.ts'

/** One help entry. */
export interface HelpRow {
  readonly label: string
  readonly description: string
}

/** One headed group of help entries. */
export interface HelpSection {
  readonly heading: string
  readonly rows: readonly HelpRow[]
  readonly labelTone?: MayflyTone
}

/** Construction options for {@link HelpPanel}. */
export interface HelpPanelOptions {
  readonly theme: MayflyTheme
  readonly components: MayflyComponents
  readonly keymap: MayflyKeymap
  readonly sections: readonly HelpSection[] | (() => readonly HelpSection[])
  readonly t?: MayflyTranslate
  readonly onClose: () => void
  readonly maxVisible?: number
}

function infoStyle(tone: MayflyTone | undefined): InfoStyle {
  switch (tone) {
    case 'accent':
    case 'primary': return 'accent'
    case 'success': return 'success'
    case 'warning': return 'warning'
    case 'danger': return 'error'
    case 'muted': return 'muted'
    default: return 'text'
  }
}

/** Read-only help panel sharing InfoPanel's scroll, footer, and close logic. */
export class HelpPanel implements MayflyFocusable {
  private readonly panel: InfoPanel

  constructor(private readonly options: HelpPanelOptions) {
    const t = options.t ?? interpolateLocaleMessage
    this.panel = new InfoPanel({
      theme: options.theme,
      components: options.components,
      keymap: options.keymap,
      title: () => t('help'),
      sections: () => this.sections(t),
      onClose: options.onClose,
      ...(options.maxVisible === undefined ? {} : { maxVisible: options.maxVisible }),
      showingLabel: (start, end, total) => t('showing {start}-{end} of {total} · ', { start, end, total }).replace(/ · $/u, ''),
    })
  }

  get focused(): boolean { return this.panel.focused }
  set focused(value: boolean) { this.panel.focused = value }
  handleInput(data: string): void { this.panel.handleInput(data) }
  invalidate(): void { this.panel.invalidate() }
  render(width: number): string[] { return this.panel.render(width) }
  currentNode() { return this.panel.currentNode() }

  private sections(t: MayflyTranslate): InfoSection[] {
    const sections = typeof this.options.sections === 'function' ? this.options.sections() : this.options.sections
    return sections.map(section => ({
      heading: t(section.heading),
      rows: section.rows.map(row => ({
        label: row.label,
        labelStyle: infoStyle(section.labelTone),
        labelStrong: true,
        segments: [{ text: t(row.description), style: 'muted' }],
      })),
    }))
  }
}
