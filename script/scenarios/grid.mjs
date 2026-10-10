/**
 * Cell grids: a terminal screen read from `@xterm/headless` as text rows plus run-length style runs, in the text form
 * goldens are stored and compared in. The design walk frames are grids of the real renderer under the probe palette;
 * the scenario runner (roadmap Phase 2b) stores its checkpoints the same way. @module script/scenarios/grid
 */

/**
 * @typedef {object} StyleRun
 * @property {number} from - first column of the run.
 * @property {number} to - last column of the run (inclusive).
 * @property {string} style - the non-default attributes, as in `fg:primary bg:#1e1e2e b i`.
 */

/**
 * @typedef {object} Grid
 * @property {number} cols - columns.
 * @property {readonly string[]} lines - one right-trimmed text row per screen row.
 * @property {readonly (readonly StyleRun[])[]} styles - the styled runs of each row.
 * @property {readonly [number, number] | null} cursor - the cursor as `[row, column]`, or null when it is hidden.
 */

/** The attribute flags a style names, in this order: bold, dim, italic, underline, strike, inverse, invisible, blink, overline. */
const FLAGS = [['b', 'isBold'], ['d', 'isDim'], ['i', 'isItalic'], ['u', 'isUnderline'], ['s', 'isStrikethrough'], ['r', 'isInverse'], ['h', 'isInvisible'], ['k', 'isBlink'], ['o', 'isOverline']]

const hex = rgb => `#${rgb.toString(16).padStart(6, '0')}`

/**
 * One color of a cell: palette colors are `p<n>`; a truecolor is named by `colorName`, or written as `#rrggbb`.
 * @returns {string | undefined} undefined for the default color.
 */
function colorOf(isDefault, isPalette, value, colorName) {
  if (isDefault) return undefined
  if (isPalette) return `p${String(value)}`
  return colorName?.(value) ?? hex(value)
}

/**
 * The style of one cell, or the empty string for a default cell.
 * @param {import('@xterm/headless').IBufferCell} cell
 * @param {(rgb: number) => string | undefined} [colorName]
 */
function styleOf(cell, colorName) {
  const parts = []
  const fg = colorOf(cell.isFgDefault(), cell.isFgPalette(), cell.getFgColor(), colorName)
  const bg = colorOf(cell.isBgDefault(), cell.isBgPalette(), cell.getBgColor(), colorName)
  if (fg !== undefined) parts.push(`fg:${fg}`)
  if (bg !== undefined) parts.push(`bg:${bg}`)
  for (const [flag, method] of FLAGS) if (cell[method]() !== 0) parts.push(flag)
  return parts.join(' ')
}

/**
 * Read the rows of a terminal's active buffer as a grid.
 * @param {import('@xterm/headless').Terminal} terminal - a terminal whose writes have been parsed.
 * @param {object} [options]
 * @param {number} [options.top] - first buffer row (default: the viewport's top).
 * @param {number} [options.height] - rows to read (default: the terminal's rows).
 * @param {readonly [number, number] | null} [options.cursor] - the cursor to record (default: none).
 * @param {(rgb: number) => string | undefined} [options.colorName] - a name for a truecolor, such as a palette token.
 * @returns {Grid}
 */
export function readGrid(terminal, { top = terminal.buffer.active.viewportY, height = terminal.rows, cursor = null, colorName } = {}) {
  const buffer = terminal.buffer.active
  const cell = buffer.getNullCell()
  const lines = []
  const styles = []
  for (let row = 0; row < height; row += 1) {
    const line = buffer.getLine(top + row)
    let text = ''
    const runs = []
    for (let col = 0; col < terminal.cols; col += 1) {
      line?.getCell(col, cell)
      const width = line === undefined ? 1 : cell.getWidth()
      // The second column of a wide character belongs to the first.
      if (width === 0) continue
      text += line === undefined || cell.getChars() === '' ? ' ' : cell.getChars()
      const style = line === undefined ? '' : styleOf(cell, colorName)
      const last = runs.at(-1)
      if (style === '') continue
      if (last !== undefined && last.style === style && last.to === col - 1) last.to = col + width - 1
      else runs.push({ from: col, to: col + width - 1, style })
    }
    lines.push(text.trimEnd())
    styles.push(runs)
  }
  return { cols: terminal.cols, lines, styles, cursor }
}

/**
 * Serialize a grid: a header with the size and the cursor, one `|`-prefixed text row per screen row, then the styled
 * runs of each row that has any (`<row>: <from>-<to> <style>; …`, a one-column run as `<from>`).
 * @param {Grid} grid
 * @returns {string}
 */
