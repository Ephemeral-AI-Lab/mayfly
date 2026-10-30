import { describe, expect, it } from 'vitest'
import {
  REMOTE_PROVIDER_MODELS_LIST_ID,
  REMOTE_PROVIDERS_LIST_ID,
  remoteProviderListPanelNode,
  remoteProviderModelsPanelNode,
  type RemoteProviderModelRow,
  type RemoteProviderRow,
} from '../../src/remote/panels/operations/providers.ts'

type Translate = (key: string, values?: Readonly<Record<string, string | number>>) => string

const t: Translate = (key, values) => key.replace(
  /\{([A-Za-z][A-Za-z0-9_]*)\}/gu,
  (placeholder, name: string) => String(values?.[name] ?? placeholder),
)

interface Cell {
  readonly spans: readonly { readonly text: string }[]
  readonly align?: 'left' | 'right'
  readonly min?: number
  readonly shed?: number
}

interface Item {
  readonly id: string
  readonly label: string
  readonly cells?: readonly Cell[]
  readonly detail?: string
  readonly current?: boolean
  readonly searchText?: string
}

interface ListNode {
  readonly kind: 'list'
  readonly id: string
  readonly items: readonly Item[]
  readonly empty?: { readonly title?: string }
}

interface SurfaceNode {
  readonly kind: 'surface'
  readonly title?: string
}

function walk(node: unknown): unknown[] {
  if (typeof node !== 'object' || node === null) return []
  const record = node as Record<string, unknown>
  const found: unknown[] = [node]
  if ('child' in record) found.push(...walk(record.child))
  if (Array.isArray(record.children)) {
    for (const child of record.children) found.push(...walk((child as { node?: unknown }).node))
  }
  return found
}

function findList(node: unknown, id: string): ListNode {
  const match = walk(node).find(candidate => {
    const record = candidate as { kind?: string, id?: string }
    return record.kind === 'list' && record.id === id
  }) as ListNode | undefined
  if (match === undefined) throw new Error(`list ${id} was not rendered`)
  return match
}

function texts(node: unknown): readonly string[] {
  return walk(node)
    .filter(candidate => (candidate as { kind?: string }).kind === 'text')
    .map(candidate => String((candidate as { content?: unknown }).content ?? ''))
}

function provider(id: string, name: string, overrides: Partial<RemoteProviderRow> = {}): RemoteProviderRow {
  return { id, name, live: true, models: 1, current: false, ...overrides }
}

function model(id: string, label: string, overrides: Partial<RemoteProviderModelRow> = {}): RemoteProviderModelRow {
  return { id, label, current: false, ...overrides }
}

