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

/**
 * The logo's brand color gradient, one hex per row: near-white at the top,
 * through the hero's brand violet at the waist, to a deep violet at the
 * bottom. Each entry maps to the same-index {@link LOGO_ART} row, so the
 * mark reads as one sweeping gradient down its body.
 */
export const LOGO_GRADIENT: readonly string[] = [
  '#F5F5F7',
  '#E9E5F6',
  '#DBD3F0',
  '#C9BEEA',
  '#B2A1EC',
  '#9A86E6',
  '#8371D6',
  '#6C5BBF',
]
