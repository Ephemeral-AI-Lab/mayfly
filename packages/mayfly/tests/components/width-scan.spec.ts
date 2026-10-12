/**
 * Width scan of the components area: every row of the conversation stream fits `render(width)` at every scan width,
 * for the adversarial strings (wide characters, ZWJ emoji, ANSI-laden and linked text).
 * @module components-width-scan
 */

import { describe, it } from 'vitest'
import type { MayflySemanticColors } from '../../src/core/types.ts'
import { compileMayflyUiNode } from '../../src/core/ui-compiler.ts'
import { TranscriptView, type StreamRow } from '../../src/components/transcript-view.ts'
import { ADVERSARIAL, SCAN_WIDTHS, expectLinesFit } from '../core/width-scan.ts'
import { fakeMayflyComponents } from '../transcript/helpers.ts'
import { COLORS } from '../transcript/status-fakes.ts'

/** Compile the stream the way a mounted slot paints it, and render it at one width. */
function render(rows: readonly StreamRow[], width: number, queued = ''): string[] {
  const node = TranscriptView({
    turns: [
      { id: 'turn:1', time: '10:02', rows: [{ kind: 'prompt', id: 'u0', text: 'first', images: [], open: false }] },
      { id: 'turn:2', time: '10:03', rows },
    ],
    queued: queued === '' ? [] : [{ id: 'q', text: queued, suffix: '⏎ queued' }],
  })
  const compiled = compileMayflyUiNode(node, {
    components: fakeMayflyComponents(),
    colors: COLORS as MayflySemanticColors,
    getViewport: () => ({ columns: width, rows: 1000 }),
    screenMode: 'main',
    emit: () => {},
  })
  return (compiled.ok ? compiled.value.component : compiled.errorComponent).render(width)
}

describe('components width-scan', () => {
  for (const { name, text } of ADVERSARIAL) {
    it(`TranscriptView rows survive ${name}`, () => {
      const rows: StreamRow[] = [
        { kind: 'prompt', id: 'u1', text, images: [`[image] 1 · ${text}`], open: false },
        { kind: 'prompt', id: 'u2', text: `${text}\n${text}\n${text}\n${text}\n${text}\n${text}`, images: [], open: false },
        { kind: 'header', id: 'h1', mood: 'stopped', open: false, label: text, tail: ` · ${text}` },
        { kind: 'title', id: 't1', text, failed: text },
        { kind: 'reasoning', id: 'r1', label: text, preview: text },
        { kind: 'step', id: 's1', state: 'error', title: text, detail: text },
        { kind: 'answer', id: 'a1', text: `${text}\n\n${text}` },
        { kind: 'compaction', id: 'c1', state: 'ok', text },
        { kind: 'error', id: 'e1', text },
        { kind: 'interrupted', id: 'i1', text },
        { kind: 'note', id: 'n1', text },
      ]
      for (const width of SCAN_WIDTHS) expectLinesFit(`TranscriptView/${name}`, render(rows, width, text), width)
    })
  }
})
