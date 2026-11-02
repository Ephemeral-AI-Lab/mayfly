/** Recorded delivery metadata and bounded text previews through the exact Host filesystem. @module */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '../conversation/deliverables.ts'
import type {} from '@deepseek-ai/dsh-workspace-changes'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { MayflyDeliveredFileRequest, MayflyDeliveredFileDetail, MayflyLatestWorkspaceChanges, MayflyHostSessionRequest } from '../types.ts'
import { frozen, jsonSnapshot } from './json.ts'
import { requireExactAgent, resolveExactAgent, sessionDirectory } from './session.ts'

/** Frozen rc.2 previews never read more than 256 KiB. */
export const DELIVERED_PREVIEW_LIMIT = 256 * 1024

/** Resolve only a recorded delivery id, never an arbitrary caller-supplied path. */
export async function deliveredFile(ctx: Context, request: MayflyDeliveredFileRequest, signal: AbortSignal): Promise<MayflyDeliveredFileDetail> {
  const agent = await resolveExactAgent(ctx, request.sessionId, signal)
  signal.throwIfAborted()
  const cwd = sessionDirectory(ctx, agent.session)
  const files = () => ctx.sessionProjections.snapshot(agent.session, ['mayflyDeliverables']).values.mayflyDeliverables ?? []
  const file = files().find(candidate => candidate.id === request.deliveryId)
  if (file === undefined) {
    throw new RemoteError('mayflyHost/delivery-unavailable', 'File unavailable', { sessionId: request.sessionId, deliveryId: request.deliveryId })
  }
  const check = (): void => {
    signal.throwIfAborted()
    requireExactAgent(ctx, request.sessionId, agent)
    if (sessionDirectory(ctx, agent.session) !== cwd || !files().some(candidate => candidate.id === file.id && candidate.path === file.path)) {
      throw new RemoteError('mayflyHost/session-stale', 'File delivery changed before the operation completed', { sessionId: request.sessionId })
    }
  }
  const fs = agent.ctx.fs
  const target = await fs.resolve(file.path, { cwd, signal })
  check()
  const stat = await fs.stat(target, signal)
  check()
  const detail: MayflyDeliveredFileDetail = {
    path: fs.processPath(target), displayPath: target.displayPath,
    ...stat === undefined ? {} : { fileType: stat.type, ...stat.size === undefined ? {} : { size: stat.size } },
  }
  if (request.preview !== true || stat?.type !== 'file') return frozen(detail)
  const bytes = await fs.readBytes(target, signal, DELIVERED_PREVIEW_LIMIT)
  check()
  return frozen({ ...detail, preview: bytes.includes(0) ? 'Binary file; use Open in an external application.' : new TextDecoder().decode(bytes) })
}

/** Latest native change summary without activating a Session or reading a second journal. */
export function latestWorkspaceChanges(ctx: Context, request: MayflyHostSessionRequest, signal: AbortSignal): MayflyLatestWorkspaceChanges | null {
  signal.throwIfAborted()
  const session = ctx.sessions.get(request.sessionId)
  const event = session?.snapshotEvents().findLast(candidate => candidate.type === 'workspace/changes')
  if (event === undefined) return null
  const summary = ctx.workspaceChanges.summary(request.sessionId, event.seq)
  return summary === undefined ? null : jsonSnapshot({ seq: event.seq, summary }) ?? null
}
