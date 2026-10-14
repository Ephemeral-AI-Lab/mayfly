/**
 * The translator the notice specs read: the English key with its `{name}` values filled in, the way the locale returns
 * the texts it does not have a translation for.
 * @module transcript-notices-fakes
 */

import type { MayflyTranslate } from '../../src/frontend/locale.ts'

export const transcriptTranslatorFake: MayflyTranslate = (key, values) =>
  key.replace(/\{(\w+)\}/gu, (_, name: string) => String(values?.[name] ?? ''))
