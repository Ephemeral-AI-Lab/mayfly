/**
 * The key walks the design scenes replay against the real renderer. A walk starts with a NUL step (frame 0, before any
 * key) and then sends one key per step; a number is a clock step in milliseconds. The keys a scene's demo reads
 * (`Ctrl+N` for the next page, `Ctrl+W` for a narrower frame, a scene's own letters) are interpreted by its spec. The
 * walks came from the prototype's footers (`docs/design/prototypes/ui-preview.mjs`); each scene keeps the walks its
 * spec plays.
 */

export const NEXT = '\x0e'
export const NARROW = '\x17'
export const UP = '\x1b[A'
export const DOWN = '\x1b[B'
export const RIGHT = '\x1b[C'
export const LEFT = '\x1b[D'
export const ALT_RIGHT = '\x1b[1;3C'
export const ALT_DOWN = '\x1b[1;3B'
export const ENTER = '\r'
export const ESC = '\x1b'
export const DELETE = '\x1b[3~'

export type Step = string | number

export interface Walk {
  readonly scene: number
  /** The frame directory, `<nn>-<scene>`. */
  readonly dir: string
  readonly name: string
  readonly steps: readonly Step[]
}

const times = <T>(count: number, step: T): T[] => Array<T>(count).fill(step)

const DIRS: Readonly<Record<number, string>> = {
  2: '02-actions', 3: '03-fields-and-forms', 4: '04-replies-and-validation', 5: '05-lists', 6: '06-tabs-wizards-rails',
  7: '07-surfaces-and-scroll', 9: '09-feedback-and-progress', 10: '10-layout', 11: '11-patterns', 12: '12-a-downstream-plugin',
  13: '13-status-area', 15: '15-editor',
}

/** The walks of each scene after its first frame, as `[name, steps]`; `initial` (no key) is every scene's first walk. */
const WALKS: Readonly<Record<number, readonly (readonly [string, readonly Step[]])[]>> = {
  2: [['narrow', ['w']], ['copy', ['c']], ['copy-link', ['\x19']], ['move', times(3, DOWN)]],
  3: [['move', times(6, DOWN)], ['edit', [ENTER]], ['reset', [DELETE]], ['discard', [ENTER, 'x', ESC]]],
  4: [['fill', ['x', ENTER]], ['focus', [DOWN, ENTER]]],
  5: [['pages', times(6, NEXT)], ['page-6-narrow', [...times(5, NEXT), NARROW]], ['move', times(4, DOWN)], ['open', [ENTER]], ['filter', ['/', 'm']]],
  6: [
    ['pages', times(3, NEXT)], ['page-4-narrow', [...times(3, NEXT), NARROW]], ['alt-tabs', [ALT_RIGHT, ALT_RIGHT]], ['arrows', [RIGHT, RIGHT, LEFT]],
    ['rail-move', [NEXT, NEXT, DOWN, DOWN, UP]], ['rail-enter', [NEXT, NEXT, RIGHT, RIGHT, LEFT, LEFT, LEFT]],
  ],
  7: [['scroll', [NEXT, ...times(6, 1500), ...times(3, UP)]], ['end', [NEXT, ...times(4, 1500), '\x1b[F']], ['expand', [NEXT, '\x05']]],
  9: [['motion', times(12, 100)]],
  10: [['wider', times(4, RIGHT)], ['narrower', times(6, LEFT)], ['height', ['h']], ['overflow', ['o']]],
  11: [['pages', times(3, NEXT)], ['page-2', [NEXT]], ['move', times(3, DOWN)]],
  12: [['move', times(3, DOWN)], ['enter', [ENTER]]],
  13: [['views', [ALT_DOWN]], ['views-next', [ALT_DOWN, RIGHT, DOWN]], ['views-stop', [ALT_DOWN, 'x']], ['views-back', [ALT_DOWN, ESC]]],
  15: [
    ['type', ['h', 'i']], ['slash', ['/']], ['mention', ['@']], ['skill', ['#']], ['shell', ['!']], ['image', ['\x0b']], ['paste', ['\x16']],
    ['recall', [UP, UP, DOWN]], ['running', ['\x12']], ['conversation', ['\x0f']], ['narrow', [NARROW]], ['narrower', [NARROW, NARROW]],
  ],
}

/** Scenes whose spec plays only the walks listed, not `initial`. */
const NO_INITIAL = new Set([7, 9, 13])

/** The walks of a scene, in order. */
export function sceneWalks(scene: number): readonly Walk[] {
  const dir = DIRS[scene]
  if (dir === undefined) throw new Error(`scene ${String(scene)} has no walks`)
  const listed = [...NO_INITIAL.has(scene) ? [] : [['initial', []] as const], ...WALKS[scene] ?? []]
  return listed.map(([name, steps]) => ({ scene, dir, name, steps: ['\0', ...steps] }))
}

const KEY_NAMES: Readonly<Record<string, string>> = {
  '\0': 'start', [NEXT]: 'ctrl+n', [NARROW]: 'ctrl+w', [UP]: 'up', [DOWN]: 'down', [RIGHT]: 'right', [LEFT]: 'left',
  [ALT_RIGHT]: 'alt+right', [ALT_DOWN]: 'alt+down', [ENTER]: 'enter', [ESC]: 'esc', [DELETE]: 'delete', '\x1b[F': 'end',
}

/** A step as a frame label: a key's name, a printable key as itself, a control key as `ctrl+<letter>`, a clock step in ms. */
export function stepLabel(step: Step): string {
  if (typeof step === 'number') return `tick ${String(step)}ms`
  const named = KEY_NAMES[step]
  if (named !== undefined) return named
  if (step.length === 1 && step.charCodeAt(0) < 32) return `ctrl+${String.fromCharCode(step.charCodeAt(0) + 96)}`
  return JSON.stringify(step).slice(1, -1)
}
