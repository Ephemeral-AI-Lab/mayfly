/** Readonly statistics snapshots; native logs and leases remain on Host. @module */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** The four native usage buckets, with invalid provider counts normalised on Host. */
export interface MayflyStatsBuckets {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** One provider/model's usage on one Host-local day. */
export interface MayflyStatsModelDay {
  readonly provider: string
  readonly model: string
  readonly peak: MayflyStatsBuckets
  readonly offPeak: MayflyStatsBuckets
}

/** Serializable equivalent of the rc.2 statistics digest. */
export interface MayflyStatsDigest {
  readonly id: string
  readonly cwd?: string | undefined
  readonly firstAt: number
  readonly lastAt: number
  readonly days: readonly {
    readonly key: string
    readonly turns: number
    readonly models: readonly MayflyStatsModelDay[]
  }[]
}

/** Exact selected Session and its immutable creation metadata. */
export interface MayflyStatsSession {
  readonly status: string
  readonly harnessVersion: string
  readonly createdAt: number
  readonly cwd?: string | undefined
  readonly digest?: MayflyStatsDigest | undefined
}

/** Native listing progress plus the complete digests available at that cursor. */
export interface MayflyStatsHistory {
  readonly running: boolean
  readonly done: number
  readonly total: number
  readonly skipped: number
  readonly failed: number
  readonly digests: readonly MayflyStatsDigest[]
}

/** The Session supplies the workspace when the user selects this workspace. */
export interface MayflyStatsHistoryRequest {
  readonly sessionId: SessionId
  readonly allWorkspaces: boolean
}
