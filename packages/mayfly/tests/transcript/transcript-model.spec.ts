import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { MayflyComponent, MayflyScreen, MayflySemanticColors } from '../../src/core/index.ts'
import type { TranscriptEntryModel, TranscriptModel } from '../../src/frontend/index.ts'
import { appendTranscriptNode, createTranscriptModel, TRANSCRIPT_MODEL_WINDOW, TranscriptController, TranscriptModelComponent, type TranscriptModelRenderer } from '../../src/transcript/transcript-model.ts'
import { ToolCallComponent } from '../../src/transcript/components.ts'
import { DEFAULT_TRANSCRIPT_PRESENTATION, TranscriptPresentationPolicy } from '../../src/transcript/presentation-policy.ts'
import { setThinkingTimers } from '../../src/transcript/thinking.ts'
import { fakeMayflyComponents } from './helpers.ts'
import { COLORS } from './status-fakes.ts'
import { mountFakeScreenSlot } from '../core/fake-screen-slot.ts'

function fixture() {
  const children: MayflyComponent[] = []
  const add = (component: MayflyComponent) => { children.push(component); return () => { const index = children.indexOf(component); if (index >= 0) children.splice(index, 1) } }
  const screen = {
    addChild: add,
    mountContentSlot: (id: string, component: MayflyComponent | null) => mountFakeScreenSlot(id, component, add, () => {}, () => {}),
    contentChanged: () => false,
    requestRender: () => {},
  } as unknown as MayflyScreen
  return { screen, children }
}
const model = (id: string, entries = [{ kind: 'text' as const, content: 'entry' }], generation = 0): TranscriptModel => ({ kind: 'transcript', id, generation, entries })

const semanticEntries = (): TranscriptEntryModel[] => [
  {
    kind: 'transcript-user', id: 'user', seq: 1, turn: 1, text: 'user text', images: [
      { attachmentId: 'image-1', mediaType: 'image/png', bytes: 12, width: 4, height: 3 },
      { attachmentId: 'image-2', mediaType: 'image/jpeg', bytes: 20, width: 8, height: 6, name: 'plot.jpg', originalDimensions: { width: 16, height: 12 } },
    ],
  },
  { kind: 'transcript-assistant', id: 'assistant', seq: 2, turn: 1, step: 0, text: 'assistant text', streaming: false },
  { kind: 'transcript-thinking', id: 'thinking', seq: 3, turn: 1, step: 0, text: 'thinking text', streaming: false },
  {
    kind: 'transcript-tool', id: 'tool-result', seq: 4, turn: 1, step: 0, callId: 'call-1', name: 'read', arguments: '{}', startedAt: 100,
    result: { text: 'result summary', fullText: 'result full', isError: false, endedAt: 120 },
  },
  {
    kind: 'transcript-tool', id: 'tool-text', seq: 5, turn: 1, step: 0, callId: 'call-2', name: 'bash', arguments: '{"command":"pwd"}', startedAt: 130,
    result: { text: 'text only', isError: false, endedAt: 140 },
  },
  { kind: 'transcript-tool', id: 'tool-pending', seq: 6, turn: 1, step: 0, callId: 'call-3', name: 'custom', arguments: '{bad', startedAt: 150 },
  {
    kind: 'transcript-tool', id: 'tool-presented', seq: 7, turn: 1, step: 0, callId: 'call-4', name: 'read', arguments: '{}', startedAt: 160,
    presentation: { kind: 'tool', id: 'presentation', name: 'read', call: { kind: 'text', content: 'call view' }, result: { kind: 'text', content: 'result view' } },
  },
  { kind: 'transcript-error', id: 'error-code', seq: 8, turn: 1, message: 'down', code: 'HTTP_404' },
  { kind: 'transcript-error', id: 'error', seq: 9, turn: 1, message: 'unknown' },
  { kind: 'transcript-interrupted', id: 'interrupted', seq: 10, turn: 1 },
]

function renderer(
  requestRender = () => {},
  presentation?: TranscriptPresentationPolicy,
  semantic = true,
  t?: TranscriptModelRenderer['t'],
): TranscriptModelRenderer {
  return {
    colors: COLORS as MayflySemanticColors,
    components: fakeMayflyComponents(),
    images: () => ({}),
    requestRender,
    semantic,
    ...(t === undefined ? {} : { t }),
    ...(presentation === undefined ? {} : { presentation }),
  }
}

const plainRenderer = (): TranscriptModelRenderer => renderer(() => {}, undefined, false)

