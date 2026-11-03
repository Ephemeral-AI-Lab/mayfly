/** Native per-turn workspace changes and canonical workspace path resolution. @module */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-workspace-changes'
import type { MayflyWorkspace, MayflyWorkspaceChangesSummaryResult, MayflyWorkspaceDiffRequest, MayflyWorkspaceFileDiffResult, MayflyWorkspaceChangesRequest, MayflyWorkspacePathRequest } from '../types.ts'
import { frozen, jsonSnapshot } from './json.ts'

/** Read a native summary without activating a Session. */
export function workspaceChangesSummary(ctx: Context, request: MayflyWorkspaceChangesRequest, signal: AbortSignal): MayflyWorkspaceChangesSummaryResult {
  signal.throwIfAborted()
  return jsonSnapshot(ctx.workspaceChanges.summary(request.sessionId, request.seq)) ?? null
}

/** Read a native comparison with caller cancellation, without activating a Session. */
export async function workspaceChangesDiff(ctx: Context, request: MayflyWorkspaceDiffRequest, signal: AbortSignal): Promise<MayflyWorkspaceFileDiffResult> {
  signal.throwIfAborted()
  const diff = await ctx.workspaceChanges.diff(request.sessionId, request.seq, request.index, signal)
  signal.throwIfAborted()
  return jsonSnapshot(diff) ?? null
}

/** Resolve an existing workspace by canonical path; unresolved paths remain unowned. */
export async function workspacePath(ctx: Context, request: MayflyWorkspacePathRequest, signal: AbortSignal): Promise<MayflyWorkspace | null> {
  signal.throwIfAborted()
  try {
    const workspace = await ctx.workspaceRegistry.resolveByPath(request.path)
    signal.throwIfAborted()
    return workspace === undefined ? null : frozen({ id: String(workspace.id), path: workspace.path, title: workspace.title })
  } catch {
    if (signal.aborted) throw signal.reason
    return null
  }
}
