# Theming

Every visual surface in Mayfly is driven by one **semantic color table**. The `/theme` command hot-switches between providers of that table — a switch rebuilds the render tree, but your input draft, history, and input mode survive through a draft stash.

## /theme usage

```
usage: /theme [dark|light|tide|dusk|linen|mist|graphite|heather|obsidian|porcelain|auto|custom <path> [dark|light|tide|dusk|linen|mist|graphite|heather|obsidian|porcelain]]
```

- `/theme` — a picker of every built-in palette by name, each with a one-line description, the live one checked (`✓`)
- `/theme <key>` — switch to a built-in palette, for example `/theme tide`
- `/theme auto` — follow the terminal background (OSC 11 detection): Mayfly Dark or Mayfly Light
- `/theme custom <path> [<base>]` — mount a file palette over a built-in `base` (default `dark`)

A switch replaces the provider's fiber wholesale; theme-dependent plugins (transcript, input) reload with it. A failed mount falls back to Mayfly Dark — the UI is never left without a theme.

## Built-in palettes

Every palette follows one recipe: four neutral inks of one quiet hue, one brand hue for `primary` and the tokens around it, and the status colors (green, amber, red) kept apart from the brand. Each is designed for a terminal background (its canvas); themes paint no background, so set your terminal to it for the intended look.

| key | name | style | canvas |
| --- | --- | --- | --- |
| `dark` | Mayfly Dark | the default violet: slate ink on near-black | `#0A0A0C` |
| `light` | Mayfly Light | the default on white | `#FFFFFF` |
| `tide` | Tide | deep water, an aqua brand | `#08191D` |
| `dusk` | Dusk | warm plum, an orchid brand | `#1B1118` |
| `graphite` | Graphite | neutral greys, a cobalt brand | `#141414` |
| `linen` | Linen | ink on paper: warm grey on cream, an ink-blue brand | `#F8F3E9` |
| `mist` | Mist | teal on a pale blue-white | `#F3F8FA` |
| `heather` | Heather | lilac-grey, a plum brand | `#F8F4F9` |
| `obsidian` | Obsidian | high contrast on black: every tone at 7:1 or more | `#000000` |
| `porcelain` | Porcelain | high contrast on white: every tone at 7:1 or more | `#FFFFFF` |

`auto` is not a palette of its own — it picks between Mayfly Dark and Mayfly Light from the terminal background; `custom` is covered below.

## The persisted default theme

`/theme` switches the theme **for the session**; the persisted default lives in the `mayfly:` section of settings.yaml (or the `/settings` panel's Theme row — it lists the palettes by name, applies live, and writes through):

```yaml
mayfly:
  theme: tide   # dark | light | tide | dusk | linen | mist | graphite | heather | obsidian | porcelain | auto
```

The default applies at startup; an in-session `/theme` pick overrides it, and unrelated settings writes never stomp that pick. A saved value that names no palette (`ocean` or `paper` from an earlier version) starts on Mayfly Dark and leaves every other setting as it is. Custom palettes (`/theme custom <path>`) stay session-only — they never persist.

## custom: JSON palettes

The custom theme reads a JSON file mapping tokens to `#rrggbb` hexes, layered over a `base` (any built-in palette key):

```json
{
  "primary": "#9A86E6",
  "accent": "#C9C0F0",
  "roleUser": "#9A86E6",
  "selectedBg": "#2b2b30"
}
```

Rules:

- only write the tokens you want to override; the rest fall through to base;
- **unknown tokens** (not in the table below, nor `logoInks`) and **invalid colors** (not `#rrggbb`) are dropped with a warning, falling back to the base entry;
- `logoInks` is the only token taking an array — exactly five `#rrggbb` hexes painting the banner mark: its body, its wings, then the fly-in's trail from the nearest pixel to the farthest;
- `selectedBg`, `diffAddedBg`, and `diffRemovedBg` paint backgrounds; every other color token paints a foreground;
- an unreadable or non-object file falls back to the whole base palette.

## Semantic tokens

Reference values from Mayfly Dark (every palette has its own; auto picks between Mayfly Dark and Mayfly Light per OSC 11):

### Base

| token | dark | used for |
| --- | --- | --- |
| `text` | `#EDEDF2` | body text, brightest footer tier (model, context) |
| `textStrong` | `#F5F5F7` | emphasized text |
| `muted` | `#9AA3B8` | secondary text, middle footer tier (cwd, git badge) |
| `textMuted` | `#5C6476` | dimmest tier (tool summary lines, tips, code-block borders) |
| `accent` | `#C9C0F0` | secondary highlight (pointers, secondary emphasis) |
| `primary` | `#9A86E6` | primary (slash-context editor frame, running tool dot, links) |
| `border` | `#45406B` | regular borders |
| `success` | `#4ec87e` | success |
| `error` | `#e85454` | error |
| `warning` | `#e8a838` | warning |
| `selectedBg` | `#2b2b30` | selected list-row background |
| `roleUser` | `#9A86E6` | user-message `»` rail |
| `shellMode` | `#C9C0F0` | `!` bash mode (editor frame, `$ ` prefix) |
| `modelHighlight` | `#E9E6F4` | banner model-row highlight |
| `logoInks` | `#9A86E6` … | the banner mark: body, wings, three trail shades |

### Markdown

| token | dark | used for |
| --- | --- | --- |
| `mdHeading` | `#F5F5F7` | headings |
| `mdLink` | `#B9A9F0` | link text |
| `mdLinkUrl` | `#5C6476` | link URLs |
| `mdCode` | `#C9C0F0` | inline code |
| `mdCodeBlock` | `#EDEDF2` | code-block body |
| `mdCodeBlockBorder` | `#45406B` | code-block border |
| `mdQuote` | `#9AA3B8` | quote text |
| `mdQuoteBorder` | `#5C6476` | quote bar |
| `mdHr` | `#45406B` | horizontal rules |
| `mdListBullet` | `#C9C0F0` | list bullets |

### Diff

| token | dark | used for |
| --- | --- | --- |
| `diffAdded` | `#4ec87e` | added-line `+` sign |
| `diffRemoved` | `#e85454` | removed-line `-` sign |
| `diffAddedBg` | `#1E3A2B` | added-line background band |
| `diffRemovedBg` | `#43232A` | removed-line background band |
| `diffMeta` | `#9AA3B8` | diff file headers |