export function serializeGrid(grid) {
  const cursor = grid.cursor === null ? 'none' : `${String(grid.cursor[0])},${String(grid.cursor[1])}`
  const runs = grid.styles.flatMap((row, index) => row.length === 0
    ? []
    : [`${String(index)}: ${row.map(run => `${run.from === run.to ? String(run.from) : `${String(run.from)}-${String(run.to)}`} ${run.style}`).join('; ')}`])
  return [`grid ${String(grid.cols)}x${String(grid.lines.length)} cursor ${cursor}`, ...grid.lines.map(line => `|${line}`), 'styles', ...runs].join('\n')
}

/**
 * Read a serialized grid back.
 * @param {string} text - a grid as `serializeGrid` wrote it.
 * @returns {Grid}
 */
export function parseGrid(text) {
  const { header, rows, styles } = gridParts(text)
  const [, cols, cursor] = /^grid (\d+)x\d+ cursor (\S+)$/u.exec(header) ?? []
  if (cols === undefined) throw new Error(`not a grid: ${header}`)
  return {
    cols: Number(cols),
    lines: rows,
    styles: rows.map((_, index) => (styles.get(index) ?? '').split('; ').filter(Boolean).map((run) => {
      const [span, ...style] = run.split(' ')
      const [from, to = from] = span.split('-').map(Number)
      return { from, to, style: style.join(' ') }
    })),
    cursor: cursor === 'none' ? null : cursor.split(',').map(Number),
  }
}

const SGR_FLAGS = { b: 1, d: 2, i: 3, u: 4, s: 9, r: 7, h: 8, k: 5, o: 53 }
const sgrColor = (base, color) => color.startsWith('p')
  ? `${String(base)};5;${color.slice(1)}`
  : `${String(base)};2;${[1, 3, 5].map(at => String(Number.parseInt(color.slice(at, at + 2), 16))).join(';')}`

/**
 * The SGR sequence that sets a style of a grid (after a reset), so a grid can be written back into a terminal.
 * @param {string} style - a run's style, as in `fg:#9a86e6 bg:p236 b`.
 * @returns {string} the escape sequence; the empty string for the default style.
 */
export function styleSgr(style) {
  const params = style.split(' ').filter(Boolean).map((part) => {
    if (part.startsWith('fg:')) return sgrColor(38, part.slice(3))
    if (part.startsWith('bg:')) return sgrColor(48, part.slice(3))
    return String(SGR_FLAGS[part])
  })
  return params.length === 0 ? '' : `\u001b[${params.join(';')}m`
}

/** The parts of a serialized grid: its header, its text rows, and its style rows by row index. */
function gridParts(text) {
  const lines = text.replace(/\n$/u, '').split('\n')
  const stylesAt = lines.indexOf('styles')
  const rows = lines.slice(1, stylesAt < 0 ? undefined : stylesAt).map(line => line.slice(1))
  const styles = new Map((stylesAt < 0 ? [] : lines.slice(stylesAt + 1)).map(line => [Number(line.slice(0, line.indexOf(':'))), line.slice(line.indexOf(':') + 2)]))
  return { header: lines[0] ?? '', rows, styles }
}

/**
 * How two serialized grids differ, as reading lines: the header, then each row whose text or styles differ, with the
 * expected (`-`) and actual (`+`) values. Empty when they are the same.
 * @param {string} expected
 * @param {string} actual
 * @param {{ maxRows?: number }} [options] - rows to report at most (default 20).
 * @returns {string[]}
 */
export function diffGrids(expected, actual, { maxRows = 20 } = {}) {
  const left = gridParts(expected)
  const right = gridParts(actual)
  const out = []
  if (left.header !== right.header) out.push(`- ${left.header}`, `+ ${right.header}`)
  let reported = 0
  const rows = Math.max(left.rows.length, right.rows.length)
  for (let row = 0; row < rows; row += 1) {
    const textDiffers = left.rows[row] !== right.rows[row]
    const styleDiffers = (left.styles.get(row) ?? '') !== (right.styles.get(row) ?? '')
    if (!textDiffers && !styleDiffers) continue
    if (reported === maxRows) { out.push('… more rows differ'); break }
    reported += 1
    if (textDiffers) out.push(`row ${String(row)}`, `- |${left.rows[row] ?? ''}`, `+ |${right.rows[row] ?? ''}`)
    else out.push(`row ${String(row)} styles`, `- ${left.styles.get(row) ?? ''}`, `+ ${right.styles.get(row) ?? ''}`)
  }
  return out
}
