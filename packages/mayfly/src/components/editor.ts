/**
 * The editor's frame: a rounded surface with the conversation title in its top-right corner around the prompt, whose
 * symbol and buffer the host editor supplies. Shell mode shows as the `!` symbol in the accent tone and the accent
 * border on every row, never as text; a prompt that does not hold keyboard focus is parked, its frame muted. A title
 * too long for the rule keeps its start and ends in `…`; one that has no room is dropped. A pure function of facts:
 * the title arrives sanitized and final.
 *
 * @module components/editor
 */

import { ui, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

/** The facts of the editor's frame. */
export interface EditorFacts {
  /** The conversation's title, one line, final; none while it has none. */
  readonly title?: string
  /** The buffer is a shell command: the symbol is `!` and the border accent. */
  readonly shell: boolean
  /** Keyboard focus is elsewhere (the conversation or a bar): the frame is muted. */
  readonly parked?: boolean
}

/**
 * The editor's node: the frame and the prompt row it surrounds.
 * @param facts - the title, the mode, and whether the prompt is parked.
 * @returns the surface node; its one `prompt` is the face of the host editor.
 */
export function Editor(facts: EditorFacts): MayflyUiNode {
  const border = facts.parked === true ? 'muted' : facts.shell ? 'accent' : undefined
  return ui.surface({
    ...facts.title === undefined ? {} : { title: facts.title },
    titleAlign: 'right',
    titleCut: 'end',
    chrome: 'surface',
    hint: 'completions',
    ...border === undefined ? {} : { border },
    child: ui.prompt({
      id: 'prompt',
      symbol: facts.shell ? '! ' : '> ',
      ...facts.shell ? { symbolTone: 'accent' as const } : {},
    }),
  })
}
