/** Native request services and real shared UI/compiler fixtures.
 * @module @ephemeral-ai/mayfly/tests/interaction/request-fixture
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { vi } from 'vitest'
import * as uiProvider from '../../../ui/src/provider.ts'
import * as frontend from '../../src/frontend/index.ts'
import { MayflyCurrentAgentService } from '../../src/app/current-agent.ts'
import { MayflyUiSurfaceRuntime, compileMayflyUiSurfaceNode } from '../../src/core/ui-compiler.ts'
import type { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import type { MayflyComponents, MayflySemanticColors } from '../../src/core/types.ts'
import { visibleWidth, truncateToWidth, wrapTextWithAnsi } from '../../src/core/width.ts'
import { createFakeEditor } from '../core/fake-editor.ts'
import { FakeMayflyMarkdown } from './fakes.ts'

const identity = (text: string) => text
const colors = new Proxy({}, { get: (_, key) => key === 'logoGradient' ? [identity] : identity }) as MayflySemanticColors
const components = { createEditor: createFakeEditor, createMarkdown: options => new FakeMayflyMarkdown(options), visibleWidth, truncateToWidth, wrapText: wrapTextWithAnsi } as MayflyComponents
export const flushRequests = () => new Promise<void>(resolve => { setImmediate(resolve) })

export async function requestFixture(ctx = new Context()) {
  const steer = vi.fn()
  const agent = { id: 'current', steer } as unknown as Agent
  const other = { id: 'other', steer: vi.fn() } as unknown as Agent
  const agents = new Map([[agent.id, agent], [other.id, other]])
  ctx.provide('agents', { get: (id: Agent['id']) => agents.get(id), roots: () => [...agents.values()] } as never)
  const app = await ctx.plugin({ name: 'test-current-agent', inject: ['agents'], apply(owner: Context) { new MayflyCurrentAgentService(owner) } })
  ctx.mayflyCurrentAgent.select(agent)
  await ctx.plugin(uiProvider)
  await ctx.plugin(UserQuestionService)
  const front = await ctx.plugin(frontend)
  await flushRequests()
  const model = (prefix = 'mayfly.questions.') => {
    const entry = ctx.mayflyOverlays.list().findLast(entry => entry.id.startsWith(prefix))
    if (entry === undefined) throw new Error('No request overlay')
    const model = ctx.mayflyUiInteraction.get('overlay', entry.id)!
    if (model.node === null) throw new Error(JSON.stringify(model.feedbackSnapshot()))
    return model
  }
  const approve = (extra: Partial<ApprovalRequest> = {}) => ctx.waterfall('approval/request', { agent, toolName: 'bash', ...extra }, () => Promise.resolve<ApprovalOutcome>('unavailable'))
  return { ctx, agent, other, agents, steer, app, front, model, approve }
}

export function renderRequest(
  model: UiSurfaceModel,
  viewport = { columns: 80, rows: 24 },
  runtime = new MayflyUiSurfaceRuntime(model),
) {
  const result = compileMayflyUiSurfaceNode(model.decisionNode ?? model.node, {
    surfaceRuntime: runtime, components, colors, screenMode: 'alternate', getViewport: () => viewport,
    emit: event => model.emit(event), onUnhandledEscape: () => model.requestClose(),
  })
  if (!result.ok) throw new Error(result.message)
  if (result.value.focusTarget !== null) result.value.focusTarget.focused = true
  return { runtime, ...result.value, input: (data: string) => { result.value.focusTarget?.handleInput?.(data) } }
}