describe('remoteProviderListPanelNode', () => {
  it('renders one live or dormant row per provider with the model count', () => {
    const node = remoteProviderListPanelNode({
      rows: [
        provider('deepseek', 'DeepSeek', { live: true, models: 3, current: true, detail: 'activation failed' }),
        provider('other', 'Other', { live: false, models: 0 }),
      ],
      error: undefined,
    }, t)
    expect((node as unknown as SurfaceNode).title).toBe('Providers')
    const list = findList(node, REMOTE_PROVIDERS_LIST_ID)
    expect(list.items).toHaveLength(2)
    expect(list.items.map(item => item.id)).toEqual(['deepseek', 'other'])
    expect(list.items[0]!.label).toBe('DeepSeek')
    expect(list.items[0]!.cells?.[0]?.spans[0]?.text).toBe(' live')
    expect(list.items[0]!.cells?.[1]?.spans[0]?.text).toBe('3 models')
    expect(list.items[1]!.cells?.[0]?.spans[0]?.text).toBe(' dormant')
    expect(list.items[1]!.cells?.[1]?.spans[0]?.text).toBe('no models')
    expect(list.items[0]!.current).toBe(true)
    expect(list.items[0]!.detail).toBe('activation failed')
    expect(list.items[0]!.searchText).toBe('DeepSeek deepseek')
  })

  it('keeps a leading space on the state cell so it cannot collide with the label', () => {
    const node = remoteProviderListPanelNode({
      rows: [provider('deepseek', 'DeepSeek', { live: true }), provider('other', 'Other', { live: false })],
      error: undefined,
    }, t)
    const list = findList(node, REMOTE_PROVIDERS_LIST_ID)
    list.items.forEach((item, index) => {
      const state = item.cells?.[0]?.spans[0]?.text ?? ''
      // The list inserts its cell gap only after a painted cell; the leading
      // space is what keeps this cell from running into the label.
      expect(state.startsWith(' ')).toBe(true)
      expect(state.trim()).toBe(index === 0 ? 'live' : 'dormant')
      expect(state).not.toBe(item.label)
    })
  })

  it('emits a min of at least one for every cell', () => {
    const node = remoteProviderListPanelNode({
      rows: [
        provider('a', 'A', { live: true, models: 12 }),
        provider('b', 'B', { live: false, models: 0 }),
      ],
      error: undefined,
    }, t)
    const list = findList(node, REMOTE_PROVIDERS_LIST_ID)
    const cells = list.items.flatMap(item => item.cells ?? [])
    expect(cells.length).toBeGreaterThan(0)
    for (const cell of cells) expect(cell.min).toBeGreaterThanOrEqual(1)
    // A zero min is rejected by the runtime cell validator, so the panel must never emit it.
    expect(cells.map(cell => cell.min)).not.toContain(0)
    expect(list.items[0]!.cells?.[0]?.min).toBe(8)
    expect(list.items[0]!.cells?.[1]?.min).toBe(9)
    expect(list.items[0]!.cells?.[1]?.align).toBe('right')
  })

  it('renders the roster error above the list', () => {
    const node = remoteProviderListPanelNode({ rows: [], error: 'directory unavailable' }, t)
    expect(texts(node)).toContain('directory unavailable')
    const list = findList(node, REMOTE_PROVIDERS_LIST_ID)
    expect(list.items).toEqual([])
    expect(list.empty?.title).toBe('No providers reported by this Host')
  })
})

describe('remoteProviderModelsPanelNode', () => {
  it("lists one provider's models with their detail and current marker", () => {
    const node = remoteProviderModelsPanelNode({
      provider: 'deepseek',
      providerLabel: 'DeepSeek',
      rows: [model('chat', 'Chat', { current: true, detail: '64k context' }), model('reasoner', 'Reasoner')],
      error: undefined,
      note: undefined,
    }, t)
    expect((node as unknown as SurfaceNode).title).toBe('Models for DeepSeek')
    const list = findList(node, REMOTE_PROVIDER_MODELS_LIST_ID)
    expect(list.items.map(item => item.id)).toEqual(['chat', 'reasoner'])
    expect(list.items[0]).toMatchObject({ label: 'Chat', current: true, detail: '64k context' })
    expect(list.items[1]!.label).toBe('Reasoner')
    expect(list.items[1]!.detail).toBeUndefined()
    expect(list.items[1]!.current).toBeUndefined()
    expect(texts(node)).not.toContain('This provider has no models on this Host; configure it with /providers before switching.')
  })

  it('renders an explicit note when the provider has no models', () => {
    const note = 'This provider has no models on this Host; configure it with /providers before switching.'
    const node = remoteProviderModelsPanelNode({
      provider: 'deepseek',
      providerLabel: 'DeepSeek',
      rows: [],
      error: undefined,
      note,
    }, t)
    const list = findList(node, REMOTE_PROVIDER_MODELS_LIST_ID)
    expect(list.items).toEqual([])
    expect(list.empty?.title).toBe('This provider offers no models')
    expect(texts(node)).toContain(note)
  })

  it('renders the models error above the list', () => {
    const node = remoteProviderModelsPanelNode({
      provider: 'deepseek',
      providerLabel: 'DeepSeek',
      rows: [],
      error: 'catalog unavailable',
      note: undefined,
    }, t)
    expect(texts(node)).toContain('catalog unavailable')
    expect(findList(node, REMOTE_PROVIDER_MODELS_LIST_ID).items).toEqual([])
  })
})
