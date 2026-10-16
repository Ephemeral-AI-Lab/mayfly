#!/usr/bin/env node
/**
 * Palette proposals for Mayfly's themes: the default dark palette as it ships, a light palette made from it, two more
 * dark palettes (Tide, Dusk), and two more light ones (Linen, Mist). Each table has the shape of the `*_FOREGROUNDS`,
 * `*_BACKGROUNDS`, and `*_LOGO_GRADIENT` constants in `packages/mayfly/src/core/theme-*.ts`, so an implementation round
 * copies it as it is. The script imports nothing from Mayfly; `theme-preview.mjs` paints the tables on a specimen.
 *
 * Every proposal follows one recipe, measured from the default dark palette in OKLCH (lightness L, chroma C, hue H):
 *
 *   1. Neutrals. `textStrong`, `text`, `muted`, `textMuted` are one hue at a chroma of 0.035 or less, a ladder of
 *      clear steps (dark: L 0.97, 0.95, 0.72, 0.50). Most rows are painted in these four: `muted` alone is named in
 *      more paints than every other token together.
 *   2. One brand hue. `primary`, `accent`, `border`, `borderFocus`, `mdLink`, `modelHighlight`, and the logo gradient
 *      share the hue of `primary` and differ in lightness and chroma only. `primary` is the most saturated; `accent` is
 *      its quieter tint, between `primary` and `text`; `border` is its deep shade, between the canvas and `textMuted`.
 *   3. Status apart. `success`, `warning`, and `error` keep their hues (green, amber, red) in every theme and stay at
 *      least 45° of hue from `primary`, so the focus mark never reads as an alert.
 *   4. Backgrounds. `selectedBg` is a neutral step off the canvas; the diff bands are low-chroma tints of the status
 *      hues; `text` reads at 7:1 or more on each.
 *   5. Aliases. `roleUser` is `primary`; `shellMode`, `mdCode`, `mdListBullet` are `accent`; `mdHeading` is
 *      `textStrong`; `mdCodeBlock` is `text`; `mdQuote` and `diffMeta` are `muted`; `mdLinkUrl`, `mdQuoteBorder`, and
 *      `diffGutter` are `textMuted`; `mdHr` and `mdCodeBlockBorder` are `border`.
 *
 * Themes paint no background: each palette is drawn for a canvas (the terminal background it is designed and
 * checked on) and also checked on a common terminal background of its mode, so it holds when the terminal is not set
 * to its canvas. `--check` holds every palette to the recipe; with `--shipped` it also runs the shipped light, ocean,
 * and paper palettes. All three break rule 2: their accent, user, shell-mode, and focus-border tokens are each a hue of
 * their own, which is why they read as noisy beside the default. Light also paints frames darker than its faintest
 * text, ocean tints its grays at twice the chroma, and paper puts its primary between its error and warning hues.
 *
 *   node docs/design/prototypes/theme-palettes.mjs                every token of every proposal, with swatches
 *   node docs/design/prototypes/theme-palettes.mjs tide           one palette
 *   node docs/design/prototypes/theme-palettes.mjs --check        the recipe's rules per palette (--shipped adds the shipped ones)
 *   node docs/design/prototypes/theme-palettes.mjs --json tide    a palette file for `/theme custom <path> dark` (light for a light one)
 *
 * @module docs/design/prototypes/theme-palettes
 */

import { pathToFileURL } from 'node:url'

// ======================================================================= proposals
/** The aliases of rule 5, filled in from the tokens they repeat. */
function aliased(own) {
  return {
    ...own,
    roleUser: own.primary,
    shellMode: own.accent,
    mdHeading: own.textStrong,
    mdLinkUrl: own.textMuted,
    mdCode: own.accent,
    mdCodeBlock: own.text,
    mdCodeBlockBorder: own.border,
    mdQuote: own.muted,
    mdQuoteBorder: own.textMuted,
    mdHr: own.border,
    mdListBullet: own.accent,
    diffAdded: own.success,
    diffRemoved: own.error,
    diffGutter: own.textMuted,
    diffMeta: own.muted,
  }
}

