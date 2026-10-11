/**
 * Linear stripping of terminal escape sequences from untrusted text. An OSC or DCS opener can only match when a
 * terminator follows it, so a regex that scans on to the end of the text from every opener without one costs
 * quadratic time on a truncated or binary log. The text is split after its last terminator: the head keeps the full
 * pattern and every opener in it finds a terminator, the tail uses a pattern without string sequences, and the
 * output equals the unsplit pattern's.
 *
 * @module @ephemeral-ai/mayfly/core/escape-sequences
 */

/** The index after the last string terminator (BEL, ESC `\`, and with `c1` also ST `\x9c`), or 0 when there is none. */
function terminatedEnd(text: string, c1: boolean): number {
  const escape = text.lastIndexOf('\x1b\\')
  return Math.max(text.lastIndexOf('\x07') + 1, escape < 0 ? 0 : escape + 2, c1 ? text.lastIndexOf('\x9c') + 1 : 0)
}

/**
 * `text` with every match of `whole` removed, where `tail` is `whole` without its string-sequence alternatives and
 * `c1` says whether ST (`\x9c`) terminates a string sequence.
 */
export function stripEscapeSequences(text: string, whole: RegExp, tail: RegExp, c1: boolean): string {
  const end = terminatedEnd(text, c1)
  if (end === 0) return text.replace(tail, '')
  return end === text.length ? text.replace(whole, '') : text.slice(0, end).replace(whole, '') + text.slice(end).replace(tail, '')
}
