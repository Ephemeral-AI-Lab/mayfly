/**
 * Ports of ready-made palettes: Catppuccin, Rosé Pine, Dracula, Nord, Tokyo Night, Solarized, Gruvbox, One,
 * Kanagawa, and Everforest, 22 variants in all. Each port takes only its scheme's own colors, by their upstream names
 * (copied from the sources in `FAMILIES`), and assigns them to Mayfly's roles. A tone that reads under 4.5:1 on the
 * scheme's background (3:1 for `textMuted`, 1.5:1 for `border`) is lightened or darkened in OKLCH just enough to pass,
 * keeping its hue and chroma; `nudges` records every such change. Where a scheme's signature accent sits on its warning
 * color (Gruvbox's orange), `primary` takes the scheme's blue instead. The diff bands, the mark's wing and trail are
 * mixed from the scheme's own colors. The ports share Mayfly's aliases (`aliased`).
 *
 * @module docs/design/prototypes/theme-ports
 */

import { contrast, fromOklch, mix, oklch } from './color.mjs'

/** Where each family's colors come from, and the license that covers them. */
export const FAMILIES = {
  'catppuccin': { name: 'Catppuccin', source: 'https://github.com/catppuccin/palette (palette.json 1.8.0)', license: 'MIT', copyright: 'Copyright (c) 2021 Catppuccin' },
  'rose-pine': { name: 'Rosé Pine', source: 'https://github.com/rose-pine/palette (source/index.ts)', license: 'MIT', copyright: 'Copyright (c) mvllow' },
  'dracula': { name: 'Dracula', source: 'https://spec.draculatheme.com', license: 'MIT', copyright: 'Copyright (c) 2023 Dracula Theme' },
  'nord': { name: 'Nord', source: 'https://github.com/nordtheme/nord (src/nord.css)', license: 'MIT', copyright: 'Copyright (c) 2016-present Sven Greb' },
  'tokyo-night': { name: 'Tokyo Night', source: 'https://github.com/folke/tokyonight.nvim (extras/lua)', license: 'Apache-2.0', copyright: 'tokyonight.nvim by Folke Lemaitre' },
  'solarized': { name: 'Solarized', source: 'https://github.com/altercation/solarized (README)', license: 'MIT', copyright: 'Copyright (c) 2011 Ethan Schoonover' },
  'gruvbox': { name: 'Gruvbox', source: 'https://github.com/morhetz/gruvbox (colors/gruvbox.vim)', license: 'MIT/X11', copyright: 'gruvbox by Pavel Pertsev (morhetz)' },
  'one': { name: 'One', source: 'https://github.com/joshdick/onedark.vim (One Dark) and https://github.com/atom/atom one-light-syntax (One Light)', license: 'MIT', copyright: 'Copyright (c) 2015 Joshua Dick; Copyright (c) 2011-2022 GitHub Inc.' },
  'kanagawa': { name: 'Kanagawa', source: 'https://github.com/rebelot/kanagawa.nvim (lua/kanagawa/colors.lua)', license: 'MIT', copyright: 'Copyright (c) 2021 Tommaso Laurenzi' },
  'everforest': { name: 'Everforest', source: 'https://github.com/sainnhe/everforest (palette.md, medium)', license: 'MIT', copyright: 'Copyright (c) 2019 sainnhe' },
}

/**
 * Each port: its key, name, picker line, background, family, the upstream colors it uses (by their upstream names),
 * and the upstream name each Mayfly role takes.
 */
