/** Immutable terminal furniture and animation vocabulary, owned by core.
 * @module @ephemeral-ai/mayfly/core/glyphs
 */
export const BRAILLE_SPINNER_FRAMES = Object.freeze(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'])
export const MOON_SPINNER_FRAMES = Object.freeze(['··', '·≈', '≈≈', '≈·'])
export const ASCII_FRAMES = Object.freeze(['-', '\\', '|', '/'])
const ASCII: Readonly<Record<string, string>> = Object.freeze({
  '╭': '+', '╮': '+', '╰': '+', '╯': '+', '┌': '+', '┐': '+', '└': '+', '┘': '+',
  '├': '+', '┤': '+', '─': '-', '│': '|', '▸': '>', '▾': 'v', '→': '>', '✓': '+', '✗': 'x',
  '✻': '*', '●': '*', '‹': '<', '›': '>', '█': '#', '░': '.',
})
/** Convert only renderer-generated furniture, never user content. */
export function furniture(text: string, ascii: boolean): string {
  return ascii ? [...text].map(char => ASCII[char] ?? char).join('') : text
}

export const BRAILLE_SPINNER_INTERVAL_MS = 80
export const MOON_SPINNER_INTERVAL_MS = 120

export function treeBranch(last: boolean, ascii: boolean): string { return furniture(last ? '└─' : '├─', ascii) }
export function treeContinuation(last: boolean, ascii: boolean): string { return last ? '   ' : furniture('│  ', ascii) }
