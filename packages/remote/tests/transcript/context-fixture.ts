/** Whole native snapshot fixtures for exact displayed-parent transcript context. @module */
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostKey, type SessionRef } from '../../src/client/types.ts'
import type { RemoteSessionFactsSnapshot } from '../../src/frontend/session-facts.ts'

export const ref: SessionRef = { host: HostKey('host-one'), sessionId: SessionId('parent') }

export function facts(values: Readonly<Record<string, unknown>> = {}, selected: SessionRef | undefined = ref): RemoteSessionFactsSnapshot {
  return { ref: selected, cwd: '/native', session: undefined, values, queue: [] }
}

export function summary(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id: SessionId(id), displayTitle: id, running: false, updatedAt: 1, blank: false, retainedBy: {}, parentId: ref.sessionId, ...extra }
}

export function catalog(rows: readonly SessionSummary[] = []): SessionListState {
  return { ids: rows.map(row => row.id), byId: Object.fromEntries(rows.map(row => [row.id, row])), phase: 'ready', projectionsBySession: {} }
}
