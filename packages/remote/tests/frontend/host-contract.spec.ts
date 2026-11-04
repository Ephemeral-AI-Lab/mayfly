/** Generated namespace ownership, including stream output and uplink types. @module */
import { readFile } from 'node:fs/promises'
import { expect, expectTypeOf, it } from 'vitest'
import type { TypertRemoteNamespaceMap, RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import type { MayflyAuthorizationAnswer, MayflyAuthorizationFrame, MayflyHostSessionRequest, MayflyWorkflowFrame } from '@ephemeral-ai/mayfly-host/types'
import type { MayflyHostRemote } from '../../src/frontend/host-contract.ts'

it('derives the complete Mayfly namespace from its generated augmentation', async () => {
  expectTypeOf<MayflyHostRemote>().toEqualTypeOf<TypertRemoteNamespaceMap['mayflyHost']>()
  expectTypeOf<ReturnType<MayflyHostRemote['authorize']>>().toEqualTypeOf<RemoteStreamHandle<MayflyAuthorizationFrame, MayflyAuthorizationAnswer>>()
  expectTypeOf<ReturnType<MayflyHostRemote['followWorkflow']>>().toEqualTypeOf<RemoteStreamHandle<MayflyWorkflowFrame, never>>()
  expectTypeOf<Parameters<MayflyHostRemote['followWorkflow']>>().toEqualTypeOf<[MayflyHostSessionRequest, (AbortSignal | undefined)?]>()
  const source = await readFile(new URL('../../src/frontend/host-contract.ts', import.meta.url), 'utf8')
  expect(source).toContain("TypertRemoteNamespaceMap['mayflyHost']")
  expect(source).not.toMatch(/interface MayflyHostRemote/u)
})
