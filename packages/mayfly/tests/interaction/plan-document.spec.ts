/** Plan documents append into the conversation flow for the request's lifetime.
 * @module @ephemeral-ai/mayfly/tests/interaction/plan-document
 */
import { Context } from '@deepseek-ai/cordis'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { afterEach, describe, expect, it } from 'vitest'
import type { MayflyUiNode } from '../../../ui/src/index.ts'
import { STREAM_GUTTER } from '../../src/core/gutter.ts'
import { mountPlanDocument, planDocumentNode } from '../../src/interaction/plan-document.ts'
import { FakeMayflyComponents, FakeScreen, FakeTheme } from './fakes.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  const screen = new FakeScreen()
  ctx.provide('mayflyScreen', screen as never)
  ctx.provide('mayflyComponents', new FakeMayflyComponents() as never)
  ctx.provide('mayflyTheme', new FakeTheme() as never)
  return { ctx, screen }
}

const question: AskUserQuestionItem = { id: 'plan', question: 'Proceed?', detail: '# Plan\n\nChange the module.' }

describe('plan document flow entry', () => {
  it('mounts a guttered local content slot below the stream', () => {
    const { ctx, screen } = setup()
    const entry = mountPlanDocument(ctx, 'doc', () => planDocumentNode(question, key => key))
    const target = screen.slotTargets.get('local.doc')!
    expect(target).toBeDefined()
    expect(screen.followCount).toBe(1)
    const rows = target.render(80)
    expect(rows.join('\n')).toContain('Plan')
    expect(rows.join('\n')).toContain('Change the module.')
    /* The document sits in the stream's own gutter, so every row lines up with the rows above it. */
    expect(rows.every(row => row.startsWith(' '.repeat(STREAM_GUTTER)))).toBe(true)
    entry.dispose()
    expect(screen.children).toHaveLength(0)
  })

  it('uses the question header for the divider label when present', () => {
    const { ctx, screen } = setup()
    mountPlanDocument(ctx, 'doc', () => planDocumentNode({ ...question, header: 'Ship checklist' }, key => key))
    expect(screen.slotTargets.get('local.doc')!.render(80).join('\n')).toContain('Ship checklist')
  })

  it('renders every document row linearly instead of windowing to the viewport', () => {
    const { ctx, screen } = setup()
    const detail = Array.from({ length: 40 }, (_, index) => `Plan line ${index + 1}`).join('\n')
    mountPlanDocument(ctx, 'doc', () => planDocumentNode({ ...question, detail }, key => key))
    const rows = screen.slotTargets.get('local.doc')!.render(80)
    expect(rows.length).toBeGreaterThan(screen.rows)
    expect(rows.at(-2)).toContain('Plan line 40')
  })

  it('mounts the structured error component when the node fails admission', () => {
    const { ctx, screen } = setup()
    mountPlanDocument(ctx, 'doc', () => ({ kind: 'not-a-node' }) as unknown as MayflyUiNode)
    expect(screen.slotTargets.get('local.doc')!.render(80).join('\n')).not.toEqual('')
    expect(screen.followCount).toBe(1)
  })
})