afterEach(() => {
  setThinkingTimers(undefined)
})

describe('TranscriptController', () => {
  it('mounts one dynamic source and refreshes canonical rows', () => { const ctx = new Context(); const f = fixture(); const service = new TranscriptController(ctx, f.screen, { renderer: plainRenderer() }); let current = model('one'); service.setSource(() => current); const component = f.children[0]!; expect(component.render(20)).toEqual(['entry']); service.refreshLocale(); current = model('one', [{ kind: 'fields', rows: [{ label: 'a', value: [{ text: 'b' }] }] }]); service.refresh(); expect(component.render(20)).toEqual(['a: b']); service.dispose(); expect(component.render(20)).toEqual([]); service.refresh() })
  it('handles a null source, late attach, source replacement, and unload', () => { const ctx = new Context(); const service = new TranscriptController(ctx, undefined, { renderer: plainRenderer() }); service.setSource(() => null); service.refresh(); const f = fixture(); service.attach(f.screen); expect(f.children).toHaveLength(1); expect(f.children[0]!.render(20)).toEqual([]); service.setSource(model('active')); expect(f.children).toHaveLength(1); expect(f.children[0]!.render(20)).toEqual(['entry']); service.dispose(); expect(f.children).toHaveLength(0) })
  it('renders null and nested canonical nodes safely', () => { expect(new TranscriptModelComponent(() => null, plainRenderer()).render(10)).toEqual([]); const c = new TranscriptModelComponent(() => model('nested', [{ kind: 'sections', sections: [{ title: 's', body: { kind: 'code', code: 'abcdef' } }] }]), plainRenderer()); expect(c.render(3)).toEqual(['\x1b[1ms\x1b[22m', 'abc', 'def']); c.invalidate() })
  it('renders a static source and disposes its mounted child', () => { const f = fixture(); const service = new TranscriptController(new Context(), f.screen, { renderer: plainRenderer() }); service.setSource(model('static')); expect(f.children[0]!.render(20)).toEqual(['entry']); service.dispose(); expect(f.children).toHaveLength(0) })
  it('returns a bounded viewport window with total row metadata', () => { const component = new TranscriptModelComponent(() => model('window', Array.from({ length: 10 }, (_, index) => ({ kind: 'text' as const, content: String(index) }))), plainRenderer()); expect(component.renderWindow(20, 2, 3)).toEqual({ rows: ['5', '6', '7'], total: 10 }) })
  it('renders the complete entry history and cleans up on reattach', () => { const entries = Array.from({ length: TRANSCRIPT_MODEL_WINDOW + 3 }, (_, index) => ({ kind: 'text' as const, content: String(index) })); const component = new TranscriptModelComponent(() => model('bounded', entries), plainRenderer()); const rows = component.render(20); expect(rows).toHaveLength(TRANSCRIPT_MODEL_WINDOW + 3); expect(rows[0]).toBe('0'); const first = fixture(); const second = fixture(); const service = new TranscriptController(new Context(), first.screen, { renderer: plainRenderer() }); service.setSource(model('reattach')); service.attach(second.screen); expect(first.children).toHaveLength(0); expect(second.children).toHaveLength(1); service.dispose() })
  it('builds immutable replay/live fixtures without folding session events', () => { const replay = createTranscriptModel('session', [{ kind: 'text', content: 'user' }, { kind: 'code', code: 'assistant' }]); expect(replay.streaming).toBeUndefined(); expect(Object.isFrozen(replay.entries)).toBe(true); const live = appendTranscriptNode(replay, { kind: 'text', content: 'stream' }, true); expect(live.streaming).toBe(true); expect(live.entries).toHaveLength(3); const settled = appendTranscriptNode(live, { kind: 'text', content: 'done' }, false); expect(settled.streaming).toBe(false); expect(replay.entries).toHaveLength(2) })

  it('renders every semantic entry through the plain renderer fallback', () => {
    const component = new TranscriptModelComponent(() => model('plain', semanticEntries()), plainRenderer())
    component.setExpanded(true)
    const rows = component.render(80)
    expect(rows).toEqual(expect.arrayContaining([
      'user text',
      'assistant text',
      'thinking text',
      'result full',
      'text only',
      'custom({bad)',
      'read',
      'down (HTTP_404)',
      'unknown',
      'Interrupted',
    ]))
    component.setExpanded(true)
    component.invalidate()
    component.dispose()
  })

  it('summarizes envelope results and pending arguments in the plain fallback', () => {
    const envelope = '<path>src/a.ts</path>\n<type>file</type>\n<content>\n1: x\n\n(Showing lines 1-1 of 9. Use offset=2 to continue.)\n</content>'
    const entries: TranscriptEntryModel[] = [
      {
        kind: 'transcript-tool', id: 'enveloped', seq: 1, turn: 1, step: 0, callId: 'c1', name: 'read', arguments: '{}', startedAt: 1,
        result: { text: envelope, isError: false, endedAt: 2 },
      },
      { kind: 'transcript-tool', id: 'argish', seq: 2, turn: 1, step: 0, callId: 'c2', name: 'write', arguments: '{"file_path":"a.ts"}', startedAt: 3 },
    ]
    const rows = new TranscriptModelComponent(() => model('plain', entries), plainRenderer()).render(80)
    expect(rows).toContain('src/a.ts · lines 1-1 of 9')
    expect(rows).toContain('write')
    expect(rows).toContain('  file_path: a.ts')
  })

  it('renders read groups through the tree component with tools-category expansion', () => {
    const groupEntry: TranscriptEntryModel = {
      kind: 'transcript-read-group', id: 'read-group:r1', seq: 4, turn: 1, step: 0,
      reads: [
        { callId: 'r1', seq: 4, turn: 1, step: 0, path: 'src/a.ts', range: { first: 1, last: 3 }, totalLines: 9, state: 'ok', previewLines: [{ number: 1, text: 'first line' }] },
        { callId: 'r2', seq: 5, turn: 1, step: 0, path: 'src/a.ts', requestedRange: { first: 4, last: 6 }, state: 'pending' },
        { callId: 'r3', seq: 6, turn: 1, step: 0, path: 'gone.ts', state: 'error', error: 'file not found' },
      ],
    }
    const collapsedRows = new TranscriptModelComponent(() => model('reads', [groupEntry]), renderer()).render(80)
    expect(collapsedRows.join('\n')).toContain('Reading 2 files')
    expect(collapsedRows.join('\n')).toContain('├─ src/a.ts')
    expect(collapsedRows.join('\n')).toContain('└─ gone.ts')
    expect(collapsedRows.join('\n')).not.toContain('first line')

    const expanded = new TranscriptModelComponent(() => model('reads', [groupEntry]), renderer())
    expanded.setExpanded(true)
    const expandedText = expanded.render(80).join('\n')
    expect(expandedText).toContain('first line')
    expect(expandedText).toContain('1  first line')

    const plain = new TranscriptModelComponent(() => model('reads', [groupEntry]), plainRenderer()).render(80).join('\n')
    expect(plain).toContain('Read 3 calls: src/a.ts, gone.ts')
    const plainSingle = new TranscriptModelComponent(() => model('reads', [{
      kind: 'transcript-read-group', id: 'read-group:solo', seq: 1, turn: 1, step: 0,
      reads: [{ callId: 'solo', seq: 1, turn: 1, step: 0, path: 'solo.ts', state: 'ok' }],
    }]), plainRenderer()).render(80).join('\n')
    expect(plainSingle).toContain('Read 1 call: solo.ts')
    const plainPathless = new TranscriptModelComponent(() => model('reads', [{
      kind: 'transcript-read-group', id: 'read-group:none', seq: 1, turn: 1, step: 0,
      reads: [{ callId: 'none', seq: 1, turn: 1, step: 0, state: 'ok' }],
    }]), plainRenderer()).render(80).join('\n')
    expect(plainPathless).toContain('Read 1 call')
    expect(plainPathless).not.toContain(':')
  })

  it('renders search groups through the tree component with tools-category expansion', () => {
    const searchEntry: TranscriptEntryModel = {
      kind: 'transcript-search-group', id: 'search-group:s1', seq: 3, turn: 1, step: 0,
      searches: [
        { callId: 's1', seq: 3, turn: 1, step: 0, pattern: 'const', shape: 'matches', files: [{ path: 'a.ts', count: 2, previews: [{ lineNumber: 1, line: 'const hit' }] }], state: 'ok' },
        { callId: 's2', seq: 4, turn: 1, step: 0, pattern: '*.ts', shape: 'paths', paths: ['a.ts'], pathsTotal: 2, total: 2, state: 'ok' },
      ],
    }
    const collapsedText = new TranscriptModelComponent(() => model('searches', [searchEntry]), renderer()).render(80).join('\n')
    expect(collapsedText).toContain('Searched 2 patterns')
    expect(collapsedText).toContain('├─ "const" · 1 file, 2 matches')
    expect(collapsedText).not.toContain('const hit')

    const expanded = new TranscriptModelComponent(() => model('searches', [searchEntry]), renderer())
    expanded.setExpanded(true)
    const expandedText = expanded.render(80).join('\n')
    expect(expandedText).toContain('1: const hit')
    expect(expandedText).toContain('… 1 more paths')

    const plain = new TranscriptModelComponent(() => model('searches', [searchEntry]), plainRenderer()).render(80).join('\n')
    expect(plain).toContain('Searched 2 times: const, *.ts')
    const plainBare = new TranscriptModelComponent(() => model('searches', [{
      kind: 'transcript-search-group', id: 'search-group:bare', seq: 1, turn: 1, step: 0,
      searches: [{ callId: 'bare', seq: 1, turn: 1, step: 0, state: 'ok' }],
    }]), plainRenderer()).render(80).join('\n')
    expect(plainBare).toContain('Searched 1 time: search')
  })

  it('reconciles semantic renderer components, forwards expansion, and disposes retired entries', () => {
    let current = model('semantic', semanticEntries())
    const requestRender = vi.fn()
    const component = new TranscriptModelComponent(() => current, renderer(requestRender))
    component.setExpanded(true)
    const first = component.render(80)
    expect(first.some(row => row.includes('user text'))).toBe(true)
    expect(first.some(row => row.includes('assistant text'))).toBe(true)
    expect(first.some(row => row.includes('thinking text'))).toBe(true)
    expect(first.some(row => row.includes('result full'))).toBe(true)
    expect(first.some(row => row.includes('result view'))).toBe(true)
    expect(first.some(row => row.includes('Used') && row.includes('read'))).toBe(true)
    expect(first.some(row => row.includes('Ran a command'))).toBe(true)
    expect(first.some(row => row.includes('request failed'))).toBe(true)
    expect(first.some(row => row.includes('interrupted'))).toBe(true)

    expect(component.render(80)).toBe(first)
    component.setExpanded(false)
    expect(component.render(80)).not.toBe(first)
    component.invalidate()
    const entries = semanticEntries()
    entries[1] = { kind: 'transcript-assistant', id: 'assistant', seq: 2, turn: 1, step: 0, text: 'changed answer', streaming: false }
    current = model('semantic', [entries[1]!, entries[2]!, { kind: 'text', content: 'plain tail' }])
    const changed = component.render(80)
    expect(changed.some(row => row.includes('changed answer'))).toBe(true)
    expect(changed.some(row => row.includes('plain tail'))).toBe(true)
    component.dispose()
    expect(component.render(80)).toEqual(changed)
    current = null as never
    expect(component.render(80)).toEqual([])
  })

  it('reprojects cached transcript chrome on a locale refresh', () => {
    let locale: 'en' | 'zh' = 'en'
    const translate: NonNullable<TranscriptModelRenderer['t']> = (key, values) => {
      const message = locale === 'zh'
        ? {
            '■ interrupted': '■ 已中断',
            '... ({remaining} more lines, {total} total, ctrl+o to expand)': '...（还有 {remaining} 行，共 {total} 行，按 Ctrl-O 展开）',
          }[key] ?? key
        : key
      return message.replace(/\{(remaining|total)\}/gu, (placeholder, name) => String(values?.[name] ?? placeholder))
    }
    const f = fixture()
    const service = new TranscriptController(new Context(), f.screen, {
      renderer: renderer(() => {}, undefined, true, translate),
    })
    service.setSource(model('localized', [
      { kind: 'transcript-user', id: 'user-long', seq: 1, turn: 1, text: Array.from({ length: 12 }, () => 'line').join('\n'), images: [] },
      { kind: 'transcript-interrupted', id: 'interrupted', seq: 2, turn: 1 },
    ]))
    const component = f.children[0] as TranscriptModelComponent
    expect(component.render(80).join('\n')).toContain('more lines')
    locale = 'zh'
    service.refreshLocale()
    const localized = component.render(80).join('\n')
    expect(localized).toContain('还有 9 行')
    expect(localized).toContain('■ 已中断')
    service.dispose()
  })

  it('reuses aggregate rows for one streaming model identity and rerenders a replacement', () => {
    let current = createTranscriptModel('streaming', semanticEntries(), true)
    const component = new TranscriptModelComponent(() => current, renderer())
    const first = component.render(80)
    expect(component.render(80)).toBe(first)
    current = appendTranscriptNode(current, { kind: 'text', content: 'fresh stream data' }, true)
    const next = component.render(80)
    expect(next).not.toBe(first)
    expect(next.at(-1)).toContain('fresh stream data')
    component.dispose()
  })

  it('renders only the assistant entry whose updatedSeq changed', () => {
    const components = fakeMayflyComponents()
    const createMarkdown = components.createMarkdown.bind(components)
    let markdownRenders = 0
    components.createMarkdown = options => {
      const markdown = createMarkdown(options)
      const render = markdown.render.bind(markdown)
      markdown.render = width => { markdownRenders += 1; return render(width) }
      return markdown
    }
    const view = (secondText: string, secondRevision: number, third = false): TranscriptModel => createTranscriptModel('incremental', [
      { kind: 'transcript-assistant', id: 'a1', seq: 1, updatedSeq: 1, turn: 1, step: 0, text: 'stable', streaming: false },
      { kind: 'transcript-assistant', id: 'a2', seq: 2, updatedSeq: secondRevision, turn: 1, step: 1, text: secondText, streaming: true },
      ...(third ? [{ kind: 'transcript-assistant' as const, id: 'a3', seq: 3, updatedSeq: 3, turn: 1, step: 2, text: 'appended', streaming: true }] : []),
    ], true)
    let current = view('partial', 2)
    const component = new TranscriptModelComponent(() => current, { ...renderer(), components })
    const first = component.render(80)
    expect(markdownRenders).toBe(2)
    expect(component.render(80)).toBe(first)
    expect(markdownRenders).toBe(2)

    current = view('partial plus token', 4)
    component.render(80)
    expect(markdownRenders).toBe(3)

    current = view('partial plus token', 4, true)
    component.render(80)
    expect(markdownRenders).toBe(4)
    component.dispose()
  })

  it('drops colliding entry caches when the session generation changes', () => {
    const view = (generation: number, text: string): TranscriptModel => createTranscriptModel('official-conversation', [{
      kind: 'transcript-assistant', id: 'assistant:1:0', seq: 1, updatedSeq: 1, turn: 1, step: 0, text, streaming: false,
    }], false, generation)
    let current = view(1, 'session A')
    const component = new TranscriptModelComponent(() => current, renderer())
    expect(component.render(80).join('\n')).toContain('session A')

    current = view(2, 'session B')
    const switched = component.render(80).join('\n')
    expect(switched).toContain('session B')
    expect(switched).not.toContain('session A')
    component.dispose()
  })

  it('retains the tool component when a pending call receives its result', () => {
    const update = vi.spyOn(ToolCallComponent.prototype, 'update')
    const view = (revision: number, settled: boolean): TranscriptModel => createTranscriptModel('tools', [{
      kind: 'transcript-tool', id: 'tool:call', seq: 1, updatedSeq: revision, turn: 1, step: 0,
      callId: 'call', name: 'read', arguments: '{}', startedAt: 1,
      ...(settled ? {
        result: { text: 'done', fullText: 'done', isError: false, endedAt: 2 },
        presentation: {
          kind: 'tool' as const, id: 'call', name: 'read',
          call: { kind: 'text' as const, content: 'presented call' },
          result: { kind: 'text' as const, content: 'presented result' },
        },
      } : {}),
    }])
    let current = view(1, false)
    const component = new TranscriptModelComponent(() => current, renderer())
    expect(component.render(80).join('\n')).toContain('Using')

    current = view(2, true)
    const settled = component.render(80).join('\n')
    expect(update).toHaveBeenCalledOnce()
    expect(settled).toContain('Used')
    expect(settled).toContain('presented call')
    component.dispose()
    update.mockRestore()
  })

  it('updates cached read and search groups by id and revision', () => {
    const view = (revision: number, suffix: string): TranscriptModel => createTranscriptModel('groups', [
      {
        kind: 'transcript-read-group', id: 'read-group:cached', seq: 1, updatedSeq: revision, turn: 1, step: 0,
        reads: [{ callId: 'read', seq: 1, turn: 1, step: 0, path: `${suffix}.ts`, state: 'ok' }],
      },
      {
        kind: 'transcript-search-group', id: 'search-group:cached', seq: 2, updatedSeq: revision, turn: 1, step: 0,
        searches: [{ callId: 'search', seq: 2, turn: 1, step: 0, pattern: suffix, state: 'ok' }],
      },
    ])
    let current = view(1, 'before')
    const component = new TranscriptModelComponent(() => current, renderer())
    expect(component.render(80).join('\n')).toContain('before')

    current = view(2, 'after')
    const updated = component.render(80).join('\n')
    expect(updated).toContain('after.ts')
    expect(updated).toContain('after')
    expect(updated).not.toContain('before')
    component.dispose()
  })

  it('invalidates streaming aggregate rows when a thinking spinner advances', () => {
    let tick: (() => void) | undefined
    setThinkingTimers({
      setInterval: (callback) => {
        tick = callback
        return 1 as unknown as ReturnType<typeof setInterval>
      },
      clearInterval: () => {},
    })
    const requestRender = vi.fn()
    const current = createTranscriptModel('thinking-stream', [{
      kind: 'transcript-thinking', id: 'thinking-stream', seq: 1, turn: 1, step: 0, text: 'live', streaming: true,
    }], true)
    const component = new TranscriptModelComponent(() => current, renderer(requestRender))
    const first = component.render(80)

    tick?.()
    const next = component.render(80)
    expect(requestRender).toHaveBeenCalledOnce()
    expect(next).not.toBe(first)
    expect(next.join('\n')).toContain('⠙')
    component.dispose()
  })

  it('contains an image completion after its cached entry was pruned', async () => {
    const image = Promise.withResolvers<Uint8Array | undefined>()
    const onReady = vi.fn()
    let current = createTranscriptModel('late-image', [{
      kind: 'transcript-user', id: 'image-user', seq: 1, updatedSeq: 1, turn: 1, text: 'image',
      images: [{ attachmentId: 'image-id', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }],
    }])
    const component = new TranscriptModelComponent(() => current, {
      ...renderer(),
      images: () => ({ loadImage: () => image.promise, onReady }),
    })
    component.render(80)
    current = createTranscriptModel('late-image', [])
    component.render(80)
    image.resolve(new Uint8Array([1]))
    await image.promise
    await Promise.resolve()
    expect(onReady).toHaveBeenCalledOnce()
    expect(component.render(80)).toEqual([])
    component.dispose()
  })

  it('applies tree-local turn windows and recent Ctrl-O expansion', () => {
    const policy = new TranscriptPresentationPolicy()
    policy.apply({ windowTurns: 2, expandTurns: 1 })
    const entries: TranscriptEntryModel[] = [
      { kind: 'transcript-assistant', id: 'old', seq: 1, turn: 1, step: 0, text: 'old answer', streaming: false },
      { kind: 'transcript-thinking', id: 'middle', seq: 2, turn: 2, step: 0, text: 'middle one\nmiddle two\nmiddle three\nmiddle four', streaming: false },
      { kind: 'transcript-thinking', id: 'new', seq: 3, turn: 3, step: 0, text: 'new one\nnew two\nnew three\nnew four', streaming: false },
    ]
    const scoped = new TranscriptModelComponent(() => model('scoped', entries), renderer(() => {}, policy))
    scoped.setExpanded(true)
    const scopedText = scoped.render(80).join('\n')

    expect(scopedText).not.toContain('old answer')
    expect(scopedText).not.toContain('middle four')
    expect(scopedText).toContain('new four')
    expect(scopedText).toContain('ctrl+o to expand')

    const otherTree = new TranscriptModelComponent(() => model('default', entries), renderer())
    otherTree.setExpanded(true)
    const otherText = otherTree.render(80).join('\n')
    expect(otherText).toContain('old answer')
    expect(otherText).toContain('middle four')
  })

  it('reports tail-follow state across attach, refresh, source replacement, and dispose', () => {
    const ctx = new Context()
    const changed: boolean[] = []
    ctx.on('mayfly/transcript-content-changed', paused => changed.push(paused))
    const service = new TranscriptController(ctx, undefined, { renderer: plainRenderer() })
    service.refresh()
    service.setSource(model('first'))
    service.refresh()
    const f = fixture()
    let paused = true
    f.screen.contentChanged = () => paused
    service.attach(f.screen)
    service.setExpanded(true)
    service.refresh()
    paused = false
    service.setSource(model('second'))
    service.refresh()
    expect(changed).toEqual([true, false])
    service.dispose()
  })

  it('reports the shipped presentation policy without a renderer', () => {
    const service = new TranscriptController(new Context())
    expect(service.presentationPolicy()).toEqual(DEFAULT_TRANSCRIPT_PRESENTATION)
  })
})
