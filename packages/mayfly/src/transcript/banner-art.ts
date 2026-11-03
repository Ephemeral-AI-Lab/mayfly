/**
 * The welcome banner's mark — the Mayfly s10 mark from PR 22
 * (`docs/design/prototypes/logo-preview.mjs`): a squat body with slit eyes,
 * two antennae, and speed-line wings, as pixel rows that `core/quad-mark.ts`
 * draws in quadrant blocks, two pixels per cell across and down. 26 × 8 pixels
 * make 13 columns × 4 rows. This module stays the mark's single home; every
 * consumer imports the rows from here and never hardcodes a copy.
 *
 * Keys: `B` body, `T` antennae and tails (the body's ink), `W` wings, `.` none.
 * The eyes are holes left in the body.
 *
 * @module @ephemeral-ai/mayfly/transcript/banner-art
 */

import { liftWings } from '../core/quad-mark.ts'

/** The mark at rest. */
export const MARK_ROWS: readonly string[] = [
  '........T........T........',
  '.......T..........T.......',
  '......BBBBBBBBBBBBBB......',
  'WWWWW.BBB.BBBBBB.BBB.WWWWW',
  '......BBB.BBBBBB.BBB......',
  '..WWW.BBBBBBBBBBBBBB.WWW..',
  '.......BBBBBBBBBBBB.......',
  '.........T......T.........',
]

/** The mark with its wings up: the wing beat's second frame. */
export const MARK_BEAT: readonly string[] = liftWings(MARK_ROWS)
