/** Renderer-neutral `/help` document built from live commands and key actions.
 * @module @ephemeral-ai/mayfly/interaction/help
 */
import { ui, type MayflyInlineSpan, type MayflyTone, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { interpolateLocaleMessage, type MayflyTranslate } from '../frontend/index.ts'

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

/** Build the complete scrollable Help surface without renderer state. */
export function helpNode(
  sections: readonly HelpSection[],
  t: MayflyTranslate = interpolateLocaleMessage,
): MayflyUiNode {
  const spans: MayflyInlineSpan[] = []
  for (const [sectionIndex, section] of sections.entries()) {
    spans.push({ text: `${sectionIndex === 0 ? '' : '\n\n'}${t(section.heading)}`, tone: 'accent', styles: ['strong'] })
    for (const row of section.rows) {
      spans.push({ text: `\n${row.label}`, tone: section.labelTone ?? 'muted', styles: ['strong'] })
      spans.push({ text: `  ${t(row.description)}`, tone: 'muted' })
    }
  }
  return ui.surface({
    title: t('help'),
    chrome: 'overlay',
    padding: 1,
    child: ui.stack.column([
      ui.child(ui.scroll(ui.richText(spans), { id: 'help-document', scrollbar: true }), { basis: 0, grow: 1, minSize: 1 }),
      ui.actions({ id: 'help-actions', items: [{ id: 'close', label: t('Close'), dismiss: true }] }),
    ]),
  })
}
