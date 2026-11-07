/**
 * Compact elapsed times of the agent and workflow rows.
 * @module @ephemeral-ai/mayfly/transcript/agent-presentation
 */

/** Compact non-negative duration from elapsed seconds. */
export function compactElapsedSeconds(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  if (safe < 60) return `${String(safe)}s`
  if (safe < 3600) return `${String(Math.floor(safe / 60))}m ${String(safe % 60)}s`
  return `${String(Math.floor(safe / 3600))}h ${String(Math.floor((safe % 3600) / 60))}m ${String(safe % 60)}s`
}

/** Compact non-negative duration from elapsed milliseconds. */
export function compactElapsedMs(ms: number): string {
  return compactElapsedSeconds(ms / 1000)
}