/** The status colors every dark palette shares (rule 3). */
const DARK_STATUS = { success: '#4EC87E', error: '#E85454', warning: '#E8A838', diffAddedStrong: '#7AD99B', diffRemovedStrong: '#F08585' }

/** The status colors every light palette shares (rule 3), dark enough for 4.5:1 on a cream canvas. */
const LIGHT_STATUS = { success: '#137738', error: '#BE2E31', warning: '#935F01', diffAddedStrong: '#0D632D', diffRemovedStrong: '#9E2225' }

export const THEMES = [
  {
    id: 'dark',
    name: 'Mayfly Dark',
    dark: true,
    canvas: '#0A0A0C',
    idea: 'The default as it ships: slate ink on near-black, brand violet. Unchanged; the recipe is measured from it.',
    foregrounds: {
      text: '#EDEDF2', textStrong: '#F5F5F7', muted: '#9AA3B8', textMuted: '#5C6476',
      accent: '#C9C0F0', primary: '#9A86E6', border: '#45406B', borderFocus: '#DCD7F2',
      success: '#4ec87e', error: '#e85454', warning: '#e8a838',
      roleUser: '#9A86E6', shellMode: '#C9C0F0',
      mdHeading: '#F5F5F7', mdLink: '#B9A9F0', mdLinkUrl: '#5C6476', mdCode: '#C9C0F0', mdCodeBlock: '#EDEDF2',
      mdCodeBlockBorder: '#45406B', mdQuote: '#9AA3B8', mdQuoteBorder: '#5C6476', mdHr: '#45406B', mdListBullet: '#C9C0F0',
      diffAdded: '#4ec87e', diffRemoved: '#e85454', diffAddedStrong: '#7ad99b', diffRemovedStrong: '#f08585',
      diffGutter: '#5C6476', diffMeta: '#9AA3B8',
      modelHighlight: '#E9E6F4',
    },
    backgrounds: { selectedBg: '#2b2b30', diffAddedBg: '#1E3A2B', diffRemovedBg: '#43232A' },
    logoGradient: ['#F5F5F7', '#E9E5F6', '#DBD3F0', '#C9BEEA', '#B2A1EC', '#9A86E6', '#8371D6', '#6C5BBF'],
  },
  {
    id: 'light',
    name: 'Mayfly Light',
    dark: false,
    canvas: '#FFFFFF',
    idea: 'The default turned over: the same violet and slate ladder on white, so auto switches within one brand.',
    foregrounds: aliased({
      text: '#2A2A33', textStrong: '#15151B', muted: '#626270', textMuted: '#838391',
      accent: '#4F417E', primary: '#6D52BC', border: '#B7B3D0', borderFocus: '#3E375A',
      ...LIGHT_STATUS,
      mdLink: '#5E499D',
      modelHighlight: '#36314D',
    }),
    backgrounds: { selectedBg: '#E7E7F0', diffAddedBg: '#DCF9E1', diffRemovedBg: '#FFEDEC' },
    logoGradient: ['#30205B', '#402C75', '#513991', '#6247AC', '#7358C2', '#846CD1', '#9482DB', '#A698E4'],
  },
  {
    id: 'tide',
    name: 'Tide',
    dark: true,
    canvas: '#08191D',
    idea: 'Deep water: blue-green ink on a sea-dark canvas, a clear aqua brand. Replaces ocean.',
    foregrounds: aliased({
      text: '#EAEFF0', textStrong: '#F4F6F6', muted: '#91A8AE', textMuted: '#5D7177',
      accent: '#9CD3D9', primary: '#0DABB9', border: '#215C63', borderFocus: '#C4E2E5',
      ...DARK_STATUS,
      mdLink: '#6EC6D0',
      modelHighlight: '#DDECED',
    }),
    backgrounds: { selectedBg: '#313738', diffAddedBg: '#274334', diffRemovedBg: '#4E2D34' },
    logoGradient: ['#F3F6F6', '#D8ECEF', '#BBDFE3', '#96D0D6', '#62BEC9', '#0DABB9', '#0994A0', '#007E88'],
  },
  {
    id: 'dusk',
    name: 'Dusk',
    dark: true,
    canvas: '#1B1118',
    idea: 'The hour mayflies hatch: warm plum-grey ink, an orchid brand. The warm dark the set lacked.',
    foregrounds: aliased({
      text: '#F0ECEF', textStrong: '#F6F5F6', muted: '#AE9EA8', textMuted: '#766870',
      accent: '#E0BAD7', primary: '#C47BB5', border: '#66445F', borderFocus: '#E9D4E3',
      ...DARK_STATUS,
      mdLink: '#D8A1CB',
      modelHighlight: '#EFE4EC',
    }),
    backgrounds: { selectedBg: '#363335', diffAddedBg: '#254132', diffRemovedBg: '#4C2B32' },
    logoGradient: ['#F6F5F6', '#F1E3EE', '#E8CFE2', '#DDB6D4', '#D299C4', '#C47BB5', '#AD679E', '#945587'],
  },
  {
    id: 'linen',
    name: 'Linen',
    dark: false,
    canvas: '#F8F3E9',
    idea: 'Ink on paper: warm brown-grey text on cream, a fountain-pen blue brand. Replaces paper.',
    foregrounds: aliased({
      text: '#302A23', textStrong: '#191510', muted: '#6B6256', textMuted: '#8C8378',
      accent: '#2E4D7B', primary: '#3268B6', border: '#AAB9CE', borderFocus: '#2C3E58',
      ...LIGHT_STATUS,
      mdLink: '#305A98',
      modelHighlight: '#28364B',
    }),
    backgrounds: { selectedBg: '#E1DBD4', diffAddedBg: '#D0EED5', diffRemovedBg: '#FDDEDD' },
    logoGradient: ['#0F2D57', '#163C71', '#1E4B8D', '#295CA6', '#386EBC', '#4D80CB', '#6793D5', '#80A6DF'],
  },
  {
    id: 'mist',
    name: 'Mist',
    dark: false,
    canvas: '#F3F8FA',
    idea: 'Morning over the stream: cool grey ink on a pale blue-white, a deep teal brand. Tide by day.',
    foregrounds: aliased({
      text: '#252D2F', textStrong: '#111719', muted: '#59666A', textMuted: '#7B878B',
      accent: '#05585F', primary: '#047781', border: '#A1BEC1', borderFocus: '#194449',
      ...LIGHT_STATUS,
      mdLink: '#016770',
      modelHighlight: '#193B3F',
    }),
    backgrounds: { selectedBg: '#D9E2E4', diffAddedBg: '#D4F1D9', diffRemovedBg: '#FEE2E1' },
    logoGradient: ['#02353A', '#03464C', '#05585F', '#006B74', '#017E88', '#03919D', '#27A4B0', '#59B5BF'],
  },
]

