/** Real native filesystem event/presenter transport into the public reference transcript mapper. @module */
import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { conversationTranscriptModel } from '../../src/transcript/conversation-model.ts'
import type { ConversationProjection } from '@ephemeral-ai/mayfly-host/types'
import { HostKey } from '../../src/client/types.ts'
import type { MayflyPresentToolsResponse } from '../../src/hosts/host-contract.ts'
import { RemoteToolPresentationCache, type RemoteToolPresentationRequest } from '../../src/hosts/tool-presentations.ts'
import fixture from '../fixtures/native-files-transport.json' with { type: 'json' }
import { good, tick } from '../app/task-feature-fixture.ts'

describe('native builtin filesystem cards', () => {
  it('preserves actual Read line counts, Edit diffs and the Write preview, under the paths the model gave, through the Host/Remote boundary', async () => {
    // This wire fixture is verified against actual native definitions and
    // Host folds by host/tests/remote/native-files-cards.spec.ts. Keep Host
    // source and the shared renderer's source in their own TS native realms.
    const projection = fixture.projection as ConversationProjection
    const presentations = fixture.presentations as MayflyPresentToolsResponse['presentations']
    const native = { get: () => undefined, getForCall: (_name: string, callId: string) => {
      const value = presentations.session?.[callId ?? '']
      return value === undefined ? undefined : { presentCall: () => value.call, presentResult: () => value.result }
    } }
    const present = vi.fn(async (request: RemoteToolPresentationRequest, signal: AbortSignal) => {
      signal.throwIfAborted()
      expect(request.entries.map(entry => entry.callId)).toEqual(Object.keys(presentations.session!))
      return good({ presentations })
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
      { kind: 'transcript-tool', change: { path: 'parity-change.txt', added: 1, removed: 1, hunks: [{ before: 'before parity change\nunchanged line', after: 'after parity change\nunchanged line' }] } },
      { kind: 'transcript-tool', change: { path: 'parity-deliverable.txt', write: { lines: 2, head: ['Native delivered file', 'Exact preview 你好 🪰'] } } },
      { kind: 'transcript-tool' },
    ])
    expect(present).toHaveBeenCalledOnce()
    await cache.dispose()
  })
})
