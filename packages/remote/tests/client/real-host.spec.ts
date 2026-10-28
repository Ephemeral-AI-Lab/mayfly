/** Opt-in end-to-end proof against a real dsh Host startup URL. */
import { describe, expect, it } from 'vitest'
import { smokeHostClient } from '../../src/client/smoke.ts'
import { HostKey } from '../../src/client/types.ts'

const startupUrl = process.env.MAYFLY_DSH_STARTUP_URL

describe.skipIf(startupUrl === undefined)('real dsh Host Client', () => {
  it('lists, creates, opens, and detaches without starting a turn', async () => {
    const result = await smokeHostClient({
      key: HostKey('real-smoke'),
      startupUrl: startupUrl!,
      cwd: process.cwd(),
    })
    expect(result.opened).toEqual(result.created)
    expect(result.listedAfter).toBeGreaterThan(result.listedBefore)
  }, 60_000)
})
