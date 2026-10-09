/** The `image` node: admission and quotas, the byte source, and the painter's alt and image rows. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ui } from '../../../ui/src/index.ts'
import { FakeMayflyComponents } from '../interaction/fakes.ts'
import { UiImagePainter } from '../../src/core/ui-image.ts'
import { MayflyUiSurfaceRuntime, compileMayflyUiNode, compileMayflyUiSurfaceNode } from '../../src/core/ui-compiler.ts'
import { documentBlocks } from '../../src/core/ui-interaction-document.ts'
import { MAYFLY_UI_IMAGE_CACHE, MayflyUiImagesService, type MayflyUiImageBytes, type MayflyUiImageLoader } from '../../src/core/ui-images.ts'
import {
  MAYFLY_UI_MAX_ATTACHMENT_ID,
  MAYFLY_UI_MAX_IMAGES,
  MAYFLY_UI_MAX_IMAGE_ROWS,
  validateMayflyEditorShellNode,
  validateMayflyStatusNode,
  validateMayflyUiNode,
  createAdmissionCache,
} from '../../src/core/ui-validator.ts'
import type { MayflySemanticColors } from '../../src/core/types.ts'

const identity = (value: string): string => value
const colors = new Proxy({ logoGradient: [identity] }, { get: (target, key) => key === 'logoGradient' ? target.logoGradient : (value: string) => `«${String(key)}:${value}»` }) as MayflySemanticColors
const PHOTO: MayflyUiImageBytes = { data: new Uint8Array([1, 2, 3]), mediaType: 'image/png', name: 'photo.png' }
const flush = () => new Promise<void>(resolve => { setImmediate(resolve) })

const services: MayflyUiImagesService[] = []
afterEach(() => { for (const service of services.splice(0)) service.dispose() })
function imageService(): MayflyUiImagesService {
  const service = new MayflyUiImagesService(new Context())
  services.push(service)
  return service
}

/** A loader whose answers the test settles by hand. */
function gate() {
  const waiting = new Map<string, { resolve: (value: MayflyUiImageBytes | undefined) => void, reject: (error: unknown) => void, signal: AbortSignal }>()
  const asked: string[] = []
  const loader: MayflyUiImageLoader = (id, signal) => {
    asked.push(id)
    return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject, signal }) })
  }
  return { loader, waiting, asked }
}

