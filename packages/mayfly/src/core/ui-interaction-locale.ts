/** Core interaction strings and the pure fallback translator used when no locale service is bound.
 * @module @ephemeral-ai/mayfly/core/ui-interaction-locale
 */

import { interpolateLocaleMessage } from '../frontend/locale.ts'

export type UiTranslateValues = Readonly<Record<string, string | number>>
export type UiTranslate = (key: string, values?: UiTranslateValues) => string

/** Interpolate `{name}` placeholders without a catalog. */
export const untranslated: UiTranslate = (key, values) => interpolateLocaleMessage(key, values)
