/** Authoritative Host conversation DTO ownership and renderer type reuse. @module */
import { readFile } from 'node:fs/promises'
import { expect, expectTypeOf, it } from 'vitest'
import type * as Host from '../../../host/src/conversation/types.ts'
import type * as Shared from '../../src/conversation/types.ts'

it('shares exact Host conversation wire types without a second declaration or runtime import', async () => {
  expectTypeOf<Shared.ConversationProjection>().toEqualTypeOf<Host.ConversationProjection>()
  expectTypeOf<Shared.ConversationFacts>().toEqualTypeOf<Host.ConversationFacts>()
  expectTypeOf<Shared.ConversationAttachment>().toEqualTypeOf<Host.ConversationAttachment>()
  expectTypeOf<Shared.ConversationProjectionState>().toEqualTypeOf<Host.ConversationProjectionState>()
  const source = await readFile(new URL('../../src/conversation/types.ts', import.meta.url), 'utf8')
  expect(source).toContain("export type * from '@ephemeral-ai/mayfly-host/types'")
  expect(source).not.toMatch(/\b(?:interface|type)\s+Conversation\w*\s*(?:\{|=)/u)
})