describe('image admission', () => {
  it('admits the wire shape and keeps the optional row bound', () => {
    expect(validateMayflyUiNode(ui.image({ attachmentId: 'a-1', alt: '[Image #1 84 KB]' }))).toMatchObject({ ok: true, value: { kind: 'image', attachmentId: 'a-1', alt: '[Image #1 84 KB]' } })
    expect(validateMayflyUiNode(ui.image({ attachmentId: 'a-1', alt: 'x', maxRows: 12 }))).toMatchObject({ ok: true, value: { maxRows: 12 } })
    expect(validateMayflyUiNode({ kind: 'image', attachmentId: 'a\x1b[31m1', alt: 'a\x1b]0;t\x07b' })).toMatchObject({ ok: true, value: { attachmentId: 'a1', alt: 'ab' } })
  })

  it.each([
    [{ kind: 'image', alt: 'x' }, 'attachmentId is required'],
    [{ kind: 'image', attachmentId: 'a' }, 'alt is required'],
    [{ kind: 'image', attachmentId: '', alt: 'x' }, 'attachmentId must be'],
    [{ kind: 'image', attachmentId: 'a'.repeat(MAYFLY_UI_MAX_ATTACHMENT_ID + 1), alt: 'x' }, 'attachmentId must be'],
    [{ kind: 'image', attachmentId: 1, alt: 'x' }, 'attachmentId must be a string'],
    [{ kind: 'image', attachmentId: 'a', alt: 'x', maxRows: 0 }, 'maxRows must be'],
    [{ kind: 'image', attachmentId: 'a', alt: 'x', maxRows: 1.5 }, 'maxRows must be'],
  ])('rejects %j', (value, message) => {
    const result = validateMayflyUiNode(value)
    expect(result).toMatchObject({ ok: false, code: 'MAYFLY_INVALID_CONTRIBUTION' })
    expect(result.ok ? '' : result.message).toContain(message)
  })

  it('limits the rows an image may ask for and the images in one tree', () => {
    const tall = validateMayflyUiNode(ui.image({ attachmentId: 'a', alt: 'x', maxRows: MAYFLY_UI_MAX_IMAGE_ROWS + 1 }))
    expect(tall).toMatchObject({ ok: false, code: 'MAYFLY_LIMIT_EXCEEDED' })
    expect(validateMayflyUiNode(ui.image({ attachmentId: 'a', alt: 'x', maxRows: MAYFLY_UI_MAX_IMAGE_ROWS }))).toMatchObject({ ok: true })
    const gallery = (count: number) => ui.stack.column(Array.from({ length: count }, (_, index) => ui.image({ attachmentId: `a${String(index)}`, alt: 'x' })))
    expect(validateMayflyUiNode(gallery(MAYFLY_UI_MAX_IMAGES))).toMatchObject({ ok: true })
    expect(validateMayflyUiNode(gallery(MAYFLY_UI_MAX_IMAGES + 1))).toMatchObject({ ok: false, code: 'MAYFLY_LIMIT_EXCEEDED' })
  })

  it('replays an unchanged image subtree\'s share of the quota from the admission memo', () => {
    const cache = createAdmissionCache()
    const shared = ui.stack.column(Array.from({ length: 5 }, (_, index) => ui.image({ attachmentId: `a${String(index)}`, alt: 'x' })))
    expect(validateMayflyUiNode(ui.stack.column([shared]), undefined, cache)).toMatchObject({ ok: true })
    // The memoized subtree still counts its five images against the tree.
    const twice = ui.stack.column([shared, ui.stack.column([ui.image({ attachmentId: 'b0', alt: 'x' }), ui.image({ attachmentId: 'b1', alt: 'x' }), ui.image({ attachmentId: 'b2', alt: 'x' }), ui.image({ attachmentId: 'b3', alt: 'x' })])])
    expect(validateMayflyUiNode(twice, undefined, cache)).toMatchObject({ ok: false, code: 'MAYFLY_LIMIT_EXCEEDED' })
    expect(validateMayflyUiNode(ui.stack.column([shared]), undefined, cache)).toMatchObject({ ok: true })
  })

  it('refuses images in status rows and editor shells, and admits them in a responsive branch', () => {
    const image = ui.image({ attachmentId: 'a', alt: 'x' })
    expect(validateMayflyStatusNode(image)).toMatchObject({ ok: false })
    expect(validateMayflyEditorShellNode(ui.stack.column([image, { kind: 'editor-control' }]))).toMatchObject({ ok: false })
    const responsive = ui.stack.column([ui.child(image, { when: { minWidth: 40 } })])
    expect(validateMayflyUiNode(responsive)).toMatchObject({ ok: true })
  })
})