// ======================================================================= shipped, for comparison
// The shipped light, ocean, and paper palettes as of d77590a, for `--shipped`. Canvases are the ones
// `packages/mayfly/tests/core/theme-contrast.spec.ts` checks them on.
export const SHIPPED = [
  {
    id: 'shipped-light', name: 'light (shipped)', dark: false, canvas: '#FFFFFF', replacedBy: 'light',
    foregrounds: {
      text: '#1f2328', textStrong: '#0a0c10', muted: '#6a737d', textMuted: '#8c959f', accent: '#087f90', primary: '#0969da',
      border: '#6e7781', borderFocus: '#9a6700', success: '#1a7f37', error: '#cf222e', warning: '#9a6700', roleUser: '#2e3fb8',
      shellMode: '#8250df', mdHeading: '#1f2328', mdLink: '#0969da', mdLinkUrl: '#8c959f', mdCode: '#0969da', mdCodeBlock: '#24292f',
      mdCodeBlockBorder: '#8c959f', mdQuote: '#6a737d', mdQuoteBorder: '#6a737d', mdHr: '#6e7781', mdListBullet: '#1f2328',
      diffAdded: '#1a7f37', diffRemoved: '#cf222e', diffAddedStrong: '#116329', diffRemovedStrong: '#a40e26', diffGutter: '#8c959f',
      diffMeta: '#6a737d', modelHighlight: '#1d4fd7',
    },
    backgrounds: { selectedBg: '#d0d7de', diffAddedBg: '#dafbe1', diffRemovedBg: '#ffebe9' },
    logoGradient: ['#0a2c6b', '#103581', '#164097', '#1d4ba9', '#2f66cd', '#3d77dd', '#4f8ae8', '#63a0f2'],
  },
  {
    id: 'shipped-ocean', name: 'ocean (shipped)', dark: true, canvas: '#0E1A2B', replacedBy: 'tide',
    foregrounds: {
      text: '#d8e4f8', textStrong: '#f4f9ff', muted: '#7f96bc', textMuted: '#5c7499', accent: '#35d9ce', primary: '#5db4ff',
      border: '#3f5679', borderFocus: '#e6b455', success: '#42d68c', error: '#ff7070', warning: '#e6b455', roleUser: '#7b95ff',
      shellMode: '#b493ff', mdHeading: '#d8e4f8', mdLink: '#5db4ff', mdLinkUrl: '#5c7499', mdCode: '#5db4ff', mdCodeBlock: '#d8e4f8',
      mdCodeBlockBorder: '#5c7499', mdQuote: '#7f96bc', mdQuoteBorder: '#7f96bc', mdHr: '#3f5679', mdListBullet: '#d8e4f8',
      diffAdded: '#42d68c', diffRemoved: '#ff7070', diffAddedStrong: '#82efb8', diffRemovedStrong: '#ffa3a3', diffGutter: '#5c7499',
      diffMeta: '#7f96bc', modelHighlight: '#5fd9e8',
    },
    backgrounds: { selectedBg: '#22406b', diffAddedBg: '#163f3a', diffRemovedBg: '#4a2432' },
    logoGradient: ['#0e5f73', '#0b7c92', '#0891b2', '#0aa8c9', '#2ed3ea', '#52e2f2', '#7cecf6', '#a8f4fa'],
  },
  {
    id: 'shipped-paper', name: 'paper (shipped)', dark: false, canvas: '#F6F0E4', replacedBy: 'linen',
    foregrounds: {
      text: '#3b322a', textStrong: '#201a13', muted: '#6f6357', textMuted: '#8a7d6e', accent: '#0e7a70', primary: '#a84d1a',
      border: '#a89a88', borderFocus: '#965c06', success: '#47763a', error: '#c03d2e', warning: '#965c06', roleUser: '#35509e',
      shellMode: '#7c5cbf', mdHeading: '#3b322a', mdLink: '#a84d1a', mdLinkUrl: '#8a7d6e', mdCode: '#a84d1a', mdCodeBlock: '#3b322a',
      mdCodeBlockBorder: '#8a7d6e', mdQuote: '#6f6357', mdQuoteBorder: '#a89a88', mdHr: '#c3b6a4', mdListBullet: '#3b322a',
      diffAdded: '#47763a', diffRemoved: '#c03d2e', diffAddedStrong: '#2f5d28', diffRemovedStrong: '#992a1d', diffGutter: '#8a7d6e',
      diffMeta: '#6f6357', modelHighlight: '#a04e1a',
    },
    backgrounds: { selectedBg: '#efe6d3', diffAddedBg: '#e4ecd3', diffRemovedBg: '#f6dcd4' },
    logoGradient: ['#7c3f0e', '#8f4d15', '#a35c1f', '#b76e2b', '#d49655', '#dfaa70', '#e8bd8c', '#f0d0ab'],
  },
]

