/** Native Workspace identity, membership, and fallback rows for `/sessions`.
 * @module @ephemeral-ai/mayfly/tests/interaction/session-workspaces-model
 */
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { expect, it, vi } from 'vitest'
import {
  sessionWorkspaceItem, sessionWorkspaceLabel, sessionWorkspacePlacements, sessionWorkspaces, type WorkspaceResolver,
} from '../../src/interaction/session-workspaces-model.ts'

const t = (key: string, values?: Readonly<Record<string, string | number>>) => key.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name]))

function workspace(id: string, path: string, sessionIds: readonly string[] = [], title = path): Workspace {
  return { id: id as WorkspaceId, path, title, sessionIds, createdAt: '', updatedAt: '', archive: vi.fn() } as unknown as Workspace
}

function summary(id: string, cwd: string | undefined, updatedAt = 10): SessionSummary {
  return { sessionId: SessionId(id), cwd, updatedAt, running: false, blank: false, agentAvailable: false } as unknown as SessionSummary
}

function resolverOf(workspaces: readonly Workspace[], resolved: ReadonlyMap<string, Workspace> = new Map()): WorkspaceResolver & { resolveByPath: ReturnType<typeof vi.fn> } {
  return {
    list: () => workspaces,
    resolveByPath: vi.fn(async (path: string) => resolved.get(path)),
  }
}

it('places Sessions by native membership, then exact path, then canonical resolution', async () => {
  const alpha = workspace('alpha', '/repo/a', ['session-member'], 'Alpha')
  const beta = workspace('beta', '/repo/b', [], 'Beta')
  const resolver = resolverOf([alpha, beta], new Map([['/repo/b-link', beta]]))
  const placements = await sessionWorkspacePlacements(resolver, [
    summary('session-member', '/elsewhere'),
    summary('session-exact', '/repo/b'),
    summary('session-link', '/repo/b-link'),
    summary('session-unowned', '/repo/other'),
    summary('session-cwdless', undefined),
  ])
  expect([...placements]).toEqual([['session-member', 'alpha'], ['session-exact', 'beta'], ['session-link', 'beta']])
  expect(resolver.resolveByPath).toHaveBeenCalledWith('/repo/b-link')
  expect(resolver.resolveByPath).toHaveBeenCalledWith('/repo/other')
})

it('resolves each distinct canonical path once and treats a resolution failure as unowned', async () => {
  const resolver = resolverOf([])
  resolver.resolveByPath
    .mockRejectedValueOnce(new Error('missing directory'))
    .mockResolvedValueOnce(undefined)
  const placements = await sessionWorkspacePlacements(resolver, [
    summary('one', '/gone'), summary('two', '/gone'), summary('three', '/plain'),
  ])
  expect(placements.size).toBe(0)
  expect(resolver.resolveByPath).toHaveBeenCalledTimes(2)
})

it('keeps registry order, counts native members, flags the current workspace, and adds one fallback row', () => {
  const alpha = workspace('alpha', '/repo/a', [], 'Alpha')
  const beta = workspace('beta', '/repo/b', [], 'Beta')
  const groups = sessionWorkspaces([alpha, beta], [
    summary('one', '/repo/a', 10), summary('two', '/repo/b', 50), summary('three', '/repo/b', 40), summary('free', '/elsewhere', 30),
  ], new Map<string, WorkspaceId>([['one', 'alpha' as WorkspaceId], ['two', 'beta' as WorkspaceId], ['three', 'beta' as WorkspaceId]]), 'beta' as WorkspaceId)
  expect(groups.map(group => [group.workspaceId, group.count, group.current])).toEqual([
    ['alpha', 1, undefined], ['beta', 2, true], [undefined, 1, undefined],
  ])
  expect(groups[2]).toMatchObject({ id: 'workspace:unregistered', label: 'Other sessions', createdAt: 30 })
  expect(sessionWorkspaces([alpha], [], new Map(), 'alpha' as WorkspaceId).map(group => group.count)).toEqual([0])
})

it('keeps full paths distinct and only abbreviates the home directory', () => {
  expect(sessionWorkspaceLabel('/home/dev', '/home/dev', t)).toBe('~')
  expect(sessionWorkspaceLabel('/home/dev/a/b/c/d', '/home/dev', t)).toBe('~/a/b/c/d')
  expect(sessionWorkspaceLabel('/home', '/home/dev', t)).toBe('/home')
  expect(sessionWorkspaceLabel('/other/a/b/c/d', '/home/dev', t)).toBe('/other/a/b/c/d')
  expect(sessionWorkspaceLabel('/home/dev/repo', '', t)).toBe('/home/dev/repo')
  expect(sessionWorkspaceLabel(undefined, '/home/dev', t)).toBe('No working directory')
  expect(sessionWorkspaceLabel('D:\\repo', 'C:\\Users\\dev', t, 'win32')).toBe('D:/repo')
})

it('shows the native title and count, filters by the full path, and marks the current workspace', () => {
  const alpha = workspace('alpha', '/home/dev/a', [], 'Alpha')
  const beta = workspace('beta', '/home/dev/b', [], 'Beta')
  const groups = sessionWorkspaces([alpha, beta], [
    summary('one', '/home/dev/a'), summary('two', '/home/dev/b'), summary('three', '/home/dev/b'),
  ], new Map<string, WorkspaceId>([['one', 'alpha' as WorkspaceId], ['two', 'beta' as WorkspaceId], ['three', 'beta' as WorkspaceId]]), 'alpha' as WorkspaceId)
  expect(sessionWorkspaceItem(groups[0]!, '/home/dev/a', '/home/dev', t)).toMatchObject({
    label: 'Alpha', detail: '1 session', current: true, searchText: '/home/dev/a',
  })
  expect(sessionWorkspaceItem(groups[1]!, '/home/dev/a', '/home/dev', t)).toMatchObject({ label: 'Beta', detail: '2 sessions' })
  expect(sessionWorkspaceItem(groups[1]!, '/home/dev/a', '/home/dev', t).current).toBeUndefined()
})

it('localizes the fallback row and falls back to the shortened path without a native title', () => {
  const groups = sessionWorkspaces([], [summary('free', '/home/dev/x')], new Map())
  const item = sessionWorkspaceItem(groups[0]!, '/home/dev/x', '/home/dev', (key, values) => key === 'Other sessions' ? '其他会话' : t(key, values))
  expect(item).toMatchObject({ id: 'workspace:unregistered', label: '其他会话', detail: '1 session' })
  const untitled = { id: 'workspace:x', cwd: '/home/dev/x', count: 2, createdAt: 1 }
  expect(sessionWorkspaceItem(untitled, undefined, '/home/dev', t)).toMatchObject({ label: '~/x', detail: '2 sessions' })
})
