/** JSON detachment and immutable DTO helpers for Host Remote providers. @module */
import { deepFreeze, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'

/** Freeze one client-safe DTO graph without retaining a mutable producer alias. */
export function frozen<T>(value: T): T {
  return deepFreeze(value)
}

/** Detach and freeze lossless JSON, returning undefined for values that cannot cross Remote unchanged. */
export function jsonSnapshot<T>(value: T): T | undefined {
  const snapshot = snapshotJsonValue(value)
  return snapshot === undefined ? undefined : deepFreeze(snapshot)
}
