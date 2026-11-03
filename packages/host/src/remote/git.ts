/** Bounded Git badge probes with per-Agent TTL caches and empty-on-failure behavior. @module */
import { execFile } from 'node:child_process'
import type { MayflyGitStatus, MayflyGitTreeStatus } from '../types.ts'
import { frozen } from './json.ts'

export const BRANCH_TTL_MS = 5_000
export const STATUS_TTL_MS = 15_000
export const STATUS_RETRY_MS = 5_000
export const GIT_PROCESS_TIMEOUT_MS = 500

const AHEAD_BEHIND_RE = /\[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\]/
type TreeFacts = Omit<MayflyGitTreeStatus, 'branch'>
type CacheSlots = {
  branch: { value: string | null, fetchedAt: number }
  status: { value: TreeFacts | null, fetchedAt: number }
}
export type GitCommandRunner = (args: readonly string[], cwd: string, signal: AbortSignal) => Promise<string | null>

/** Run one bounded Git process without shell interpolation or stderr output. */
export const runGitCommand: GitCommandRunner = (args, cwd, signal) => new Promise(resolve => {
  execFile('git', [...args], {
    cwd,
    encoding: 'utf8',
    timeout: GIT_PROCESS_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    signal,
  }, (error, stdout) => { resolve(error === null ? stdout : null) })
})

function readStatusDump(output: string): Pick<TreeFacts, 'dirty' | 'ahead' | 'behind'> {
  let dirty = false
  let ahead = 0
  let behind = 0
  for (const line of output.split('\n')) {
    if (line.startsWith('## ')) {
      const match = AHEAD_BEHIND_RE.exec(line)
      if (match !== null) {
        ahead = Number.parseInt(match[1] ?? '0', 10)
        behind = Number.parseInt(match[2] ?? '0', 10)
      }
    } else if (line.trim().length > 0) dirty = true
  }
  return { dirty, ahead, behind }
}

function numstatCount(value: string | undefined): number {
  if (value === undefined || value === '-') return 0
  const count = Number.parseInt(value, 10)
  return Number.isFinite(count) && count > 0 ? count : 0
}

function readNumstatDump(output: string): { added: number, deleted: number } {
  let added = 0
  let deleted = 0
  for (const line of output.split('\n')) {
    if (line === '') continue
    const [addedText, deletedText] = line.split('\t')
    added += numstatCount(addedText)
    deleted += numstatCount(deletedText)
  }
  return { added, deleted }
}

export interface GitBadgeCache {
  /** Read the current badge with caller-owned cancellation and the branch/status TTLs. */
  getStatus(signal: AbortSignal): Promise<MayflyGitStatus | null>
}

/** Create one independent cache; no mutable state is shared between Agents or working directories. */
export function createGitBadgeCache(cwd: string, run: GitCommandRunner = runGitCommand): GitBadgeCache {
  let slots: CacheSlots = {
    branch: { value: null, fetchedAt: 0 },
    status: { value: null, fetchedAt: 0 },
  }
  const probeStatus = async (fetchedAt: number, signal: AbortSignal): Promise<CacheSlots['status']> => {
    const output = await run(['status', '--porcelain', '-b'], cwd, signal)
    if (output === null) return { value: null, fetchedAt }
    signal.throwIfAborted()
    const base = readStatusDump(output)
    const diff = base.dirty
      ? readNumstatDump(await run(['diff', '--numstat', 'HEAD', '--'], cwd, signal) ?? '')
      : { added: 0, deleted: 0 }
    return { value: { ...base, diffAdded: diff.added, diffDeleted: diff.deleted }, fetchedAt }
  }

  const probe = async (signal: AbortSignal): Promise<MayflyGitStatus | null> => {
    signal.throwIfAborted()
    const now = Date.now()
    if (now - slots.branch.fetchedAt >= BRANCH_TTL_MS) {
      const output = await run(['branch', '--show-current'], cwd, signal)
      signal.throwIfAborted()
      slots.branch = { value: output === null || output.trim() === '' ? null : output.trim(), fetchedAt: now }
    }
    if (slots.branch.value === null) return null
    const statusTtl = slots.status.value === null ? STATUS_RETRY_MS : STATUS_TTL_MS
    if (now - slots.status.fetchedAt >= statusTtl) slots.status = await probeStatus(now, signal)
    signal.throwIfAborted()
    if (slots.status.value === null) return frozen({ branch: slots.branch.value, unknown: true })
    return frozen({ branch: slots.branch.value, ...slots.status.value })
  }

  return {
    getStatus: probe,
  }
}
