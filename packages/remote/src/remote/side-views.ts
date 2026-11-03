/** Retained native side conversations, exact displayed bindings, and F7 recency. @module remote/side-views */
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import type { MayflyScreenService } from '@ephemeral-ai/mayfly/core'
import type { ToolPresentationSource } from '@ephemeral-ai/mayfly/transcript'
import { TranscriptController } from '@ephemeral-ai/mayfly/transcript'
import type { HostKey, SessionRef } from '../client/types.ts'
import type { RemotePresentedViewFacts } from './operations/support.ts'
import { RemoteConversationModelSource, type RemotePresentationFacts, type RemotePresentationSelection } from '../transcript/remote-model.ts'

/** The transcript's main selection is independent of every side binding. */
export const REMOTE_SIDE_VIEW_KEY = 'remote-side'
const PRIMARY = 'remote'
const MAX_SIDE_CONVERSATIONS = 32
const keyOf = (ref: SessionRef): string => `${REMOTE_SIDE_VIEW_KEY}:${JSON.stringify([ref.host, ref.sessionId])}`

/** A borrowed native binding with immutable presentation metadata, never its lifetime owner. */
export interface RemoteSideSelection {
  readonly ref: SessionRef
  readonly binding: SessionBinding
  readonly facts: RemotePresentedViewFacts
}

interface SideRecord {
  readonly ref: SessionRef
  readonly facts: RemotePresentedViewFacts
  readonly key: string
  binding: SessionBinding | undefined
  source: RemoteConversationModelSource | undefined
}

/** Local view-selection hooks; lease retirement remains with the operations owner. */
export interface RemoteSideViewOptions {
  readonly modelCatalog?: (host: HostKey) => ModelCatalog | undefined
  readonly changed?: () => void
  readonly evicted?: (ref: SessionRef) => void
  readonly retainOnly?: (refs: readonly SessionRef[]) => void
  readonly reopen?: (ref: SessionRef, facts: RemotePresentedViewFacts) => void
  readonly primaryVisible?: (visible: boolean) => void
}

/** Display and recency over the same native bindings retained by operations. */
export class RemoteSideViews {
  private readonly views = new Map<string, SideRecord>()
  private readonly listeners = new Set<() => void>()
  private recent = [PRIMARY]
  private displayed = PRIMARY
  private disposed = false

  constructor(
    private readonly transcript: TranscriptController,
    private readonly tools: ToolPresentationSource,
    private readonly screen: MayflyScreenService,
    private readonly options: RemoteSideViewOptions = {},
  ) {}

  /** The currently displayed side Session, if the primary is not displayed. */
  current(): SessionRef | undefined { return this.selected()?.ref }

  /** Retained side identities for primary replacement and detach cleanup. */
  references(): readonly SessionRef[] { return [...this.views.values()].map(view => view.ref) }

  /** Exact borrowed native binding and its native-derived access. */
  selected(): RemoteSideSelection | undefined {
    const record = this.views.get(this.displayed)
    return record?.binding === undefined ? undefined : { ref: record.ref, binding: record.binding, facts: record.facts }
  }

  /** Displayed side facts; the primary keeps its own source. */
  presentation(): RemotePresentationFacts | undefined { return this.views.get(this.displayed)?.source?.presentation() }

  /** Displayed native projections, used by the same status and queue consumers. */
  sessionFacts(): ReturnType<RemoteConversationModelSource['sessionFacts']> | undefined { return this.views.get(this.displayed)?.source?.sessionFacts() }

  /** Resolve an image from the exact displayed source rather than the primary. */
  imageAttachment(id: string): ReturnType<RemoteConversationModelSource['imageAttachment']> { return this.views.get(this.displayed)?.source?.imageAttachment(id) }

  /** Displayed kind while another conversation is open, for the reference status chip. */
  kind(): 'primary' | 'btw' | 'subagent' | undefined { return this.views.size === 0 ? undefined : this.selected()?.facts.kind ?? 'primary' }

  /** F7 counterpart and the side F8 will close, using their actual kind. */
  navigation(): { readonly counterpart: 'primary' | 'btw' | 'subagent', readonly close: 'btw' | 'subagent' } | undefined {
    const counterpart = this.recent[1]
    if (counterpart === undefined) return undefined
    const other = this.views.get(counterpart)
    // Recency always contains the primary plus retained side descriptors; if
    // a counterpart exists, either the displayed or counterpart view is a side.
    const target = (this.selected() ?? other)!
    return { counterpart: other?.facts.kind ?? 'primary', close: target.facts.kind }
  }

