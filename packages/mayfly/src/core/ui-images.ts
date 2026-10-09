/**
 * `ctx.mayflyUiImages`: the byte source behind `image` nodes. The wire carries only an attachment id; the host tree
 * supplies a loader that turns an id into bytes (the Harness attachment store, in the product), so core never imports
 * the Harness. Loads are keyed by id, shared by every surface, and answered from a small cache; a loader that comes or
 * goes restarts the loads that have not settled with bytes, and a load that finishes for an older provider set is
 * dropped.
 *
 * @module @ephemeral-ai/mayfly/core/ui-images
 */
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context { mayflyUiImages: MayflyUiImagesService }
}

/** The bytes of one image, with the media type the renderer needs to decode them. */
export interface MayflyUiImageBytes {
  readonly data: Uint8Array
  /** The image's MIME type, e.g. `'image/png'`. */
  readonly mediaType: string
  /** Optional name shown in the renderer's own text fallback. */
  readonly name?: string
}

/** Resolves an attachment id to its bytes; `undefined` means this loader does not know the id. */
export type MayflyUiImageLoader = (attachmentId: string, signal: AbortSignal) => Promise<MayflyUiImageBytes | undefined>

/** Where one image's load stands. */
export type MayflyUiImageState =
  | { readonly state: 'pending' }
  | { readonly state: 'missing' }
  | { readonly state: 'ready', readonly image: MayflyUiImageBytes }

/** What a surface needs from the byte source: the current state, and a nudge when it changes. */
export interface MayflyUiImageSource {
  /**
   * The state of one image, starting its load the first time it is asked for.
   * @param attachmentId - the node's attachment id.
   * @param changed - called once when a pending or missing image's state moves on; the same function is kept once.
   */
  read(attachmentId: string, changed: () => void): MayflyUiImageState
}

/** How many decoded images the cache keeps; the least recently read one goes first. */
export const MAYFLY_UI_IMAGE_CACHE = 16

interface Entry {
  state: MayflyUiImageState
  generation: number
  controller: AbortController | undefined
  readonly listeners: Set<() => void>
}

const PENDING: MayflyUiImageState = Object.freeze({ state: 'pending' })
const MISSING: MayflyUiImageState = Object.freeze({ state: 'missing' })

/** The host tree's image loaders and the cache of what they returned. */
export class MayflyUiImagesService extends Service implements MayflyUiImageSource {
  private readonly loaders: MayflyUiImageLoader[] = []
  private readonly entries = new Map<string, Entry>()
  private live = true

  /**
   * Create the service.
   * @param ctx - the owning Cordis context.
   */
  constructor(ctx: Context) {
    super(ctx, 'mayflyUiImages')
  }

  /**
   * Add a loader. The newest loader is asked first and the next one is asked when it answers `undefined` or fails.
   * @param loader - resolves an attachment id to bytes.
   * @returns a disposer removing exactly this loader; safe to call twice.
   */
  provide(loader: MayflyUiImageLoader): () => void {
    this.loaders.unshift(loader)
    this.restart()
    return () => {
      const index = this.loaders.indexOf(loader)
      if (index < 0) return
      this.loaders.splice(index, 1)
      this.restart()
    }
  }

  read(attachmentId: string, changed: () => void): MayflyUiImageState {
    let entry = this.entries.get(attachmentId)
    if (entry === undefined) {
      entry = { state: PENDING, generation: 0, controller: undefined, listeners: new Set() }
      this.entries.set(attachmentId, entry)
      this.evict()
      this.load(attachmentId, entry)
    } else if (entry.state.state === 'ready') {
      this.entries.delete(attachmentId)
      this.entries.set(attachmentId, entry)
    }
    if (entry.state.state !== 'ready') entry.listeners.add(changed)
    return entry.state
  }

  /** Abort every load, drop every image, and refuse new reads. */
  dispose(): void {
    this.live = false
    for (const entry of this.entries.values()) {
      entry.generation += 1
      entry.controller?.abort()
    }
    this.entries.clear()
    this.loaders.length = 0
  }

  /** The loader set changed: whatever has no bytes yet asks again. */
  private restart(): void {
    for (const [id, entry] of this.entries) {
      if (entry.state.state === 'ready') continue
      entry.state = PENDING
      this.load(id, entry)
    }
  }

  private load(attachmentId: string, entry: Entry): void {
    entry.generation += 1
    entry.controller?.abort()
    const generation = entry.generation
    if (!this.live || this.loaders.length === 0) {
      entry.controller = undefined
      entry.state = MISSING
      return
    }
    const controller = new AbortController()
    entry.controller = controller
    const loaders = [...this.loaders]
    void (async () => {
      let image: MayflyUiImageBytes | undefined
      for (const loader of loaders) {
        try { image = await loader(attachmentId, controller.signal) } catch { image = undefined }
        if (entry.generation !== generation) return
        if (image !== undefined) break
      }
      entry.controller = undefined
      entry.state = image === undefined ? MISSING : Object.freeze({ state: 'ready', image })
      const listeners = [...entry.listeners]
      entry.listeners.clear()
      for (const listener of listeners) listener()
    })()
  }

  private evict(): void {
    while (this.entries.size > MAYFLY_UI_IMAGE_CACHE) {
      const oldest = [...this.entries].find(([, entry]) => entry.state.state === 'ready')
      if (oldest === undefined) return
      this.entries.delete(oldest[0])
    }
  }
}