export const PORT_DEFS = [
  {
    id: 'catppuccin-mocha', name: 'Catppuccin Mocha', idea: 'soothing pastels, mauve', dark: true, family: 'catppuccin',
    colors: { base: '#1E1E2E', text: '#CDD6F4', subtext0: '#A6ADC8', overlay1: '#7F849C', surface2: '#585B70', surface0: '#313244', mauve: '#CBA6F7', pink: '#F5C2E7', blue: '#89B4FA', rosewater: '#F5E0DC', green: '#A6E3A1', yellow: '#F9E2AF', red: '#F38BA8' },
    roles: { canvas: 'base', text: 'text', textStrong: 'text', muted: 'subtext0', textMuted: 'overlay1', border: 'surface2', selectedBg: 'surface0', primary: 'mauve', accent: 'pink', mdLink: 'blue', modelHighlight: 'rosewater', success: 'green', warning: 'yellow', error: 'red' },
  },
  {
    id: 'catppuccin-macchiato', name: 'Catppuccin Macchiato', idea: 'pastels, a shade lighter', dark: true, family: 'catppuccin',
    colors: { base: '#24273A', text: '#CAD3F5', subtext0: '#A5ADCB', overlay1: '#8087A2', surface2: '#5B6078', surface0: '#363A4F', mauve: '#C6A0F6', pink: '#F5BDE6', blue: '#8AADF4', rosewater: '#F4DBD6', green: '#A6DA95', yellow: '#EED49F', red: '#ED8796' },
    roles: { canvas: 'base', text: 'text', textStrong: 'text', muted: 'subtext0', textMuted: 'overlay1', border: 'surface2', selectedBg: 'surface0', primary: 'mauve', accent: 'pink', mdLink: 'blue', modelHighlight: 'rosewater', success: 'green', warning: 'yellow', error: 'red' },
  },
  {
    id: 'catppuccin-frappe', name: 'Catppuccin Frappé', idea: 'muted pastels on slate', dark: true, family: 'catppuccin',
    colors: { base: '#303446', text: '#C6D0F5', subtext0: '#A5ADCE', overlay1: '#838BA7', surface2: '#626880', surface0: '#414559', mauve: '#CA9EE6', pink: '#F4B8E4', blue: '#8CAAEE', rosewater: '#F2D5CF', green: '#A6D189', yellow: '#E5C890', red: '#E78284' },
    roles: { canvas: 'base', text: 'text', textStrong: 'text', muted: 'subtext0', textMuted: 'overlay1', border: 'surface2', selectedBg: 'surface0', primary: 'mauve', accent: 'pink', mdLink: 'blue', modelHighlight: 'rosewater', success: 'green', warning: 'yellow', error: 'red' },
  },
  {
    id: 'dracula', name: 'Dracula', idea: 'purple and pink on charcoal', dark: true, family: 'dracula',
    colors: { background: '#282A36', foreground: '#F8F8F2', comment: '#6272A4', currentLine: '#44475A', purple: '#BD93F9', pink: '#FF79C6', cyan: '#8BE9FD', green: '#50FA7B', yellow: '#F1FA8C', red: '#FF5555' },
    roles: { canvas: 'background', text: 'foreground', textStrong: 'foreground', muted: 'comment', textMuted: 'comment', border: 'currentLine', selectedBg: 'currentLine', primary: 'purple', accent: 'pink', mdLink: 'cyan', modelHighlight: 'cyan', success: 'green', warning: 'yellow', error: 'red' },
  },
  {
    id: 'everforest-dark', name: 'Everforest Dark', idea: 'a forest at dusk, soft greens', dark: true, family: 'everforest',
    colors: { bg0: '#2D353B', fg: '#D3C6AA', grey2: '#9DA9A0', grey0: '#7A8478', bg4: '#4F585E', bg_visual: '#543A48', blue: '#7FBBB3', purple: '#D699B6', aqua: '#83C092', green: '#A7C080', yellow: '#DBBC7F', red: '#E67E80' },
    roles: { canvas: 'bg0', text: 'fg', textStrong: 'fg', muted: 'grey2', textMuted: 'grey0', border: 'bg4', selectedBg: 'bg_visual', primary: 'blue', accent: 'purple', mdLink: 'aqua', modelHighlight: 'aqua', success: 'green', warning: 'yellow', error: 'red' },
  },
  {
    id: 'gruvbox-dark', name: 'Gruvbox Dark', idea: 'retro groove, warm and earthy', dark: true, family: 'gruvbox',
    colors: { dark0: '#282828', light1: '#EBDBB2', light0: '#FBF1C7', light4: '#A89984', gray_245: '#928374', dark2: '#504945', dark1: '#3C3836', bright_blue: '#83A598', bright_orange: '#FE8019', bright_aqua: '#8EC07C', bright_purple: '#D3869B', bright_green: '#B8BB26', bright_yellow: '#FABD2F', bright_red: '#FB4934' },
    roles: { canvas: 'dark0', text: 'light1', textStrong: 'light0', muted: 'light4', textMuted: 'gray_245', border: 'dark2', selectedBg: 'dark1', primary: 'bright_blue', accent: 'bright_orange', mdLink: 'bright_aqua', modelHighlight: 'bright_purple', success: 'bright_green', warning: 'bright_yellow', error: 'bright_red' },
  },
  {
    id: 'kanagawa-wave', name: 'Kanagawa Wave', idea: 'Hokusai\'s wave, ink and indigo', dark: true, family: 'kanagawa',
    colors: { sumiInk3: '#1F1F28', fujiWhite: '#DCD7BA', springViolet1: '#938AA9', fujiGray: '#727169', sumiInk6: '#54546D', waveBlue1: '#223249', crystalBlue: '#7E9CD8', oniViolet: '#957FB8', springBlue: '#7FB4CA', waveAqua2: '#7AA89F', springGreen: '#98BB6C', roninYellow: '#FF9E3B', samuraiRed: '#E82424' },
    roles: { canvas: 'sumiInk3', text: 'fujiWhite', textStrong: 'fujiWhite', muted: 'springViolet1', textMuted: 'fujiGray', border: 'sumiInk6', selectedBg: 'waveBlue1', primary: 'crystalBlue', accent: 'oniViolet', mdLink: 'springBlue', modelHighlight: 'waveAqua2', success: 'springGreen', warning: 'roninYellow', error: 'samuraiRed' },
  },
  {
    id: 'nord', name: 'Nord', idea: 'arctic frost on polar night', dark: true, family: 'nord',
    colors: { nord0: '#2E3440', nord4: '#D8DEE9', nord6: '#ECEFF4', nord3: '#4C566A', nord2: '#434C5E', nord8: '#88C0D0', nord7: '#8FBCBB', nord9: '#81A1C1', nord14: '#A3BE8C', nord13: '#EBCB8B', nord11: '#BF616A' },
    roles: { canvas: 'nord0', text: 'nord4', textStrong: 'nord6', muted: 'nord3', textMuted: 'nord3', border: 'nord3', selectedBg: 'nord2', primary: 'nord8', accent: 'nord7', mdLink: 'nord9', modelHighlight: 'nord7', success: 'nord14', warning: 'nord13', error: 'nord11' },
  },
  {
    id: 'one-dark', name: 'One Dark', idea: 'Atom\'s One, blue and purple on slate', dark: true, family: 'one',
    colors: { black: '#282C34', foreground: '#ABB2BF', comment_grey: '#5C6370', gutter_fg_grey: '#4B5263', visual_grey: '#3E4452', blue: '#61AFEF', purple: '#C678DD', cyan: '#56B6C2', green: '#98C379', yellow: '#E5C07B', red: '#E06C75' },
    roles: { canvas: 'black', text: 'foreground', textStrong: 'foreground', muted: 'comment_grey', textMuted: 'comment_grey', border: 'gutter_fg_grey', selectedBg: 'visual_grey', primary: 'blue', accent: 'purple', mdLink: 'cyan', modelHighlight: 'cyan', success: 'green', warning: 'yellow', error: 'red' },
  },
  {
    id: 'rose-pine', name: 'Rosé Pine', idea: 'iris and rose, soho vibes', dark: true, family: 'rose-pine',
    colors: { base: '#191724', text: '#E0DEF4', subtle: '#908CAA', muted: '#6E6A86', highlightHigh: '#524F67', highlightMed: '#403D52', iris: '#C4A7E7', rose: '#EBBCBA', foam: '#9CCFD8', pine: '#31748F', gold: '#F6C177', love: '#EB6F92' },
    roles: { canvas: 'base', text: 'text', textStrong: 'text', muted: 'subtle', textMuted: 'muted', border: 'highlightHigh', selectedBg: 'highlightMed', primary: 'iris', accent: 'rose', mdLink: 'foam', modelHighlight: 'foam', success: 'pine', warning: 'gold', error: 'love' },
  },
  {
    id: 'rose-pine-moon', name: 'Rosé Pine Moon', idea: 'iris and rose, under the moon', dark: true, family: 'rose-pine',
    colors: { base: '#232136', text: '#E0DEF4', subtle: '#908CAA', muted: '#6E6A86', highlightHigh: '#56526E', highlightMed: '#44415A', iris: '#C4A7E7', rose: '#EA9A97', foam: '#9CCFD8', pine: '#3E8FB0', gold: '#F6C177', love: '#EB6F92' },
    roles: { canvas: 'base', text: 'text', textStrong: 'text', muted: 'subtle', textMuted: 'muted', border: 'highlightHigh', selectedBg: 'highlightMed', primary: 'iris', accent: 'rose', mdLink: 'foam', modelHighlight: 'foam', success: 'pine', warning: 'gold', error: 'love' },
  },
  {
    id: 'solarized-dark', name: 'Solarized Dark', idea: 'the classic, deep teal', dark: true, family: 'solarized',
    colors: { base03: '#002B36', base0: '#839496', base1: '#93A1A1', base00: '#657B83', base01: '#586E75', base02: '#073642', blue: '#268BD2', violet: '#6C71C4', cyan: '#2AA198', green: '#859900', yellow: '#B58900', red: '#DC322F' },
    roles: { canvas: 'base03', text: 'base0', textStrong: 'base1', muted: 'base00', textMuted: 'base01', border: 'base02', selectedBg: 'base02', primary: 'blue', accent: 'violet', mdLink: 'cyan', modelHighlight: 'base1', success: 'green', warning: 'yellow', error: 'red' },
  },
  {
    id: 'tokyo-night', name: 'Tokyo Night', idea: 'downtown Tokyo at night', dark: true, family: 'tokyo-night',
    colors: { bg: '#1A1B26', fg: '#C0CAF5', fg_dark: '#A9B1D6', comment: '#565F89', fg_gutter: '#3B4261', bg_visual: '#283457', blue: '#7AA2F7', magenta: '#BB9AF7', cyan: '#7DCFFF', green: '#9ECE6A', yellow: '#E0AF68', red: '#F7768E' },
    roles: { canvas: 'bg', text: 'fg', textStrong: 'fg', muted: 'fg_dark', textMuted: 'comment', border: 'fg_gutter', selectedBg: 'bg_visual', primary: 'blue', accent: 'magenta', mdLink: 'cyan', modelHighlight: 'cyan', success: 'green', warning: 'yellow', error: 'red' },
  },
  {
    id: 'tokyo-night-storm', name: 'Tokyo Night Storm', idea: 'the same city, a stormier blue', dark: true, family: 'tokyo-night',
    colors: { bg: '#24283B', fg: '#C0CAF5', fg_dark: '#A9B1D6', comment: '#565F89', fg_gutter: '#3B4261', bg_visual: '#2E3C64', blue: '#7AA2F7', magenta: '#BB9AF7', cyan: '#7DCFFF', green: '#9ECE6A', yellow: '#E0AF68', red: '#F7768E' },
    roles: { canvas: 'bg', text: 'fg', textStrong: 'fg', muted: 'fg_dark', textMuted: 'comment', border: 'fg_gutter', selectedBg: 'bg_visual', primary: 'blue', accent: 'magenta', mdLink: 'cyan', modelHighlight: 'cyan', success: 'green', warning: 'yellow', error: 'red' },
  },
  {
    id: 'catppuccin-latte', name: 'Catppuccin Latte', idea: 'pastels on cream', dark: false, family: 'catppuccin',
    colors: { base: '#EFF1F5', text: '#4C4F69', subtext0: '#6C6F85', overlay1: '#8C8FA1', surface2: '#ACB0BE', surface0: '#CCD0DA', mauve: '#8839EF', pink: '#EA76CB', blue: '#1E66F5', rosewater: '#DC8A78', green: '#40A02B', yellow: '#DF8E1D', red: '#D20F39' },
    roles: { canvas: 'base', text: 'text', textStrong: 'text', muted: 'subtext0', textMuted: 'overlay1', border: 'surface2', selectedBg: 'surface0', primary: 'mauve', accent: 'pink', mdLink: 'blue', modelHighlight: 'rosewater', success: 'green', warning: 'yellow', error: 'red' },
  },
  {
    id: 'everforest-light', name: 'Everforest Light', idea: 'the forest by day', dark: false, family: 'everforest',
    colors: { bg0: '#FDF6E3', fg: '#5C6A72', grey2: '#829181', grey1: '#939F91', bg5: '#BDC3AF', bg_visual: '#EAEDC8', blue: '#3A94C5', purple: '#DF69BA', aqua: '#35A77C', green: '#8DA101', yellow: '#DFA000', red: '#F85552' },
    roles: { canvas: 'bg0', text: 'fg', textStrong: 'fg', muted: 'grey2', textMuted: 'grey1', border: 'bg5', selectedBg: 'bg_visual', primary: 'blue', accent: 'purple', mdLink: 'aqua', modelHighlight: 'aqua', success: 'green', warning: 'yellow', error: 'red' },
  },
  {
    id: 'gruvbox-light', name: 'Gruvbox Light', idea: 'retro groove on cream', dark: false, family: 'gruvbox',
    colors: { light0: '#FBF1C7', dark1: '#3C3836', dark0: '#282828', dark4: '#7C6F64', gray_244: '#928374', light2: '#D5C4A1', light1: '#EBDBB2', faded_blue: '#076678', faded_orange: '#AF3A03', faded_aqua: '#427B58', faded_purple: '#8F3F71', faded_green: '#79740E', faded_yellow: '#B57614', faded_red: '#9D0006' },
    roles: { canvas: 'light0', text: 'dark1', textStrong: 'dark0', muted: 'dark4', textMuted: 'gray_244', border: 'light2', selectedBg: 'light1', primary: 'faded_blue', accent: 'faded_orange', mdLink: 'faded_aqua', modelHighlight: 'faded_purple', success: 'faded_green', warning: 'faded_yellow', error: 'faded_red' },
  },
  {
    id: 'kanagawa-lotus', name: 'Kanagawa Lotus', idea: 'the lotus, ink on rice paper', dark: false, family: 'kanagawa',
    colors: { lotusWhite3: '#F2ECBC', lotusInk1: '#545464', lotusInk2: '#43436C', lotusGray2: '#716E61', lotusGray3: '#8A8980', lotusViolet1: '#A09CAC', lotusViolet3: '#C9CBD1', lotusBlue4: '#4D699B', lotusViolet4: '#624C83', lotusTeal1: '#4E8CA2', lotusAqua: '#597B75', lotusGreen: '#6F894E', lotusOrange2: '#E98A00', lotusRed3: '#E82424' },
    roles: { canvas: 'lotusWhite3', text: 'lotusInk1', textStrong: 'lotusInk2', muted: 'lotusGray2', textMuted: 'lotusGray3', border: 'lotusViolet1', selectedBg: 'lotusViolet3', primary: 'lotusBlue4', accent: 'lotusViolet4', mdLink: 'lotusTeal1', modelHighlight: 'lotusAqua', success: 'lotusGreen', warning: 'lotusOrange2', error: 'lotusRed3' },
  },
  {
    id: 'one-light', name: 'One Light', idea: 'Atom\'s One, on white', dark: false, family: 'one',
    colors: { bg: '#FAFAFA', 'mono-1': '#383A42', 'mono-2': '#696C77', 'mono-3': '#A0A1A7', selection: '#E5E5E6', 'hue-2': '#4078F2', 'hue-3': '#A626A4', 'hue-1': '#0184BC', 'hue-4': '#50A14F', 'hue-6': '#B76B01', 'hue-5': '#E45649' },
    roles: { canvas: 'bg', text: 'mono-1', textStrong: 'mono-1', muted: 'mono-2', textMuted: 'mono-3', border: 'mono-3', selectedBg: 'selection', primary: 'hue-2', accent: 'hue-3', mdLink: 'hue-1', modelHighlight: 'hue-1', success: 'hue-4', warning: 'hue-6', error: 'hue-5' },
  },
  {
    id: 'rose-pine-dawn', name: 'Rosé Pine Dawn', idea: 'iris and rose on parchment', dark: false, family: 'rose-pine',
    colors: { base: '#FAF4ED', text: '#464261', subtle: '#797593', muted: '#9893A5', highlightHigh: '#CECACD', highlightMed: '#DFDAD9', iris: '#907AA9', rose: '#D7827E', foam: '#56949F', pine: '#286983', gold: '#EA9D34', love: '#B4637A' },
    roles: { canvas: 'base', text: 'text', textStrong: 'text', muted: 'subtle', textMuted: 'muted', border: 'highlightHigh', selectedBg: 'highlightMed', primary: 'iris', accent: 'rose', mdLink: 'foam', modelHighlight: 'foam', success: 'pine', warning: 'gold', error: 'love' },
  },
  {
    id: 'solarized-light', name: 'Solarized Light', idea: 'the classic, on beige', dark: false, family: 'solarized',
    colors: { base3: '#FDF6E3', base00: '#657B83', base01: '#586E75', base0: '#839496', base1: '#93A1A1', base2: '#EEE8D5', blue: '#268BD2', violet: '#6C71C4', cyan: '#2AA198', green: '#859900', yellow: '#B58900', red: '#DC322F' },
    roles: { canvas: 'base3', text: 'base00', textStrong: 'base01', muted: 'base0', textMuted: 'base1', border: 'base2', selectedBg: 'base2', primary: 'blue', accent: 'violet', mdLink: 'cyan', modelHighlight: 'base01', success: 'green', warning: 'yellow', error: 'red' },
  },
  {
    id: 'tokyo-night-day', name: 'Tokyo Night Day', idea: 'the city by day, blue ink on grey', dark: false, family: 'tokyo-night',
    colors: { bg: '#E1E2E7', fg: '#3760BF', fg_dark: '#6172B0', comment: '#848CB5', fg_gutter: '#A8AECB', bg_visual: '#B7C1E3', blue: '#2E7DE9', magenta: '#9854F1', cyan: '#007197', green: '#587539', yellow: '#8C6C3E', red: '#F52A65' },
    roles: { canvas: 'bg', text: 'fg', textStrong: 'fg', muted: 'fg_dark', textMuted: 'comment', border: 'fg_gutter', selectedBg: 'bg_visual', primary: 'blue', accent: 'magenta', mdLink: 'cyan', modelHighlight: 'cyan', success: 'green', warning: 'yellow', error: 'red' },
  },]