/** A palette by id, proposals and shipped alike. */
export const themeById = id => [...THEMES, ...SHIPPED].find(theme => theme.id === id)

// ======================================================================= color math
const channel = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
const linear = value => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }

/** WCAG relative luminance. */
function luminance(hex) {
  const [r, g, b] = channel(hex).map(linear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** The WCAG contrast ratio of two colors. */
export function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

/** A color as OKLCH: lightness 0 to 1, chroma, hue in degrees. */
export function oklch(hex) {
  const [r, g, b] = channel(hex).map(linear)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
  return { L, C: Math.hypot(A, B), H: (Math.atan2(B, A) * 180 / Math.PI + 360) % 360 }
}

/** The angle between two hues, 0 to 180. */
const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d }

/** Mix two colors in sRGB, `t` of the way from `a` to `b`. */
export function mix(a, b, t) {
  const [x, y] = [channel(a), channel(b)]
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`
}

// ======================================================================= the recipe as rules
/** The palette token each public tone paints with (`paintPluginTone` in core/plugin-view.ts). */
export const TONE_TOKENS = { default: 'text', muted: 'muted', primary: 'primary', accent: 'accent', user: 'roleUser', success: 'success', warning: 'warning', danger: 'error' }

/** A common terminal background of each mode, besides the palette's own canvas. */
export const COMMON_CANVAS = { dark: '#1E1E1E', light: '#FFFFFF' }

const NEUTRALS = ['textStrong', 'text', 'muted', 'textMuted']
const BRAND = ['accent', 'border', 'borderFocus', 'roleUser', 'shellMode', 'mdLink', 'mdCode', 'mdListBullet', 'modelHighlight']
const STATUS_HUES = { success: [135, 165], warning: [60, 90], error: [15, 35] }

/**
 * Hold one palette to the recipe.
 * @returns one entry per rule: its name and the findings that break it (none when it holds).
 */
export function check(theme) {
  const fg = theme.foregrounds
  const canvas = theme.canvas
  const common = COMMON_CANVAS[theme.dark ? 'dark' : 'light']
  const ratio = (token, on = canvas) => contrast(fg[token], on)
  const hue = token => oklch(fg[token]).H
  const brandHue = hue('primary')
  const fixed = n => n.toFixed(2)
  const rules = []
  const rule = (name, findings) => rules.push({ name, findings: findings.filter(Boolean) })

  rule('every tone reads at 4.5:1 on its canvas and on a common background', Object.entries(TONE_TOKENS).flatMap(([tone, token]) =>
    [canvas, common].map(on => ratio(token, on) < 4.5 && `${tone} ${fixed(ratio(token, on))} on ${on}`)))
  rule('the neutral ladder steps down: textStrong ≥ text > muted > textMuted > border', [
    ratio('textStrong') < ratio('text') && 'textStrong is fainter than text',
    !(ratio('text') > ratio('muted') && ratio('muted') > ratio('textMuted') && ratio('textMuted') > ratio('border'))
      && `text ${fixed(ratio('text'))}, muted ${fixed(ratio('muted'))}, textMuted ${fixed(ratio('textMuted'))}, border ${fixed(ratio('border'))}`,
    ratio('textMuted') < 3 && `textMuted ${fixed(ratio('textMuted'))} is under 3:1`,
    (ratio('border') < 1.6 || ratio('border') > 3) && `border ${fixed(ratio('border'))} is outside 1.6 to 3:1`,
  ])
  rule('neutrals are one quiet hue (chroma ≤ 0.035)', NEUTRALS.map(token => oklch(fg[token]).C > 0.035 && `${token} chroma ${oklch(fg[token]).C.toFixed(3)}`))
  rule('one brand hue: every brand token within 12° of primary', [
    ...BRAND.map(token => oklch(fg[token]).C >= 0.02 && hueGap(hue(token), brandHue) > 12
      && `${token} ${fg[token]} at ${hue(token).toFixed(0)}°, primary at ${brandHue.toFixed(0)}°`),
    ...theme.logoGradient.map((hex, i) => oklch(hex).C >= 0.03 && hueGap(oklch(hex).H, brandHue) > 12 && `logo row ${i} ${hex} at ${oklch(hex).H.toFixed(0)}°`),
  ])
  rule('accent is quieter than primary', [oklch(fg.accent).C >= oklch(fg.primary).C && `accent chroma ${oklch(fg.accent).C.toFixed(3)} ≥ primary ${oklch(fg.primary).C.toFixed(3)}`])
  rule('status hues are fixed and 45° or more from primary', Object.entries(STATUS_HUES).flatMap(([token, [lo, hi]]) => [
    (hue(token) < lo || hue(token) > hi) && `${token} at ${hue(token).toFixed(0)}° is outside ${lo}° to ${hi}°`,
    hueGap(hue(token), brandHue) < 45 && `${token} is ${hueGap(hue(token), brandHue).toFixed(0)}° from primary`,
  ]))
  rule('text reads at 7:1 on every band', Object.entries(theme.backgrounds).map(([token, hex]) =>
    contrast(fg.text, hex) < 7 && `text ${fixed(contrast(fg.text, hex))} on ${token}`))
  return rules
}

// ======================================================================= output
const rgb = hex => channel(hex).join(';')
const fgPaint = (hex, s) => `\x1b[38;2;${rgb(hex)}m${s}\x1b[39m`
const bgPaint = (hex, s) => `\x1b[48;2;${rgb(hex)}m${s}\x1b[49m`
const bold = s => `\x1b[1m${s}\x1b[22m`
const dim = s => `\x1b[2m${s}\x1b[22m`

/** Every token of a palette: a swatch, the hex, OKLCH, and the contrast on the canvas. */
function table(theme) {
  const swatch = hex => bgPaint(hex, '    ')
  const row = (token, hex, background) => {
    const { L, C, H } = oklch(hex)
    const sample = background ? bgPaint(hex, fgPaint(theme.foregrounds.text, ' Aa ')) : bgPaint(theme.canvas, fgPaint(hex, ' Aa '))
    return `  ${swatch(hex)} ${sample} ${token.padEnd(18)} ${hex}  ${dim(`L ${L.toFixed(2)}  C ${C.toFixed(3)}  H ${H.toFixed(0).padStart(3)}°`)}  ${contrast(hex, theme.canvas).toFixed(2).padStart(5)}:1`
  }
  return [
    `${bold(theme.name)}  ${dim(`${theme.id} · ${theme.dark ? 'dark' : 'light'} · canvas ${theme.canvas}`)}`,
    ...(theme.idea ? [dim(theme.idea)] : []),
    '',
    ...Object.entries(theme.foregrounds).map(([token, hex]) => row(token, hex, false)),
    ...Object.entries(theme.backgrounds).map(([token, hex]) => row(token, hex, true)),
    `  ${theme.logoGradient.map(hex => bgPaint(hex, '  ')).join('')}  logoGradient`,
    '',
  ]
}

/** The rule report of the given palettes. */
function report(themes) {
  const out = []
  let failed = 0
  for (const theme of themes) {
    const rules = check(theme)
    const broken = rules.filter(r => r.findings.length > 0)
    failed += broken.length > 0 ? 1 : 0
    out.push(`${bold(theme.name)}  ${broken.length === 0 ? fgPaint('#4EC87E', '✓ holds the recipe') : fgPaint('#E85454', `✗ breaks ${broken.length} of ${rules.length} rules`)}`)
    for (const r of rules) {
      out.push(`  ${r.findings.length === 0 ? fgPaint('#4EC87E', '✓') : fgPaint('#E85454', '✗')} ${r.name}`)
      for (const f of r.findings) out.push(`      ${dim(f)}`)
    }
    out.push('')
  }
  return { lines: out, failed }
}

/** The palette file `/theme custom <path> <dark|light>` loads: every token, the bands, and the logo gradient. */
export const customThemeFile = theme => ({ ...theme.foregrounds, ...theme.backgrounds, logoGradient: theme.logoGradient })

// ======================================================================= main
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2)
  const ids = argv.filter(a => !a.startsWith('--'))
  if (argv.includes('--json')) {
    const theme = themeById(ids[0] ?? '')
    if (theme === undefined) {
      process.stderr.write(`usage: --json <${THEMES.map(t => t.id).join('|')}>\n`)
      process.exit(2)
    }
    process.stdout.write(`${JSON.stringify(customThemeFile(theme), null, 2)}\n`)
  } else if (argv.includes('--check')) {
    const themes = ids.length > 0 ? ids.map(themeById).filter(Boolean) : [...THEMES, ...(argv.includes('--shipped') ? SHIPPED : [])]
    const { lines } = report(themes)
    process.stdout.write(`${lines.join('\n')}\n`)
    process.exitCode = themes.filter(t => !t.id.startsWith('shipped-')).some(t => check(t).some(r => r.findings.length > 0)) ? 1 : 0
  } else {
    const themes = ids.length > 0 ? ids.map(themeById).filter(Boolean) : THEMES
    process.stdout.write(`${themes.flatMap(table).join('\n')}\n`)
  }
}