describe('MayflyUiImagesService', () => {
  it('answers missing with no loader, and loads when one arrives', async () => {
    const images = imageService()
    const changed = vi.fn()
    expect(images.read('a', changed)).toEqual({ state: 'missing' })
    const dispose = images.provide(async id => id === 'a' ? PHOTO : undefined)
    expect(images.read('a', changed)).toEqual({ state: 'pending' })
    await flush()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(images.read('a', changed)).toEqual({ state: 'ready', image: PHOTO })
    dispose()
    // Bytes already known survive the loader that supplied them.
    expect(images.read('a', changed)).toEqual({ state: 'ready', image: PHOTO })
    expect(images.read('b', changed)).toEqual({ state: 'missing' })
  })

  it('shares one load per id across surfaces and calls each listener once', async () => {
    const images = imageService()
    const { loader, waiting, asked } = gate()
    images.provide(loader)
    const first = vi.fn()
    const second = vi.fn()
    expect(images.read('a', first)).toEqual({ state: 'pending' })
    images.read('a', first)
    images.read('a', second)
    expect(asked).toEqual(['a'])
    waiting.get('a')!.resolve(PHOTO)
    await flush()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    images.read('a', first)
    expect(first).toHaveBeenCalledTimes(1)
  })

  it('asks the newest loader first, falls through on undefined or failure, and settles missing when none knows the id', async () => {
    const images = imageService()
    const older = vi.fn(async (): Promise<MayflyUiImageBytes | undefined> => PHOTO)
    images.provide(older)
    const failing = vi.fn(async (): Promise<MayflyUiImageBytes | undefined> => { throw new Error('store down') })
    images.provide(failing)
    const unknown = vi.fn(async (): Promise<MayflyUiImageBytes | undefined> => undefined)
    images.provide(unknown)
    images.read('a', () => {})
    await flush()
    expect(unknown).toHaveBeenCalledTimes(1)
    expect(failing).toHaveBeenCalledTimes(1)
    expect(older).toHaveBeenCalledTimes(1)
    expect(images.read('a', () => {})).toEqual({ state: 'ready', image: PHOTO })

    const empty = imageService()
    empty.provide(async () => undefined)
    empty.read('x', () => {})
    await flush()
    expect(empty.read('x', () => {})).toEqual({ state: 'missing' })
  })

  it('restarts loads that have no bytes when the loader set changes, and drops a stale answer', async () => {
    const images = imageService()
    const changed = vi.fn()
    const slow = gate()
    const removeSlow = images.provide(slow.loader)
    images.read('a', changed)
    const stale = slow.waiting.get('a')!
    const fast = images.provide(async () => PHOTO)
    expect(stale.signal.aborted).toBe(true)
    // The first loader answers late for a generation that no longer exists.
    stale.resolve({ data: new Uint8Array([9]), mediaType: 'image/gif' })
    await flush()
    expect(images.read('a', changed)).toEqual({ state: 'ready', image: PHOTO })
    expect(changed).toHaveBeenCalledTimes(1)
    removeSlow()
    removeSlow()
    fast()
    expect(images.read('a', changed)).toEqual({ state: 'ready', image: PHOTO })

    // Removing the only loader while a load is in flight settles it missing.
    const other = imageService()
    const pending = gate()
    const remove = other.provide(pending.loader)
    other.read('p', () => {})
    remove()
    expect(other.read('p', () => {})).toEqual({ state: 'missing' })
  })

  it('keeps the most recently read images and evicts the rest', async () => {
    const images = imageService()
    const loader = vi.fn(async (): Promise<MayflyUiImageBytes | undefined> => PHOTO)
    images.provide(loader)
    for (let index = 0; index < MAYFLY_UI_IMAGE_CACHE; index += 1) images.read(`i${String(index)}`, () => {})
    await flush()
    // Reading the oldest moves it to the front, so the next newcomer evicts the second oldest.
    images.read('i0', () => {})
    images.read('extra', () => {})
    await flush()
    expect(loader).toHaveBeenCalledTimes(MAYFLY_UI_IMAGE_CACHE + 1)
    images.read('i0', () => {})
    expect(loader).toHaveBeenCalledTimes(MAYFLY_UI_IMAGE_CACHE + 1)
    images.read('i1', () => {})
    expect(loader).toHaveBeenCalledTimes(MAYFLY_UI_IMAGE_CACHE + 2)
  })

  it('never evicts a load that is still in flight', async () => {
    const images = imageService()
    const { loader, asked } = gate()
    images.provide(loader)
    for (let index = 0; index < MAYFLY_UI_IMAGE_CACHE + 3; index += 1) images.read(`p${String(index)}`, () => {})
    expect(asked).toHaveLength(MAYFLY_UI_IMAGE_CACHE + 3)
    images.read('p0', () => {})
    expect(asked).toHaveLength(MAYFLY_UI_IMAGE_CACHE + 3)
  })

  it('aborts every load and answers nothing once disposed', async () => {
    const images = imageService()
    const { loader, waiting } = gate()
    images.provide(loader)
    const changed = vi.fn()
    images.read('a', changed)
    const signal = waiting.get('a')!.signal
    images.dispose()
    expect(signal.aborted).toBe(true)
    waiting.get('a')!.resolve(PHOTO)
    await flush()
    expect(changed).not.toHaveBeenCalled()
    expect(images.read('a', changed)).toEqual({ state: 'missing' })
  })
})

function paint(node: ReturnType<typeof ui.image>, options: { readonly protocol?: boolean, readonly images?: MayflyUiImagesService | undefined, readonly repaint?: () => void } = {}) {
  const components = new FakeMayflyComponents()
  components.imageProtocolActive = options.protocol ?? true
  const painter = new UiImagePainter(node, components, colors, options.images, options.repaint ?? (() => {}))
  return { components, painter }
}

