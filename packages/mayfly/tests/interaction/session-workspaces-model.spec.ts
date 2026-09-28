/** Workspace grouping and unambiguous cwd labels.
 * @module @ephemeral-ai/mayfly/tests/interaction/session-workspaces-model
 */
import { expect, it } from 'vitest'
import type { SessionListHeader } from '../../src/interaction/session-list-reads.ts'
import { sessionWorkspaceId, sessionWorkspaceItem, sessionWorkspaceLabel, sessionWorkspaces } from '../../src/interaction/session-workspaces-model.ts'
const t = (key: string, values?: Readonly<Record<string, string | number>>) => key.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name]))
const record = (cwd: string | undefined, createdAt: number): SessionListHeader => ({ header: { cwd, createdAt } } as never)

it('groups exact directories, counts sessions, and ranks the current workspace first', () => {
  const result = sessionWorkspaces([
    record('/old/current', 1), record('/new/repo', 30), record('/new/repo', 40), record('/other/repo', 20), record(undefined, 0),
  ], '/old/current')
  expect(result.map(item => [item.cwd, item.count, item.createdAt])).toEqual([
    ['/old/current', 1, 1], ['/new/repo', 2, 40], ['/other/repo', 1, 20], [undefined, 1, 0],
  ])
  expect(sessionWorkspaceId(undefined)).not.toBe(sessionWorkspaceId('null'))
  expect(sessionWorkspaceId('/a/repo')).not.toBe(sessionWorkspaceId('/b/repo'))
  expect(sessionWorkspaces([], undefined)).toEqual([])
})

it('breaks timestamp ties by stable workspace identity and preserves newer group timestamps', () => {
  expect(sessionWorkspaces([record('/b', 20), record('/a', 20), record('/b', 10)], '/other').map(item => item.cwd)).toEqual(['/a', '/b'])
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

it('shows counts and the current directory badge while filtering by the full cwd', () => {
  const groups = sessionWorkspaces([record('/home/dev/a', 1), record('/home/dev/b', 2), record('/home/dev/b', 3), record(undefined, 0)], '/home/dev/a')
  expect(sessionWorkspaceItem(groups[0]!, '/home/dev/a', '/home/dev', t)).toMatchObject({ label: '~/a', detail: '1 session', badge: 'current', searchText: '/home/dev/a' })
  expect(sessionWorkspaceItem(groups[1]!, '/home/dev/a', '/home/dev', t)).toMatchObject({ label: '~/b', detail: '2 sessions' })
  expect(sessionWorkspaceItem(groups[2]!, '/home/dev/a', '/home/dev', t).searchText).toBe('No working directory')
})
