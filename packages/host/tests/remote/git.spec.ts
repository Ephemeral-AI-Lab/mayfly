/**
 * Decision tests for the Git badge cache: parse decisions, TTL behaviour, and
 * empty-on-failure, all through an injected command runner.
 * @module
 */
import { describe, expect, it, vi } from 'vitest'
import {
  BRANCH_TTL_MS,
  STATUS_RETRY_MS,
  STATUS_TTL_MS,
  createGitBadgeCache,
  type GitCommandRunner,
} from '../../src/remote/git.ts'

/** A runner answering per-command and counting every invocation. */
function runner(scripts: Partial<Record<string, string | null>>): {
  readonly run: GitCommandRunner
  readonly calls: string[][]
} {
  const calls: string[][] = []
  const run: GitCommandRunner = (args): Promise<string | null> => {
    calls.push([...args])
    const key = args.join(' ')
    const value = Object.prototype.hasOwnProperty.call(scripts, key) ? scripts[key] : null
    return Promise.resolve(value === undefined ? null : value)
  }
  return { run, calls }
}

/** The porcelain header line of a branch tracking a remote. */
function header(ahead?: number, behind?: number): string {
  const marks = [
    ...(ahead === undefined ? [] : [`ahead ${String(ahead)}`]),
    ...(behind === undefined ? [] : [`behind ${String(behind)}`]),
  ].join(', ')
  return `## main...origin/main${marks === '' ? '' : ` [${marks}]`}`
}

describe('createGitBadgeCache', () => {
  it('reports a clean tree with its branch and ahead/behind', async () => {
    const { run } = runner({
      'branch --show-current': 'main\n',
      'status --porcelain -b': `${header(2, 1)}\n`,
    })
    const cache = createGitBadgeCache('/work', run)
    expect(await cache.getStatus(new AbortController().signal)).toEqual({
      branch: 'main', dirty: false, ahead: 2, behind: 1, diffAdded: 0, diffDeleted: 0,
    })
  })

  it('marks the tree dirty and sums numstat when there are changes', async () => {
    const { run } = runner({
      'branch --show-current': 'main\n',
      'status --porcelain -b': `${header()}\n M src/a.ts\n?? new.ts\n`,
      'diff --numstat HEAD --': '10\t2\tsrc/a.ts\n-\t-\tbinary.png\n',
    })
    const cache = createGitBadgeCache('/work', run)
    expect(await cache.getStatus(new AbortController().signal)).toMatchObject({
      dirty: true, diffAdded: 10, diffDeleted: 2,
    })
  })

  it('answers unknown on a detached head or a failed branch probe', async () => {
    const detached = createGitBadgeCache('/work', runner({ 'branch --show-current': '\n' }).run)
    expect(await detached.getStatus(new AbortController().signal)).toBeNull()
    const failed = createGitBadgeCache('/work', runner({}).run)
    expect(await failed.getStatus(new AbortController().signal)).toBeNull()
  })

  it('answers unknown-but-named when the status probe fails after the branch succeeded', async () => {
    const { run } = runner({ 'branch --show-current': 'main\n' })
    const cache = createGitBadgeCache('/work', run)
    expect(await cache.getStatus(new AbortController().signal)).toEqual({ branch: 'main', unknown: true })
  })

  it('serves the cached branch within its TTL and re-probes status only after its own', async () => {
    const { run, calls } = runner({
      'branch --show-current': 'main\n',
      'status --porcelain -b': `${header()}\n`,
    })
    const cache = createGitBadgeCache('/work', run)
    await cache.getStatus(new AbortController().signal)
    const first = calls.length
    // Within both TTLs nothing runs again.
    await cache.getStatus(new AbortController().signal)
    expect(calls.length).toBe(first)
    // After the branch TTL the branch probe runs again; the status stays fresh.
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + BRANCH_TTL_MS + 1) as unknown as () => number
    try {
      await cache.getStatus(new AbortController().signal)
    } finally {
      (now as unknown as { mockRestore: () => void }).mockRestore()
    }
    expect(calls.filter(args => args[0] === 'branch')).toHaveLength(2)
    expect(calls.filter(args => args[0] === 'status')).toHaveLength(1)
  })

  it('retries a failed status on the short retry interval, not the full TTL', async () => {
    let statusFails = true
    const calls: string[][] = []
    const run: GitCommandRunner = (args): Promise<string | null> => {
      calls.push([...args])
      if (args[0] === 'status' && statusFails) return Promise.resolve(null)
      if (args[0] === 'status') return Promise.resolve(`${header()}\n`)
      return Promise.resolve('main\n')
    }
    const cache = createGitBadgeCache('/work', run)
    await cache.getStatus(new AbortController().signal)
    const spy = vi.spyOn(Date, 'now')
    spy.mockReturnValue(Date.now() + STATUS_RETRY_MS + 1)
    try {
      await cache.getStatus(new AbortController().signal)
    } finally {
      spy.mockRestore()
    }
    // The failed status re-probed on the retry interval.
    expect(calls.filter(args => args[0] === 'status')).toHaveLength(2)
    void STATUS_TTL_MS
  })

  it('refuses to start on an aborted signal', async () => {
    const { run, calls } = runner({ 'branch --show-current': 'main\n' })
    const cache = createGitBadgeCache('/work', run)
    const controller = new AbortController()
    controller.abort()
    await expect(cache.getStatus(controller.signal)).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})
