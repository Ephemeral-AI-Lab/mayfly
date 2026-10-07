/**
 * Arm delay (roadmap slice 1.8a): an overlay that opens unprompted sets `armMs` so a stray key typed into the editor
 * while it opens chooses, grants, and submits nothing. The gallery is a pane, so this group describes the field; a
 * plugin that opens a decision overlay sets it on the definition.
 *
 * @module @mayfly-example/ui-gallery/groups/arm-delay
 */
import { ui } from '@ephemeral-ai/mayfly-ui'

/** The definition fields a plugin sets for an overlay that opens unprompted. */
export const ARMED_DECISION = Object.freeze({ presentation: 'editor', capturing: true, armMs: 300 } as const)

/** Explains the arm window and shows the definition that asks for it. */
export function armDelayGroup() {
  return [
    ui.divider({ label: 'Arm delay' }),
    ui.text('An overlay that opens unprompted ignores every key but Esc for armMs after it takes focus; its hint row reads "… ready in a moment" until then.', { tone: 'muted' }),
    ui.fields([
      { label: 'presentation', value: [{ text: ARMED_DECISION.presentation }] },
      { label: 'capturing', value: [{ text: String(ARMED_DECISION.capturing) }] },
      { label: 'armMs', value: [{ text: `${String(ARMED_DECISION.armMs)} ms`, tone: 'accent' }] },
    ]),
  ]
}
