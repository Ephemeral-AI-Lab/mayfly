/** Parse the `--keys` list of the workbench into the byte strings a terminal would send. @module script/workbench/keys */

const NAMED = new Map([
  ['enter', '\r'],
  ['esc', '\u001b'],
  ['tab', '\t'],
  ['shift+tab', '\u001b[Z'],
  ['backspace', '\u007f'],
  ['delete', '\u001b[3~'],
  ['space', ' '],
  ['up', '\u001b[A'],
  ['down', '\u001b[B'],
  ['right', '\u001b[C'],
  ['left', '\u001b[D'],
  ['home', '\u001b[H'],
  ['end', '\u001b[F'],
  ['pageup', '\u001b[5~'],
  ['pagedown', '\u001b[6~'],
])

/**
 * One token of a key list. A name from the table, `ctrl+<letter>`, `alt+<char>`, or literal text.
 * @param token - the token as typed after `--keys`.
 * @returns the bytes to send.
 */
export function keyBytes(token) {
  const named = NAMED.get(token.toLowerCase())
  if (named !== undefined) return named
  const ctrl = /^ctrl\+([a-z])$/iu.exec(token)
  if (ctrl !== null) return String.fromCharCode(ctrl[1].toLowerCase().charCodeAt(0) - 96)
  const alt = /^alt\+(.)$/iu.exec(token)
  if (alt !== null) return `\u001b${alt[1]}`
  return token
}

/**
 * Split a comma-separated key list. Write a literal comma as `comma`.
 * @param spec - the `--keys` value, or undefined for none.
 * @returns one byte string per token, in order.
 */
export function parseKeys(spec) {
  if (spec === undefined || spec === '') return []
  return spec.split(',').map(token => (token === 'comma' ? ',' : keyBytes(token)))
}
