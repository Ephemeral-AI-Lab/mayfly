/**
 * Color math for the palette sketches: WCAG contrast, OKLCH both ways, and sRGB mixing. Shared by
 * `theme-palettes.mjs` and `theme-ports.mjs`; imports nothing.
 *
 * @module docs/design/prototypes/color
 */

const channel = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
const linear = value => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const gamma = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

/** The 0-255 channels of a `#rrggbb` color. */
export const rgbOf = channel

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

/** Linear sRGB of an OKLCH color, possibly out of gamut. */
function linearOf(L, C, H) {
  const a = C * Math.cos(H * Math.PI / 180), b = C * Math.sin(H * Math.PI / 180)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s]
}

/** An OKLCH color as `#RRGGBB`, its chroma reduced until it fits sRGB. */
export function fromOklch(L, C, H) {
  for (let c = C; ; c -= 0.002) {
    const rgb = linearOf(L, Math.max(0, c), H)
    if (c <= 0 || rgb.every(v => v >= -1e-4 && v <= 1 + 1e-4)) {
      return `#${rgb.map(v => Math.round(Math.min(1, Math.max(0, gamma(Math.min(1, Math.max(0, v))))) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`
    }
  }
}

/** The angle between two hues, 0 to 180. */
export const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d }

/** Mix two colors in sRGB, `t` of the way from `a` to `b`. */
export function mix(a, b, t) {
  const [x, y] = [channel(a), channel(b)]
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('').toUpperCase()}`
}
