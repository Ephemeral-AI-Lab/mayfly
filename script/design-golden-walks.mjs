/**
 * @module script/design-golden-walks
 *
 * The scenes of `docs/design/prototypes/ui-preview.mjs` and the key walks the golden capture replays against each.
 * A walk starts with a NUL key (it paints frame 0, because the prototype only paints on a key or a clock tick) and
 * then sends one key per step; a number is a clock step in milliseconds that runs one repaint tick. The `width` is
 * the scene's logical width during the walk: the prototype does not report it, and the parity helper needs it.
 *
 * This table is the first version, derived from each scene's footer and page count. A slice that reproduces a scene
 * with the real renderer extends the scene's walks with the states that slice covers.
 */

const NEXT = '\x0e'
const NARROW = '\x17'
const UP = '\x1b[A'
const DOWN = '\x1b[B'
const RIGHT = '\x1b[C'
const LEFT = '\x1b[D'
const ALT_RIGHT = '\x1b[1;3C'
const ALT_DOWN = '\x1b[1;3B'
const ALT_UP = '\x1b[1;3A'
const ENTER = '\r'
const ESC = '\x1b'
const DELETE = '\x1b[3~'
const TICKS = (count, ms = 100) => Array(count).fill(ms)
const times = (count, key) => Array(count).fill(key)

/** The scene names, in order; `design-golden.test.mjs` checks them against `ui-preview.mjs --list`. */
export const SCENES = [
  'Marks and tokens', 'Actions', 'Fields and forms', 'Replies and validation', 'Lists', 'Tabs, wizards, rails',
  'Surfaces and scroll', 'Content', 'Feedback and progress', 'Layout', 'Patterns', 'A downstream plugin',
  'Status area', 'Activity row', 'Editor', 'Notices and banners', 'Tool rows and edits', 'Conversation stream',
  'Prompt styles', 'Compaction', 'Approval, plan review, permission', 'Questions', '/model and /effort',
  '/sessions', '/settings', '/status', '/plugin marketplace', '/account', 'Onboarding', 'Command surfaces',
  '/trace', 'Keybindings',
]

/** Scenes with Ctrl+N pages, by scene number (the page counts were measured by cycling Ctrl+N). */
const PAGES = { 1: 6, 5: 7, 6: 4, 7: 3, 8: 7, 9: 4, 11: 4, 16: 2, 17: 5, 21: 4, 23: 2, 30: 6 }

