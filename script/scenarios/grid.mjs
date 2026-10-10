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
