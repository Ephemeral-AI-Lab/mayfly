import { describe, expect, it } from 'vitest'
import * as root from '../src/index.ts'
import * as client from '../src/client.ts'
import * as frontend from '../src/frontend/index.ts'
import * as conversation from '../src/conversation/index.ts'
import * as transcript from '../src/transcript/index.ts'

describe('public module projections', () => {
  it('exposes root, client, frontend, conversation, and transcript entries', () => {
    expect(root.createHostClient).toBeTypeOf('function')
    expect(root.runRemoteFrontend).toBeTypeOf('function')
    expect(root.RemoteApp).toBeTypeOf('function')
    expect(client.smokeHostClient).toBeTypeOf('function')
    expect(frontend.HostRegistry).toBeTypeOf('function')
    expect(frontend.HostActions).toBeTypeOf('function')
    expect(conversation.isAppendSurfaceEvent).toBeTypeOf('function')
    expect(transcript.RemoteConversationModelSource).toBeTypeOf('function')
  })

  it('accepts only append-origin surface events', () => {
    expect(conversation.isAppendSurfaceEvent({} as never)).toBe(true)
    expect(conversation.isAppendSurfaceEvent({ surfaceOp: 'append' } as never)).toBe(true)
    expect(conversation.isAppendSurfaceEvent({ surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } } as never)).toBe(false)
  })
})
