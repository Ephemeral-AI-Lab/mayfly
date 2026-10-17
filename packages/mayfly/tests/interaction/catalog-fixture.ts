/** Native tool registry, Agent scopes, and command fixtures for catalog UIs.
 * @module @ephemeral-ai/mayfly/tests/interaction/catalog-fixture
 */
import type { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { vi, type Mock } from 'vitest'
import { requestFixture } from './request-fixture.ts'

export async function catalogFixture(ctx: Context) {
  const bench = await requestFixture(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  ctx.provide('systemPrompt', { tools: () => () => {} } as never)
  const toolsOwner = await ctx.plugin(ToolRuntime)
  let agentScope!: ReturnType<typeof createScope>
  await ctx.plugin({ name: 'catalog-agents', inject: ['tools'], apply(owner: Context) {
    agentScope = createScope(owner, bench.agent)
    const otherScope = createScope(owner, bench.other)
    Object.assign(bench.agent, { ctx: agentScope.ctx, status: 'idle', session: ctx.sessions.create(SessionId('current')) })
    Object.assign(bench.other, { ctx: otherScope.ctx, status: 'idle', session: ctx.sessions.create(SessionId('other')) })
    owner.effect(() => () => Promise.all([agentScope.dispose(), otherScope.dispose()]))
  } })
  let sequence = 0
  const execute: Mock<() => Promise<null>> = vi.fn(async () => null)
  /** Register a tool; one that declares no parameters takes none. */
  const register = (schema: Omit<ToolSchema, 'parameters'> & Partial<Pick<ToolSchema, 'parameters'>>, agent?: Agent) => ctx.plugin({ name: `catalog-tool-${++sequence}`, inject: ['tools'], apply(owner: Context) {
    const scope = agent === undefined ? undefined : createScope(owner, agent)
    const registration = scope?.ctx ?? owner
    registration.tools.register({ ...schema, parameters: schema.parameters ?? { type: 'object', properties: {} }, output: { schema: { type: 'null' }, render: () => [] }, execute })
    if (scope !== undefined) owner.effect(() => () => scope.dispose())
  } })
  const run = (line: string) => ctx.commands.execute(bench.agent, line, [], new AbortController().signal)
  return { ...bench, toolsOwner, register, execute, run, restrict: (deny: readonly string[]) => agentScope.ctx.tools.restrict({ deny }) }
}
