/** Core interaction strings and the pure fallback translator used when no locale service is bound.
 * @module @ephemeral-ai/mayfly/core/ui-interaction-locale
 */

export type UiTranslateValues = Readonly<Record<string, string | number>>
export type UiTranslate = (key: string, values?: UiTranslateValues) => string

/** Interpolate `{name}` placeholders without a catalog. */
export const untranslated: UiTranslate = (key, values) => values === undefined
  ? key
  : key.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu, (placeholder, name: string) => values[name] === undefined ? placeholder : String(values[name]))
