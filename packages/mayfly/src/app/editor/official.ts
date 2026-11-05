/**
 * Narrow declarations for official editor Remote events missing from nested handoffs.
 * @module @ephemeral-ai/mayfly/remote/editor/official
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HostClient } from '../../client/types.ts'

/** Official `(sessionId, agentPreset)` notification listener. */
export type AgentPresetSelectedListener = (sessionId: SessionId, agentPreset: string) => void

/** Subscribe to the official preset-selection event without changing its payload or dispatch semantics. */
export function onAgentPresetSelected(client: HostClient, listener: AgentPresetSelectedListener): () => void {
  const remote = client.remote as HostClient['remote'] & {
    $on(event: 'agent-preset/selected', listener: AgentPresetSelectedListener): () => void
  }
  return remote.$on('agent-preset/selected', listener)
}
