/**
 * Centered status projection of primary and auxiliary Agent views.
 * @module agent-view-status
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { MayflyStatusService } from '../../../ui/src/services.ts'
import { MayflyCurrentAgentService } from '../../src/app/current-agent.ts'
import * as statusPlugin from '../../src/interaction/agent-view-status.ts'

function agent(id: string): Agent { return { id: SessionId(id) } as Agent }

describe('mayfly-agent-view-status', () => {
  it('shows the retained target, active side, and readonly state', async () => {
    const ctx = new Context()
    const primary = agent('primary')
    const child = agent('child')
    const btw = agent('btw')
    const live = new Map([[String(primary.id), primary], [String(child.id), child], [String(btw.id), btw]])
    ctx.reflect.provide('agents', { get: (id: unknown) => live.get(String(id)) })
    const current = new MayflyCurrentAgentService(ctx)
    current.select(primary)
    const statuses = new MayflyStatusService(ctx)
    const fiber = await ctx.plugin(statusPlugin)
    const entry = () => statuses.list().find(candidate => candidate.id === 'mayfly.status.agent-view')!
    expect(entry().node).toBeNull()

    current.openAuxiliary({
      kind: 'subagent', sessionId: 'child', parentSessionId: 'primary', label: 'reviewer', mode: 'continuable',
    })
    expect(entry().definition).toMatchObject({ band: 'center', priority: 0 })
    expect(entry().node).toMatchObject({ kind: 'rich-text' })
    expect(JSON.stringify(entry().node)).toContain('SUBAGENT · reviewer')

    current.toggleAuxiliary()
    expect(JSON.stringify(entry().node)).toContain('MAIN')
    live.delete('child')
    ctx.emit('agent/disposed', { agent: child } as never)
    expect(JSON.stringify(entry().node)).toContain('read-only')
    current.toggleAuxiliary()
    expect(JSON.stringify(entry().node)).toContain('read-only')
    current.closeAuxiliary()
    expect(entry().node).toBeNull()
    current.openAuxiliary({ kind: 'btw', sessionId: 'btw', parentSessionId: 'primary', label: 'side' })
    expect(JSON.stringify(entry().node)).toContain('BTW · side')
    await fiber.dispose()
    expect(statuses.list()).toEqual([])
  })
})