/** The tokens every palette but the default repeats from its own: Mayfly's aliases. */
export function aliased(own) {
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
    diffMeta: own.muted,
  }
}

/** The contrast each role needs on the background; the rest need none. */
const FLOORS = { text: 4.5, textStrong: 4.5, muted: 4.5, primary: 4.5, accent: 4.5, mdLink: 4.5, modelHighlight: 4.5, success: 4.5, warning: 4.5, error: 4.5, textMuted: 3, border: 1.5 }

/**
 * Lighten (on a dark background) or darken (on a light one) a color in OKLCH until it reads at `ratio`; hue and chroma
 * stay, chroma giving way only where sRGB runs out.
 */
export function nudge(hex, canvas, ratio) {
  if (contrast(hex, canvas) >= ratio) return hex
  const { L, C, H } = oklch(hex)
  const lighter = oklch(canvas).L < 0.5
  for (let step = 1; step <= 400; step += 1) {
    const next = fromOklch(Math.min(1, Math.max(0, L + (lighter ? step : -step) * 0.0025)), C, H)
    if (contrast(next, canvas) >= ratio) return next
  }
  return lighter ? '#FFFFFF' : '#000000'
}

/**
 * The diff band of a status color: the background's own lightness, stepped a little toward the text, tinted with the
 * status hue. The step shrinks (and, past the background, turns away from the text) until `text` keeps 7:1 on it, or,
 * for a scheme whose text reads lower than that on its own background, at most 15% under it and never under 4.5:1.
 */
