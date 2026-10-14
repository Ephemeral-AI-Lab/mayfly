/**
 * What a terminal sends: key names as the legacy encoding a terminal without the kitty protocol uses (the encoding the
 * scenario terminals negotiate), and mouse events as SGR reports (`?1006`), the only mouse encoding the product enables.
 * @module script/scenarios/input
 */

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
  ['ctrl+down', '\u001b[1;5B'],
  ['ctrl+up', '\u001b[1;5A'],
  ['alt+up', '\u001b[1;3A'],
  ['alt+down', '\u001b[1;3B'],
  ['f4', '\u001bOS'],
  ['f5', '\u001b[15~'],
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

/** SGR button codes. */
const BUTTONS = { left: 0, middle: 1, right: 2 }
const WHEEL = { up: 64, down: 65, left: 66, right: 67 }

/**
 * One SGR mouse report.
 * @param {object} event
 * @param {'press' | 'release' | 'drag' | 'wheel'} event.type
 * @param {number} event.row - zero-based screen row.
 * @param {number} event.col - zero-based screen column.
 * @param {'left' | 'middle' | 'right'} [event.button] - for press, release, and drag (default left).
 * @param {'up' | 'down' | 'left' | 'right'} [event.direction] - for wheel.
 * @param {{ shift?: boolean, alt?: boolean, ctrl?: boolean }} [event.modifiers]
 * @returns {string}
 */
export function mouseReport({ type, row, col, button = 'left', direction = 'up', modifiers = {} }) {
  let code = type === 'wheel' ? WHEEL[direction] : BUTTONS[button]
  if (code === undefined) throw new Error(`unknown mouse ${type === 'wheel' ? 'direction' : 'button'}`)
  if (type === 'drag') code += 32
  if (modifiers.shift === true) code += 4
  if (modifiers.alt === true) code += 8
  if (modifiers.ctrl === true) code += 16
  return `\u001b[<${String(code)};${String(col + 1)};${String(row + 1)}${type === 'release' ? 'm' : 'M'}`
}

/** A click: a press and a release at one cell. */
export const click = (row, col, button = 'left') => mouseReport({ type: 'press', row, col, button }) + mouseReport({ type: 'release', row, col, button })
