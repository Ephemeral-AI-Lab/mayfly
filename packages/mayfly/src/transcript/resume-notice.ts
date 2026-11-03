/** Shared readonly resumed-session notice text. @module @ephemeral-ai/mayfly/transcript/resume-notice */

import type { MayflyTranslate } from '../frontend/locale.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** The same compact last-active age used by the native session notice. */
function ageText(ms: number, t: MayflyTranslate): string {
  if (ms < MINUTE) return t('just now')
  if (ms < HOUR) return t('{count}m ago', { count: Math.floor(ms / MINUTE) })
  if (ms < DAY) return t('{count}h ago', { count: Math.floor(ms / HOUR) })
  return t('{count}d ago', { count: Math.floor(ms / DAY) })
}

/** Format native history facts without owning selection or notification lifetime. */
export function resumedSessionMessage(turn: number, endedAt: number | undefined, now: number, t: MayflyTranslate): string {
  const turns = turn === 1 ? t('1 turn') : t('{count} turns', { count: turn })
  const age = endedAt === undefined ? undefined : ageText(Math.max(0, now - endedAt), t)
  return [t('Resumed session'), turns, ...age === undefined ? [] : [t('last active {age}', { age })]].join(' · ')
}