function band(canvas, status, text, dark) {
  const floor = Math.max(4.5, Math.min(7, contrast(text, canvas) * 0.85))
  const base = oklch(canvas).L
  const hue = oklch(status).H
  for (let step = dark ? 0.07 : 0.05; step >= -0.04; step -= 0.005) {
    const hex = fromOklch(base + (dark ? step : -step), 0.05, hue)
    if (contrast(text, hex) >= floor) return hex
  }
  return fromOklch(base, 0.04, hue)
}

/**
 * A port as a palette: the roles resolved to the scheme's colors, nudged where they fall short, the aliases filled in,
 * and the bands and the mark's inks mixed from them.
 */
export function port(def) {
  const color = role => def.colors[def.roles[role]]
  const canvas = color('canvas')
  const nudges = []
  const own = {}
  for (const role of ['text', 'textStrong', 'muted', 'textMuted', 'accent', 'primary', 'border', 'success', 'error', 'warning', 'mdLink', 'modelHighlight']) {
    const source = color(role)
    const floor = FLOORS[role]
    const hex = floor === undefined ? source : nudge(source, canvas, floor)
    if (hex !== source) nudges.push({ role, from: `${def.roles[role]} ${source}`, to: hex, ratio: Number(contrast(hex, canvas).toFixed(2)) })
    own[role] = hex
  }
  const selectedBg = color('selectedBg')
  return {
    id: def.id,
    name: def.name,
    idea: def.idea,
    dark: def.dark,
    family: def.family,
    origin: 'port',
    canvas,
    foregrounds: aliased(own),
    backgrounds: { selectedBg, diffAddedBg: band(canvas, own.success, own.text, def.dark), diffRemovedBg: band(canvas, own.error, own.text, def.dark) },
    logoInks: [own.primary, mix(own.primary, def.dark ? own.textStrong : canvas, 0.45), ...[0.3, 0.55, 0.75].map(t => mix(own.primary, canvas, t))],
    nudges,
  }
}

/** Every port as a palette, dark ones first. */
export const PORTS = PORT_DEFS.map(port)
