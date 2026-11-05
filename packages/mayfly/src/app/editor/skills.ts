/**
 * Session skill token grammar, rewrite, and last-good native Host catalog.
 * @module @ephemeral-ai/mayfly/app/editor/skills
 */

import type { SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import type { MayflySkillSummary } from '@ephemeral-ai/mayfly-host/types'
import { mayflyHostRemote } from '../../hosts/host-mount.ts'
import type { EditorFeatureSession } from './types.ts'

/** The official skill row enriched only by exact native Host catalog fields. */
type EditorSkill = SkillEntry & Partial<Pick<MayflySkillSummary, 'source' | 'provider'>>

const SKILL_TOKEN = /(^|\s)#([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/gu
const SKILL_PREFIX = /(^|\s)#([a-z0-9-]*)$/u

/** Extract a `#` token at the cursor, excluding Markdown headings and mid-word `C#`. */
export function extractSkillPrefix(textBeforeCursor: string): string | null {
  return SKILL_PREFIX.exec(textBeforeCursor)?.[2] ?? null
}

/** Rewrite only settled skill names into the Harness model-facing slash gesture. */
export function rewriteSkillTokens(text: string, skills: readonly SkillEntry[]): string {
  const names = new Set(skills.map(skill => skill.name))
  if (names.size === 0) return text
  return text.replace(SKILL_TOKEN, (token, lead: string, name: string) => names.has(name) ? `${lead}/${name}` : token)
}

function selectionKey(selected: EditorFeatureSession | undefined): string {
  return selected === undefined ? '' : `${selected.ref.host}\0${selected.ref.sessionId}\0${String(selected.generation)}\0${String(selected.client.state.getSnapshot().generation)}`
}

/** One selection's catalog; no `skills/change` listener is assumed because dsh does not forward it. */
export class EditorSkills {
  private key = ''
  private epoch = 0
  private settled: readonly EditorSkill[] = []
  private complete = false
  private metadataUnavailable = false
  private flight: { readonly key: string, readonly promise: Promise<void>, readonly controller: AbortController, readonly signal: AbortSignal } | undefined
  private lastError: string | undefined
  private observed: EditorFeatureSession | undefined
  private readonly listeners = new Set<() => void>()
  private disposed = false

  constructor(private readonly session: () => EditorFeatureSession | undefined) {
    this.syncSelection()
  }

  /** Clear a retired selection immediately and cancel its in-flight list. */
  syncSelection(): void {
    if (this.disposed) return
    const current = this.session()
    const key = selectionKey(current)
    if (key === this.key && current?.client === this.observed?.client && current?.session === this.observed?.session) return
    this.key = key
    this.observed = current
    this.epoch += 1
    this.flight?.controller.abort()
    this.flight = undefined
    this.settled = []
    this.complete = false
    this.metadataUnavailable = false
    this.lastError = undefined
    this.changed()
  }

  /** Observe settled native catalog changes; observers never own its contents. */
  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  list(): readonly EditorSkill[] {
    this.syncSelection()
    return this.settled
  }

  snapshot(): { readonly skills: readonly EditorSkill[], readonly complete: boolean, readonly metadataUnavailable: boolean, readonly error?: string } {
    this.syncSelection()
    return {
      skills: this.settled,
      complete: this.complete,
      metadataUnavailable: this.metadataUnavailable,
      ...this.lastError === undefined ? {} : { error: this.lastError },
    }
  }

  /** Refresh once for this exact Session generation, retaining only same-selection last-good data. */
  refresh(signal?: AbortSignal): Promise<void> {
    if (this.disposed || signal?.aborted) return Promise.resolve()
    this.syncSelection()
    const selected = this.session()
    if (selected === undefined) return Promise.resolve()
    if (this.flight?.key === this.key && !this.flight.signal.aborted) return this.flight.promise
    this.flight?.controller.abort()
    const key = this.key
    const ticket = ++this.epoch
    const controller = new AbortController()
    const readSignal = signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal])
    const current = (): boolean => {
      this.syncSelection()
      return ticket === this.epoch && key === this.key && !readSignal.aborted
    }
    const promise = (async () => {
      try {
        const remote = mayflyHostRemote(selected.client)
        const capabilities = remote === undefined ? undefined : await remote.capabilities()
        if (!current()) return
        if (capabilities !== undefined && !capabilities.ok) throw new Error(capabilities.error.message)
        const metadata = capabilities?.value.features.includes('skillCatalog') === true
        this.metadataUnavailable = !metadata
        const result = metadata
          ? await remote.skillCatalog({ sessionId: selected.ref.sessionId }, readSignal)
          : await selected.client.remote.skills.list({ sessionId: selected.ref.sessionId }, readSignal)
        if (!current()) return
        if (!result.ok) {
          this.complete = false
          this.lastError = result.error.message
          this.changed()
          return
        }
        this.complete = 'complete' in result.value ? result.value.complete : true
        if (this.complete) {
          this.settled = result.value.skills.map(({ path, whenToUse, ...skill }) => ({
            ...skill,
            ...path === undefined ? {} : { path },
            ...whenToUse === undefined ? {} : { whenToUse },
          }))
        }
        this.lastError = undefined
        this.changed()
      } catch (error) {
        if (!current()) return
        this.complete = false
        this.lastError = error instanceof Error ? error.message : String(error)
        this.changed()
      }
    })()
    this.flight = { key, promise, controller, signal: readSignal }
    void promise.finally(() => {
      if (this.flight?.promise === promise) this.flight = undefined
      controller.abort()
    })
    return promise
  }

  rewrite(text: string): string {
    return rewriteSkillTokens(text, this.list())
  }

  dispose(): void {
    this.disposed = true
    this.epoch += 1
    this.flight?.controller.abort()
    this.flight = undefined
    this.settled = []
    this.complete = false
    this.metadataUnavailable = false
    this.lastError = undefined
    this.listeners.clear()
  }

  private changed(): void { for (const listener of this.listeners) listener() }
}
