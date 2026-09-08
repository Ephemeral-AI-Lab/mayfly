/** Native session projections and command fixtures for readonly information surfaces.
 * @module @ephemeral-ai/mayfly/tests/interaction/information-fixture
 */
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import * as sessionStats from '@deepseek-ai/dsh-session-stats'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as frontend from '../../src/frontend/index.ts'
import { requestFixture } from './request-fixture.ts'

export async function informationFixture(ctx: Context, displayVersion?: string) {
  const bench = await requestFixture(ctx)
  let front = bench.front
  if (displayVersion !== undefined) { await front.dispose(); front = await ctx.plugin(frontend, { displayVersion }) }
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId('current'), { meta: { cwd: '/repo/current', createdAt: 0 } })
  const otherSession = ctx.sessions.create(SessionId('other'), { meta: { cwd: '/repo/other' } })
  Object.assign(bench.agent, { session, status: 'idle', ctx: new Context() })
  Object.assign(bench.other, { session: otherSession, status: 'idle' })
  await ctx.plugin(CommandRuntime)
  const projections = await ctx.plugin(SessionProjectionRegistry)
  const stats = await ctx.plugin(sessionStats)
  const meter = await ctx.plugin(TokenMeter)
  const run = (line: string) => ctx.commands.execute(bench.agent, line, [], new AbortController().signal)
  return { ...bench, front, session, otherSession, projections, stats, meter, run }
}