  /** F8 closes the displayed side, or the F7 counterpart while the primary is displayed. */
  closeTarget(): SessionRef | undefined { return (this.views.get(this.displayed) ?? this.views.get(this.recent[1] ?? ''))?.ref }

  /** Observe selection changes only; stream updates never invalidate editor submissions. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Present an exact borrowed binding without acquiring or releasing native resources. */
  present(binding: SessionBinding, selection: RemotePresentationSelection, facts: RemotePresentedViewFacts = { kind: 'subagent', access: 'readonly' }): void {
    if (this.disposed) return
    const key = keyOf(selection.ref)
    this.drop(key)
    const source = new RemoteConversationModelSource(this.tools, () => {
      if (this.displayed === key) this.transcript.refresh()
    }, {
      ...this.options.modelCatalog === undefined ? {} : { modelCatalog: this.options.modelCatalog },
      onPresentation: () => { if (this.displayed === key) this.repaint() },
    })
    const record = { ref: selection.ref, binding, facts, source, key }
    this.views.set(key, record)
    source.attach(binding, { ...selection, ...facts.historyFloorSeq === undefined ? {} : { historyFloorSeq: facts.historyFloorSeq } })
    this.transcript.setView(key, () => source.snapshot())
    this.promote(key)
    while (this.views.size > MAX_SIDE_CONVERSATIONS) {
      const oldest = this.recent.findLast(candidate => candidate !== key && this.views.has(candidate))!
      const evicted = this.views.get(oldest)!.ref
      this.drop(oldest)
      this.options.evicted?.(evicted)
    }
    this.publish()
  }

  /** Display the most recently displayed other conversation. */
  back(): boolean {
    const target = this.recent[1]
    if (target === undefined) return false
    const record = this.views.get(target)
    if (record !== undefined && record.binding === undefined) {
      if (this.options.reopen === undefined) return false
      this.options.reopen(record.ref, record.facts)
      return true
    }
    this.promote(target)
    this.publish()
    return true
  }

  /** Return to the primary without closing its independently retained side views. */
  showPrimary(): void {
    if (this.displayed === PRIMARY) return
    this.promote(PRIMARY)
    this.publish()
  }

  /** Release local presentation for one exact view, or all views on primary replacement. */
  close(ref?: SessionRef): void {
    if (ref === undefined) {
      if (this.views.size === 0) return
      for (const key of [...this.views.keys()]) this.drop(key)
      this.recent = [PRIMARY]
      this.displayed = PRIMARY
    } else {
      const key = keyOf(ref)
      if (!this.views.has(key)) return
      this.drop(key)
    }
    this.transcript.show(this.displayed)
    this.publish()
  }

  /** Stop local sources only; native work and binding leases have separate owners. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.close()
    this.listeners.clear()
  }

  private promote(key: string): void {
    this.recent = [key, ...this.recent.filter(candidate => candidate !== key)]
    this.displayed = key
    this.transcript.show(key)
  }

  private drop(key: string): void {
    const record = this.views.get(key)
    if (record === undefined) return
    this.views.delete(key)
    record.source?.dispose()
    this.transcript.dropView(key)
    this.recent = this.recent.filter(candidate => candidate !== key)
    if (this.displayed === key) {
      // PRIMARY is never removed from recency.
      this.displayed = this.recent.find(candidate => candidate === PRIMARY || this.views.get(candidate)?.binding !== undefined)!
      this.recent = [this.displayed, ...this.recent.filter(candidate => candidate !== this.displayed)]
    }
  }

  private repaint(): void {
    this.options.changed?.()
    this.screen.requestRender()
  }

  private publish(): void {
    const retained = new Set(this.recent.slice(0, 2))
    const refs: SessionRef[] = []
    for (const record of this.views.values()) {
      if (!retained.has(record.key)) {
        record.source?.dispose()
        record.source = undefined
        record.binding = undefined
      } else {
        record.source?.setVisible(record.key === this.displayed)
        if (record.binding !== undefined) refs.push(record.ref)
      }
    }
    this.options.primaryVisible?.(this.displayed === PRIMARY)
    this.options.retainOnly?.(refs)
    for (const listener of [...this.listeners]) listener()
    this.repaint()
  }
}
