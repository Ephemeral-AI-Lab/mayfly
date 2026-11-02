/** Real native filesystem event/presenter transport into the reference transcript and terminal renderer. @module */
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { conversationTranscriptModel } from '@ephemeral-ai/mayfly/transcript'
import type { ConversationProjection } from '@ephemeral-ai/mayfly/conversation'
import { compileMayflyUiNode, visibleWidth } from '@ephemeral-ai/mayfly/core'
import { foldConversationProjection, initialConversationState } from '../../../host/src/conversation/projection.ts'
import { presentTool } from '../../../host/src/remote/presentation.ts'
import { nativeFilePresenters } from '../../../host/tests/remote/native-files-presenters.ts'
import { TranscriptView } from '../../../mayfly/src/components/transcript-view.ts'
import { StreamFacts } from '../../../mayfly/src/transcript/stream-facts.ts'
import { TranscriptPresentationPolicy } from '../../../mayfly/src/transcript/presentation-policy.ts'
import { NO_DISCLOSURE } from '../../../mayfly/src/transcript/disclosure.ts'
import { HostKey } from '../../src/client/types.ts'
import { RemoteToolPresentationCache, type RemoteToolPresentationRequest } from '../../src/frontend/tool-presentations.ts'
import fixture from '../fixtures/native-files-wave24.json' with { type: 'json' }
import { good, tick, translate } from '../remote/task-feature-fixture.ts'
import { fakeMayflyComponents, plain, plainColors } from '../remote/render-fixture.ts'

describe('native builtin filesystem cards', () => {
  it('preserves actual Read line counts, Edit diffs and absolute Write preview through the Host/Remote boundary', async () => {
    const state = fixture.events.reduce((state, event) => foldConversationProjection(state, event as never), initialConversationState())
    const projection: ConversationProjection = { entries: state.entries, streaming: state.active, settledSteps: state.finalizedSteps, turns: state.turns }
    const definitions = nativeFilePresenters()
    const native = { get: (name: string) => definitions.get(name) }
    const lookup = vi.fn((name: string, selected: Agent) => { expect(selected).toBe(agent); return definitions.get(name) })
    const agent = { ctx: { tools: { get: lookup } } } as unknown as Agent
    const present = vi.fn(async (request: RemoteToolPresentationRequest, signal: AbortSignal) => {
      signal.throwIfAborted()
      return good({ presentations: { session: Object.fromEntries(request.entries.map(entry => [entry.callId, presentTool(agent, entry)])) } })
    })
    const cache = new RemoteToolPresentationCache(() => ({ presentationRevision: 'native:0.2.2-alpha.2', present }))
    const ref = { host: HostKey('native'), sessionId: SessionId('session') }
    cache.source(ref, projection)
    await tick()
    const remote = conversationTranscriptModel(projection, cache.source(ref, projection))
    // The direct native definitions are the reference oracle; transport must
    // preserve every canonical view, not rederive cards from tool names.
    expect(remote).toEqual(conversationTranscriptModel(projection, native))
    expect(remote.entries).toMatchObject([
      { kind: 'transcript-read-group', reads: [{ callId: 'native_files_read', path: 'parity-change.txt', range: { first: 1, last: 2 }, totalLines: 2, previewLines: [{ number: 1, text: 'before parity change' }, { number: 2, text: 'unchanged line' }] }] },
      { kind: 'transcript-tool', change: { path: `${fixture.provenance.cwd}/parity-change.txt`, added: 1, removed: 1, hunks: [{ before: 'before parity change\nunchanged line', after: 'after parity change\nunchanged line' }] } },
      { kind: 'transcript-tool', change: { path: `${fixture.provenance.cwd}/parity-deliverable.txt`, write: { lines: 2, head: ['Native delivered file', 'Exact preview 你好 🪰'] } } },
      { kind: 'transcript-tool' },
    ])
    expect(present).toHaveBeenCalledOnce()
    expect(lookup).toHaveBeenCalledTimes(8)
    const policy = new TranscriptPresentationPolicy()
    policy.apply({ transcriptView: 'verbose' })
    const facts = new StreamFacts().build(remote, { policy: policy.snapshot(), disclosure: NO_DISCLOSURE, liveTurnHeader: false, t: translate, queued: [], now: 1767258000000 })
    const node = TranscriptView(facts)
    for (const width of [12, 40, 80, 120, 240]) {
      const rendered = compileMayflyUiNode(node, { components: fakeMayflyComponents(), colors: plainColors(), getViewport: () => ({ columns: width, rows: 100 }), screenMode: 'main', emit() {} })
      expect(rendered.ok).toBe(true)
      if (!rendered.ok) throw new Error(rendered.message)
      const rows = plain(rendered.value.component.render(width))
      for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width)
      if (width === 240) {
        const text = rows.join('\n')
        expect(text).toContain('2 lines')
        expect(text).toContain('before parity change')
        expect(text).toContain('after parity change')
        expect(text).toContain('Native delivered file')
        expect(text).toContain('Exact preview 你好 🪰')
        expect(text).toContain(`${fixture.provenance.cwd}/parity-deliverable.txt`)
      }
    }
    await cache.dispose()
  })
})
