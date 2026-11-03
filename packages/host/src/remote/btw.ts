/** Native complete-tail BTW forks with exact source and caller lifetime checks. @module */
import { symbols, type Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { MayflyBtwForkRequest, MayflyBtwForkValue } from '../types.ts'
import { requireExactAgent, resolveExactAgent, sessionDirectory } from './session.ts'

const identity = (service: object | undefined): object | undefined => service === undefined ? undefined : Reflect.get(service, symbols.original) as object | undefined ?? service

/** Ask the native controller to balance the exact observed tail; never manufacture a Session or Agent. */
export async function btwFork(ctx: Context, request: MayflyBtwForkRequest, signal: AbortSignal): Promise<MayflyBtwForkValue> {
  const agent = await resolveExactAgent(ctx, request.sessionId, signal)
  const source = ctx.sessionQuery
  const controller = ctx.sessionController
  const assertCurrent = (): void => {
    signal.throwIfAborted()
    requireExactAgent(ctx, request.sessionId, agent)
    if (identity(source) !== identity(ctx.get('sessionQuery')) || identity(controller) !== identity(ctx.get('sessionController'))) {
      throw new RemoteError('mayflyHost/session-stale', 'BTW source changed before the fork completed', { sessionId: request.sessionId })
    }
  }
  assertCurrent()
  using observation = await source.observeSession(request.sessionId, { signal, projectionMode: 'none' })
  assertCurrent()
  const atSeq = request.atSeq ?? observation.cursor
  const empty = request.atSeq === undefined && atSeq === -1
  // SessionController.fork requires an existing event. A genuinely empty source
  // has no inherited context, so its equivalent native operation is create.
  const preset = observation.header.agentPreset
  const child = empty
    ? await controller.create({ cwd: sessionDirectory(ctx, agent.session), ...preset === undefined ? {} : { agentPreset: preset } })
    : await controller.fork({ sessionId: request.sessionId, atSeq, ...request.allowMigration === undefined ? {} : { allowMigration: request.allowMigration } })
  assertCurrent()
  return Object.freeze({ sessionId: child.sessionId, ...empty ? {} : { historyFloorSeq: atSeq } })
}