describe('UiImagePainter', () => {
  const node = ui.image({ attachmentId: 'a', alt: '[Image #1 84 KB]', maxRows: 6 })

  it('shows the alt until the bytes arrive, then the image, and repaints once', async () => {
    const images = imageService()
    const { loader, waiting } = gate()
    images.provide(loader)
    const repaint = vi.fn()
    const { components, painter } = paint(node, { images, repaint })
    expect(painter.render(40)).toEqual(['«textMuted:[Image #1 84 KB]»'])
    waiting.get('a')!.resolve(PHOTO)
    await flush()
    expect(repaint).toHaveBeenCalledTimes(1)
    expect(painter.render(40)).toEqual(['[image: image/png]'])
    expect(components.images).toEqual([{ data: PHOTO.data, mediaType: 'image/png', filename: 'photo.png', maxHeightCells: 6 }])
    // The component is made once per bytes, and an invalidation reaches it.
    painter.render(20)
    expect(components.images).toHaveLength(1)
    painter.invalidate()
  })

  it('keeps the alt on a terminal without an image protocol, however many bytes arrive', async () => {
    const images = imageService()
    images.provide(async () => PHOTO)
    const { components, painter } = paint(node, { images, protocol: false })
    painter.render(40)
    await flush()
    expect(painter.render(40)).toEqual(['«textMuted:[Image #1 84 KB]»'])
    expect(components.images).toEqual([])
  })

  it('keeps the alt when the loader does not know the id, or there is no byte source at all', async () => {
    const images = imageService()
    images.provide(async () => undefined)
    const known = paint(node, { images })
    known.painter.render(40)
    await flush()
    expect(known.painter.render(40)).toEqual(['«textMuted:[Image #1 84 KB]»'])
    expect(paint(node, { images: undefined }).painter.render(40)).toEqual(['«textMuted:[Image #1 84 KB]»'])
  })

  it('makes the image without a name or a row bound when the node and the bytes carry none', async () => {
    const images = imageService()
    images.provide(async () => ({ data: PHOTO.data, mediaType: 'image/gif' }))
    const { components, painter } = paint(ui.image({ attachmentId: 'a', alt: 'x' }), { images })
    painter.render(40)
    await flush()
    painter.render(40)
    expect(components.images).toEqual([{ data: PHOTO.data, mediaType: 'image/gif' }])
  })

  it('collapses line breaks in the alt to one row', () => {
    const { painter } = paint(ui.image({ attachmentId: 'a', alt: 'one\ntwo\tthree' }), { images: undefined })
    expect(painter.render(40)).toEqual(['«textMuted:one two three»'])
    painter.invalidate()
  })
})

describe('compiled image nodes', () => {
  const base = (runtime: MayflyUiSurfaceRuntime) => ({
    components: Object.assign(new FakeMayflyComponents(), { imageProtocolActive: true }),
    colors,
    getViewport: () => ({ columns: 80, rows: 24 }),
    screenMode: 'alternate' as const,
    emit: () => {},
    surfaceRuntime: runtime,
  })

  it('paints the alt in a standalone compile, which has no byte source', () => {
    const result = compileMayflyUiNode(ui.stack.column([ui.text('above'), ui.image({ attachmentId: 'a', alt: '[Image #1]' })]), {
      components: new FakeMayflyComponents(), colors, getViewport: () => ({ columns: 80, rows: 24 }), screenMode: 'alternate', emit: () => {},
    })
    expect(result.ok && result.value.component.render(40)).toEqual(['«text:above»', '«textMuted:[Image #1]»'])
  })

  it('paints the image through the surface runtime\'s source and repaints through its renderer', async () => {
    const images = imageService()
    images.provide(async () => PHOTO)
    const repaint = vi.fn()
    const runtime = new MayflyUiSurfaceRuntime(undefined, repaint, undefined, images)
    const counters = { nodesValidated: 0, unitsCompiled: 0, rowsPainted: 0, stringsMeasured: 0 }
    const result = compileMayflyUiSurfaceNode(ui.image({ attachmentId: 'a', alt: '[Image #1]' }), { ...base(runtime), counters })
    if (!result.ok) throw new Error(result.message)
    expect(result.value.component.render(40)).toEqual(['«textMuted:[Image #1]»'])
    await flush()
    expect(repaint).toHaveBeenCalledTimes(1)
    // The renderer's repaint invalidates the surface, as a pane's does, before it paints again.
    result.value.component.invalidate()
    expect(result.value.component.render(40)).toEqual(['[image: image/png]'])
    expect(counters.rowsPainted).toBe(2)
    result.value.component.invalidate()
    runtime.dispose()
    runtime.repaint()
    expect(repaint).toHaveBeenCalledTimes(1)
  })

  it('quietly skips the repaint when the surface has no renderer', async () => {
    const images = imageService()
    images.provide(async () => PHOTO)
    const runtime = new MayflyUiSurfaceRuntime(undefined, undefined, undefined, images)
    const result = compileMayflyUiSurfaceNode(ui.image({ attachmentId: 'a', alt: 'x' }), base(runtime))
    if (!result.ok) throw new Error(result.message)
    result.value.component.render(40)
    await flush()
    result.value.component.invalidate()
    expect(result.value.component.render(40)).toEqual(['[image: image/png]'])
  })

  it('reads an image as its alt in a document block', () => {
    expect(documentBlocks(ui.image({ attachmentId: 'a', alt: '[Image #1]' })).blocks.map(block => block.source)).toEqual(['[Image #1]'])
  })
})
