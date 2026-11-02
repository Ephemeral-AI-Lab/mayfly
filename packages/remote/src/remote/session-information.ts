/** Readonly information from the exact native Client snapshots. @module remote/session-information */
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionInfoFacts } from '@ephemeral-ai/mayfly/command-panels'
import type { RemotePresentationFacts } from '../transcript/remote-model.ts'

/** Native projection faces observed by the shared reference context document. */
export const REMOTE_SESSION_INFO_KEYS = ['tokenUsage', 'contextPressure', 'contextBreakdown', 'modelSelection'] as const

/** Exactly the readonly fields the reference context presentation consumes. */
export type RemoteSessionUsageFacts = Pick<SessionInfoFacts, 'model' | 'usage' | 'composition'>

/** A live exact-selection reader; the panel owns only its subscription. */
export interface RemoteContextPanelSource {
  read(): RemoteSessionUsageFacts | undefined
  subscribe(listener: () => void): () => void
}

interface InfoProjections {
  readonly tokenUsage?: { readonly uncachedInputTokens: number, readonly cacheReadTokens: number, readonly cacheWriteTokens: number, readonly outputTokens: number }
  readonly contextPressure?: { readonly projectedTokens?: number, readonly pressureTokens?: number, readonly contextWindow?: number }
  readonly contextBreakdown?: { readonly systemTokens: number, readonly toolsTokens: number, readonly messageTokens: number }
  readonly modelSelection?: { readonly next?: SessionInfoFacts['model'], readonly lastUsed?: SessionInfoFacts['model'] }
}

/** Adapt native projection values without replaying events or retaining a second domain state. */
export function remoteSessionInformation(
  binding: SessionBinding,
  presentation: RemotePresentationFacts,
): RemoteSessionUsageFacts {
  const values = Object.fromEntries(REMOTE_SESSION_INFO_KEYS.map(key => [key, binding.session.projections.faceOf(key).getSnapshot()])) as InfoProjections
  const usage = values.tokenUsage
  const pressure = values.contextPressure
  const breakdown = values.contextBreakdown
  const model = values.modelSelection?.next ?? values.modelSelection?.lastUsed
    ?? (presentation.model === undefined || presentation.provider === undefined ? undefined : { model: presentation.model, provider: presentation.provider })
  return {
    ...model === undefined ? {} : { model },
    usage: {
      buckets: { input: usage?.uncachedInputTokens ?? 0, cacheRead: usage?.cacheReadTokens ?? 0, cacheWrite: usage?.cacheWriteTokens ?? 0, output: usage?.outputTokens ?? 0 },
      context: {
        ...pressure?.projectedTokens === undefined && pressure?.pressureTokens === undefined ? {} : { used: pressure.projectedTokens ?? pressure.pressureTokens },
        ...pressure?.contextWindow === undefined ? {} : { window: pressure.contextWindow },
      },
    },
    ...breakdown === undefined ? {} : { composition: { system: breakdown.systemTokens, tools: breakdown.toolsTokens, messages: breakdown.messageTokens } },
  }
}
