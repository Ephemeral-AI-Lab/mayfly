/**
 * Selected-Session facts read from official Client Session and projection snapshots.
 * @module @ephemeral-ai/mayfly/frontend/session-facts
 */
import type {
  SessionBinding, SessionProjectionMap, SessionSnapshot,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionRef } from '../client/types.ts'

/** Selected Session identity and its catalog directory fallback. */
export interface RemotePresentationSelection {
  readonly ref: SessionRef
  readonly cwd: string
}

/** Projection keys consumed by the published Mayfly status, dock, and pane surfaces. */
export const REMOTE_SESSION_PROJECTION_KEYS = [
  'title',
  'workingDirectory',
  'modelSelection',
  'contextPressure',
  'contextBreakdown',
  'tokenUsage',
  'permissions',
  'inbox',
  'todos',
  'plan',
  'goal',
  'sessionStats',
  'turnOutline',
  'subagent',
  'subagentCatalog',
  'subagentTiming',
  'userQuestions',
  'mayflyConversation',
  'mayflyConversationFacts',
] as const

/** One human-authored pending Inbox row, projected only for presentation. */
export interface RemoteQueueItem {
  readonly id: string
  readonly text: string
  readonly lane: 'turn' | 'step'
}

/** Immutable selected-Session data consumed by footer, Queue, Todo, Plan, Goal, and Agent panes. */
export interface RemoteSessionFactsSnapshot {
  readonly ref: SessionRef | undefined
  readonly cwd: string
  readonly session: SessionSnapshot | undefined
  readonly values: Readonly<Record<string, unknown>>
  readonly queue: readonly RemoteQueueItem[]
}

/** Read one selected Session without maintaining a second projection or event fold. */
export class RemoteSessionFactsSource {
  private binding: SessionBinding | null = null
  private selection: RemotePresentationSelection | undefined
  private generation = 0
  private subscriptions: readonly (() => void)[] = []
  private readonly listeners = new Set<() => void>()
  private current: RemoteSessionFactsSnapshot = emptyFacts()

  /** Return the identity-stable snapshot until an official source publishes a change. */
  snapshot(): RemoteSessionFactsSnapshot {
    return this.current
  }

  /** Alias for consumers that use the official observable naming convention. */
  getSnapshot(): RemoteSessionFactsSnapshot {
    return this.snapshot()
  }

  /**
   * Subscribe to selected-Session changes.
   * @param listener - invalidation callback.
   * @returns deterministic unsubscription.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Read one known projection with the Client's merged projection-table type. */
  projection<K extends Extract<keyof SessionProjectionMap, string>>(key: K): SessionProjectionMap[K] | undefined
  /** Read a projection contributed outside this compilation face. */
  projection(key: string): unknown
  projection(key: string): unknown {
    return this.current.values[key]
  }

  /** Attach one official Client binding, or clear all facts with null. */
  attach(binding: SessionBinding | null, selection?: RemotePresentationSelection): void {
    this.releaseSubscriptions()
    const generation = ++this.generation
    this.binding = binding
    this.selection = selection
    if (binding === null) {
      this.current = emptyFacts()
    } else {
      this.current = this.read(binding, selection)
      const changed = (): void => {
        if (generation !== this.generation || this.binding !== binding) return
        this.current = this.read(binding, this.selection)
        this.publish()
      }
      this.subscriptions = [
        binding.session.subscribe(changed),
        ...REMOTE_SESSION_PROJECTION_KEYS.map(key => binding.session.projections.faceOf(key).subscribe(changed)),
      ]
    }
    this.publish()
  }

  /** Release every official subscription and reject late callbacks. */
  dispose(): void {
    this.releaseSubscriptions()
    this.generation += 1
    this.binding = null
    this.selection = undefined
    this.current = emptyFacts()
    this.listeners.clear()
  }

  private read(
    binding: SessionBinding,
    selection: RemotePresentationSelection | undefined,
  ): RemoteSessionFactsSnapshot {
    const values: Record<string, unknown> = {}
    for (const key of REMOTE_SESSION_PROJECTION_KEYS) {
      const value = binding.session.projections.faceOf(key).getSnapshot()
      if (value !== undefined) values[key] = value
    }
    const workingDirectory = values['workingDirectory']
    return {
      ref: selection?.ref,
      cwd: typeof workingDirectory === 'string' ? workingDirectory : selection?.cwd ?? '',
      session: binding.session.getSnapshot(),
      values,
      queue: readQueue(values['inbox']),
    }
  }

  private publish(): void {
    for (const listener of [...this.listeners]) listener()
  }

  private releaseSubscriptions(): void {
    for (const dispose of this.subscriptions) dispose()
    this.subscriptions = []
  }
}

function emptyFacts(): RemoteSessionFactsSnapshot {
  return { ref: undefined, cwd: '', session: undefined, values: {}, queue: [] }
}

function readQueue(inbox: unknown): readonly RemoteQueueItem[] {
  if (!isRecord(inbox)) return []
  return [
    ...readQueueLane(inbox['next-step'], 'step'),
    ...readQueueLane(inbox['next-turn'], 'turn'),
  ]
}

function readQueueLane(value: unknown, lane: RemoteQueueItem['lane']): readonly RemoteQueueItem[] {
  if (!Array.isArray(value)) return []
  const rows: RemoteQueueItem[] = []
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate['id'] !== 'string' || !isRecord(candidate['source'])) continue
    if (candidate['source']['kind'] !== 'user') continue
    rows.push({ id: candidate['id'], lane, text: readMessageText(candidate['content']) })
  }
  return rows
}

function readMessageText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const candidate of content) {
    if (!isRecord(candidate)) continue
    if (candidate['type'] === 'text' && typeof candidate['text'] === 'string') parts.push(candidate['text'])
    if (candidate['type'] === 'image') parts.push('[image]')
    if (candidate['type'] === 'file') {
      const attachment = candidate['attachment']
      const name = isRecord(attachment) && typeof attachment['name'] === 'string' ? attachment['name'] : 'attachment'
      parts.push(`[file: ${name}]`)
    }
  }
  return parts.filter(part => part !== '').join('\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
