# Theming

Every visual surface in Mayfly is driven by one **semantic color table**. The `/theme` command hot-switches between providers of that table — a switch rebuilds the render tree, but your input draft, history, and input mode survive through a draft stash.

## /theme usage

```
usage: /theme [dark|light|ocean|paper|auto|custom <path> [dark|light|ocean|paper]]
```

- `/theme` — list every theme and mark the current one (`dark, light, ocean, paper, auto, custom`)
- `/theme dark` / `/theme light` / `/theme ocean` / `/theme paper` — switch to a built-in palette
- `/theme auto` — follow the terminal background (OSC 11 detection)
- `/theme custom <path> [dark|light]` — mount a file palette, with `base` as the fallback (default `dark`)

A switch replaces the provider's fiber wholesale; theme-dependent plugins (transcript, input) reload with it. A failed mount falls back to the built-in dark palette — the UI is never left without a theme.

## Built-in palettes

| key | style |
| --- | --- |
| `dark` | the default dark (near-black canvas, brand-violet gradient mayfly mark, violet primary) |
| `light` | light (GitHub primer family, one gray tier deeper so it never reads pale) |
| `ocean` | blue-tinted dark (sky-blue primary, teal accent) |
| `paper` | warm light (burnt-orange primary, ink-teal accent) |

`auto` is not a palette of its own — it picks between `dark` and `light` from the terminal background; `custom` is covered below.

## The persisted default theme

`/theme` switches the theme **for the session**; the persisted default lives in the `mayfly:` section of settings.yaml (or the `/settings` panel's Theme row — it cycles the value, applies live, and writes through):

```yaml
mayfly:
  theme: ocean   # dark | light | ocean | paper | auto
```

The default applies at startup; an in-session `/theme` pick overrides it, and unrelated settings writes never stomp that pick. Custom palettes (`/theme custom <path>`) stay session-only — they never persist.

## custom: JSON palettes

The custom theme reads a JSON file mapping tokens to `#rrggbb` hexes, layered over a `base` (dark or light):

```json
{
  "primary": "#9A86E6",
  "accent": "#C9C0F0",
  "roleUser": "#9A86E6",
  "selectedBg": "#221E38"
}
```

Rules:

- only write the tokens you want to override; the rest fall through to base;
- **unknown tokens** (not in the table below, nor `logoGradient`) and **invalid colors** (not `#rrggbb`) are dropped with a warning, falling back to the base entry;
- `logoGradient` is the only token taking an array — a non-empty list of `#rrggbb` hexes painting the banner logo row by row, top to bottom;
- an unreadable or non-object file falls back to the whole base palette.

## Semantic tokens

Reference values from the dark palette (light/ocean/paper have their own; auto picks between dark and light per OSC 11):

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
| `borderFocus` | `#DCD7F2` | focused border (approval panel rule) |
| `success` | `#4ec87e` | success |
| `error` | `#e85454` | error |
| `warning` | `#e8a838` | warning |
| `selectedBg` | `#221E38` | selected list-row background |
| `roleUser` | `#9A86E6` | user-message `»` rail |
| `shellMode` | `#C9C0F0` | `!` bash mode (editor frame, `$ ` prefix) |
| `modelHighlight` | `#E9E6F4` | banner model-row highlight |

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
| `diffAdded` | `#4ec87e` | added lines |
| `diffRemoved` | `#e85454` | removed lines |
| `diffAddedStrong` | `#7ad99b` | added lines (strong) |
| `diffRemovedStrong` | `#f08585` | removed lines (strong) |
| `diffGutter` | `#5C6476` | diff gutter |
| `diffMeta` | `#9AA3B8` | diff file headers |
