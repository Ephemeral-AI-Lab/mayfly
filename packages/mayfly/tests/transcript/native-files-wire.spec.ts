/** Render actual Host-verified builtin filesystem wire facts through the shared reference components. @module */
import { describe, expect, it } from 'vitest'
import { conversationProjectionSchema } from '../../src/conversation/projection.ts'
import { conversationTranscriptModel } from '../../src/transcript/conversation-model.ts'
import { StreamFacts } from '../../src/transcript/stream-facts.ts'
import { TranscriptPresentationPolicy } from '../../src/transcript/presentation-policy.ts'
import { NO_DISCLOSURE } from '../../src/transcript/disclosure.ts'
import { TranscriptView } from '../../src/components/transcript-view.ts'
import { compileMayflyUiNode } from '../../src/core/ui-compiler.ts'
import { visibleWidth } from '../../src/core/width.ts'
import { interpolateLocaleMessage } from '../../src/frontend/locale.ts'
import { fakeMayflyComponents } from './helpers.ts'
import { COLORS } from './status-fakes.ts'
import transport from '../../../remote/tests/fixtures/native-files-transport.json' with { type: 'json' }

describe('Host builtin filesystem wire rendering', () => {
  it('shows native line counts, applied diff and Unicode write bodies within narrow and wide widths', () => {
    const projection = conversationProjectionSchema.parse(transport.projection)
    const model = conversationTranscriptModel(projection, { get: () => undefined, getForCall: (_name, callId) => {
      const view = Reflect.get(transport.presentations.session, callId ?? '') as { readonly call?: unknown, readonly result?: unknown } | undefined
      return view === undefined ? undefined : { presentCall: () => view.call, presentResult: () => view.result }
    } })
    const policy = new TranscriptPresentationPolicy()
    policy.apply({ transcriptView: 'verbose' })
    const facts = new StreamFacts().build(model, { policy: policy.snapshot(), disclosure: NO_DISCLOSURE, liveTurnHeader: false, t: interpolateLocaleMessage, queued: [], now: 1767258000000 })
    const node = TranscriptView(facts)
    for (const width of [12, 40, 80, 120, 240]) {
      const rendered = compileMayflyUiNode(node, { components: fakeMayflyComponents(), colors: COLORS, getViewport: () => ({ columns: width, rows: 100 }), screenMode: 'main', emit() {} })
      expect(rendered.ok).toBe(true)
      if (!rendered.ok) throw new Error(rendered.message)
      const rows = rendered.value.component.render(width)
      for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width)
      if (width === 240) {
        const text = rows.join('\n')
        expect(text).toContain('2 lines')
        expect(text).toContain('before parity change')
        expect(text).toContain('after parity change')
        expect(text).toContain('Native delivered file')
        expect(text).toContain('Exact preview 你好 🪰')
        expect(text).toContain(`${transport.provenance.cwd}/parity-deliverable.txt`)
      }
    }
  })
})
