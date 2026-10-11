/**
 * The one terminal-escape grammar every text boundary shares: admission (`ui-validator.ts`), paint-time
 * sanitization (`plugin-view.ts`), and the painted-text scanner (`content-rows.ts`) all derive from
 * `TERMINAL_SEQUENCE`, so a sequence one path recognizes is a sequence every path recognizes. An OSC or DCS opener
 * can only match when a terminator follows it, so a regex that scans on to the end of the text from every opener
 * without one costs quadratic time on a truncated or binary log. The text is split after its last terminator:
 * the head keeps the full pattern and every opener in it finds a terminator, the tail uses a pattern without
 * string sequences, and the output equals the unsplit pattern's.
 *
 * @module @ephemeral-ai/mayfly/core/escape-sequences
 */

/**
 * One terminal sequence: an OSC string (`ESC ]` or C1 `\x9d`) or a DCS/SOS/PM/APC string (`ESC P`, `ESC X`,
 * `ESC ^`, `ESC _`, or C1 `\x90`/`\x98`/`\x9e`/`\x9f`) through its BEL, `ESC \`, or ST (`\x9c`) terminator; a CSI
 * (`ESC [` or C1 `\x9b`) through its final byte; or `ESC` plus one following character.
 */
const TERMINAL_SEQUENCE = /(?:(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c)|(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x07|\x1b\\|\x9c)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b.)/gu

/** `TERMINAL_SEQUENCE` minus its string arms: past the last terminator no string sequence can complete. */
const TERMINAL_TAIL = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b./gu

/** The same grammar anchored at a position: the sequence that starts exactly at `lastIndex`, if one does. */
const TERMINAL_SEQUENCE_AT = new RegExp(TERMINAL_SEQUENCE.source, 'uy')

/** The controls a terminal would act on: C0 minus LF/TAB, DEL through C1, noncharacters, and the focus sentinel. */
const UNSAFE_CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f\uf8ff\ufdd0-\ufdef]/gu

/** The index after the last string terminator (BEL, ESC `\`, or ST `\x9c`), or 0 when there is none. */
function terminatedEnd(text: string): number {
  const escape = text.lastIndexOf('\x1b\\')
  return Math.max(text.lastIndexOf('\x07') + 1, escape < 0 ? 0 : escape + 2, text.lastIndexOf('\x9c') + 1)
}

/** `text` with every terminal escape sequence removed, in time linear in its length. */
export function stripEscapeSequences(text: string): string {
  const end = terminatedEnd(text)
  if (end === 0) return text.replace(TERMINAL_TAIL, '')
  return end === text.length ? text.replace(TERMINAL_SEQUENCE, '') : text.slice(0, end).replace(TERMINAL_SEQUENCE, '') + text.slice(end).replace(TERMINAL_TAIL, '')
}

/** `text` made safe to paint: the escape grammar removed first, then every control a terminal would act on. */
export function stripTerminalText(text: string): string {
  return stripEscapeSequences(text).replace(UNSAFE_CONTROLS, '')
}

/** The whole escape sequence starting at `at` in painted `text`, or `undefined` when none opens there. */
export function terminalSequenceAt(text: string, at: number): string | undefined {
  TERMINAL_SEQUENCE_AT.lastIndex = at
  return TERMINAL_SEQUENCE_AT.exec(text)?.[0]
}
