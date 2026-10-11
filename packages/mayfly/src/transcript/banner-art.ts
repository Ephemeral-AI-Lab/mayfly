/**
 * The welcome banner's logo — the Mayfly mark in braille block art, eight
 * rows tall, rendered frameless to the left of the status column. This
 * module stays the logo's single home; every consumer imports the rows from
 * here and never hardcodes a copy.
 *
 * Rows are written left-padded to a uniform width so the right-hand status
 * text lands on one aligned column whatever the mark's silhouette.
 *
 * @module @ephemeral-ai/mayfly/transcript/banner-art
 */

/** The logo's uniform column width — every row is padded to this. */
export const LOGO_COLS = 23

/**
 * The Mayfly mark: eight rows of braille block art, each padded to
 * {@link LOGO_COLS} columns. The braille-blank margins are part of the
 * mark's silhouette, so the rows read flush against the status column.
 */
export const LOGO_ART: readonly string[] = [
  '⠱⣦⣄⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣠⣴⠎'.padEnd(LOGO_COLS),
  '⠀⠙⢿⣿⣿⣷⣶⣤⣀⣀⣴⣶⣦⣀⣀⣤⣶⣾⣿⣿⡿⠋⠀'.padEnd(LOGO_COLS),
  '⠀⠀⠀⠈⠻⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠟⠁⠀⠀⠀'.padEnd(LOGO_COLS),
  '⠀⠀⠀⠀⠀⠀⠀⠉⠉⠁⢸⣿⡇⠈⠉⠉⠀⠀⠀⠀⠀⠀⠀'.padEnd(LOGO_COLS),
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀'.padEnd(LOGO_COLS),
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⣿⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀'.padEnd(LOGO_COLS),
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣿⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀'.padEnd(LOGO_COLS),
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⡠⠊⠀⠑⢄⠀⠀⠀⠀⠀⠀⠀⠀⠀'.padEnd(LOGO_COLS),
]

/** The logo's row count — the status column's vertical anchor. */
export const LOGO_ROWS = LOGO_ART.length