/** Every key the scene's footer names, as `[name, steps, width]`. */
const EXTRA = {
  2: [['narrow', ['w'], 46], ['copy', ['c'], 78], ['copy-link', ['\x19'], 78], ['move', times(3, DOWN), 78]],
  3: [['move', times(6, DOWN), 96], ['edit', [ENTER], 96], ['reset', [DELETE], 96], ['discard', [ENTER, 'x', ESC], 96]],
  4: [['fill', ['x', ENTER], 96], ['focus', [DOWN, ENTER], 96]],
  5: [['page-6-narrow', [...times(5, NEXT), NARROW], 62], ['move', times(4, DOWN), 84], ['open', [ENTER], 84], ['filter', ['/', 'm'], 84]],
  6: [['page-4-narrow', [...times(3, NEXT), NARROW], 40], ['alt-tabs', [ALT_RIGHT, ALT_RIGHT], 78], ['arrows', [RIGHT, RIGHT, LEFT], 78]],
  7: [['scroll', [NEXT, ...TICKS(6, 1500), ...times(3, UP)], 76], ['end', [NEXT, ...TICKS(4, 1500), '\x1b[F'], 76], ['expand', [NEXT, '\x05'], 76]],
  8: [['highlight', [NEXT, NEXT, 'h'], 100], ['diff', times(3, NEXT).concat('d'), 100], ['diagram', [...times(6, NEXT), 'b'], 100]],
  9: [['motion', TICKS(12), 96]],
  10: [['wider', times(4, RIGHT), 96], ['narrower', times(6, LEFT), 96], ['height', ['h'], 96], ['overflow', ['o'], 96]],
  11: [['page-2', [NEXT], 100], ['move', times(3, DOWN), 80]],
  12: [['move', times(3, DOWN), 90], ['enter', [ENTER], 90]],
  13: [
    ['plan', ['\x10'], 100], ['yolo', ['\x19'], 100], ['shell', ['\x14'], 100], ['balance', ['\x02'], 100],
    ['goal', ['\x07'], 100], ['narrow', [NARROW], 72], ['narrower', [NARROW, NARROW], 52], ['narrowest', times(3, NARROW), 36],
    ['views', [ALT_DOWN], 100], ['views-next', [ALT_DOWN, RIGHT, DOWN], 100], ['views-stop', [ALT_DOWN, 'x'], 100],
    ['views-back', [ALT_DOWN, ESC], 100],
  ],
  14: [['phases', times(6, 'v'), 96], ['phases-back', times(6, 'V'), 96], ['motion', TICKS(12), 96]],
  15: [
    ['type', ['h', 'i'], 96], ['slash', ['/'], 96], ['mention', ['@'], 96], ['skill', ['#'], 96], ['shell', ['!'], 96],
    ['image', ['\x0b'], 96], ['paste', ['\x16'], 96], ['recall', [UP, UP, DOWN], 96], ['running', ['\x12'], 96],
    ['conversation', ['\x0f'], 96], ['narrow', [NARROW], 60], ['narrower', [NARROW, NARROW], 40],
  ],
  16: [['toast', [NEXT, 'u'], 100]],
  18: [['select', [ALT_UP, UP], 96], ['expand', [ALT_UP, ENTER], 96], ['search', ['\x06'], 96], ['level', ['\x0f'], 96], ['running', ['\x12'], 96], ['request', ['\x04'], 96]],
  19: [...times(7, 0).map((_, i) => [`style-${i + 1}`, [String(i + 1)], 96]), ['level', ['l'], 96], ['mono', ['m'], 96], ['narrow', ['w'], 64], ['narrower', ['w', 'w'], 44]],
  20: [['failed', ['f', ...TICKS(3, 2000)], 96], ['motion', TICKS(20, 500), 96]],
  21: [['variant', ['\x14'], 78], ['stray', ['\x18'], 78], ['next-card', [NEXT], 78], ['digit', ['1'], 78], ['reject', [ESC], 78], ['arm', [100, 300], 78]],
  22: [['digit', ['1'], 78], ['move', [RIGHT, RIGHT], 78], ['other', times(4, DOWN), 78], ['review', times(3, RIGHT), 78]],
  23: [['narrow', [NARROW], 62], ['thinking', [RIGHT, RIGHT], 84], ['default', [DELETE], 84], ['filter', ['/', 'd'], 84]],
  24: [['move', times(3, DOWN), 96], ['sessions', [RIGHT], 96], ['filter', ['/', 'u'], 96], ['copy', [RIGHT, 'c'], 96], ['new', ['n'], 96]],
  25: [['move', times(3, DOWN), 84], ['form', [RIGHT], 84], ['back', [RIGHT, LEFT], 84]],
  26: [['tabs', [RIGHT, RIGHT, RIGHT], 84], ['balance', ['b'], 84], ['refresh', ['r'], 84], ['top-up', ['o'], 84]],
  27: [['tabs', [RIGHT, RIGHT], 112], ['narrow', [NARROW], 84], ['filter', ['/', 'a'], 112], ['install', ['i'], 112], ['offline', ['\x0f'], 112]],
  28: [['states', times(4, 's'), 84], ['sign-in', [ENTER, ...TICKS(5, 1000)], 84], ['copy-link', ['\x19'], 84], ['sign-out', ['x'], 84]],
  29: [['steps', times(4, ENTER), 84], ['back', [ENTER, ESC], 84], ['change', [RIGHT, LEFT], 84], ['digit', ['2'], 84]],
  30: [['move', times(2, DOWN), 84]],
  31: [['move', times(3, DOWN), 112], ['filter', ['/', 'e'], 112], ['failures', ['f'], 112], ['expand', ['\x05'], 112]],
  32: [['move', times(3, DOWN), 96], ['capture', [ENTER, 'x'], 96], ['cancel', [ENTER, ESC], 96], ['restore', [DELETE], 96], ['filter', ['/', 'u'], 96]],
}

/** The scenes' default logical width, used by walks that do not change it. */
const WIDTH = {
  1: 100, 2: 78, 3: 96, 4: 96, 5: 84, 6: 78, 7: 76, 8: 100, 9: 96, 10: 96, 11: 80, 12: 90, 13: 100, 14: 96,
  15: 96, 16: 100, 17: 96, 18: 96, 19: 96, 20: 96, 21: 78, 22: 78, 23: 84, 24: 96, 25: 84, 26: 84, 27: 112,
  28: 84, 29: 84, 30: 84, 31: 112, 32: 96,
}

const slug = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** @returns {{ scene: number, dir: string, name: string, width: number, steps: (string | number)[] }[]} */
export function walks() {
  const result = []
  SCENES.forEach((sceneName, index) => {
    const scene = index + 1
    const dir = `${String(scene).padStart(2, '0')}-${slug(sceneName)}`
    const add = (name, width, steps) => result.push({ scene, dir, name, width, steps: ['\0', ...steps] })
    add('initial', WIDTH[scene], [])
    if (PAGES[scene]) add('pages', WIDTH[scene], times(PAGES[scene] - 1, NEXT))
    for (const [name, steps, width] of EXTRA[scene] ?? []) add(name, width, steps)
  })
  return result
}
