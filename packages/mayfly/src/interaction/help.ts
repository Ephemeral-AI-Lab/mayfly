/** Renderer-neutral `/help` document built from live commands and key actions.
 * @module @ephemeral-ai/mayfly/interaction/help
 */
import { panel, ui, type MayflyInlineSpan, type MayflyTone, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { interpolateLocaleMessage, type MayflyTranslate } from '../frontend/locale.ts'

/** One help entry. */
interface HelpRow {
  readonly label: string
  readonly description: string
}

/** One headed group of help entries. */
export interface HelpSection {
  readonly heading: string
  readonly rows: readonly HelpRow[]
  readonly labelTone?: MayflyTone
}

// Stay inside the wire collection budget without splitting a styled help row.
const MAX_HELP_SPANS = 200

/** Build the complete scrollable Help surface without renderer state. */
export function helpNode(
  sections: readonly HelpSection[],
  t: MayflyTranslate = interpolateLocaleMessage,
): MayflyUiNode {
  const documents: MayflyUiNode[] = []
  let spans: MayflyInlineSpan[] = []
  const appendLine = (first: MayflyInlineSpan, ...rest: MayflyInlineSpan[]): void => {
    if (spans.length + 1 + rest.length > MAX_HELP_SPANS) {
      documents.push(ui.richText(spans))
      // A column child already starts a new row. Keep any second newline
      // before a section heading so the original blank separator survives.
      spans = [{ ...first, text: first.text.slice(1) }, ...rest]
    } else spans.push(first, ...rest)
  }
  for (const [sectionIndex, section] of sections.entries()) {
    appendLine({ text: `${sectionIndex === 0 ? '' : '\n\n'}${t(section.heading)}`, tone: 'accent', styles: ['strong'] })
    for (const row of section.rows) {
      appendLine(
        { text: `\n${row.label}`, tone: section.labelTone ?? 'muted', styles: ['strong'] },
        { text: `  ${t(row.description)}`, tone: 'muted' },
      )
    }
  }
  documents.push(ui.richText(spans))
  const document = documents.length === 1 ? documents[0]! : ui.stack.column(documents)
  return panel({
    title: t('Help'),
    escapeLabel: 'back',
    body: ui.stack.column([
      ui.child(ui.scroll(document, { id: 'help-document', scrollbar: true }), { basis: 0, grow: 1, minSize: 1 }),
    ]),
  })
}
