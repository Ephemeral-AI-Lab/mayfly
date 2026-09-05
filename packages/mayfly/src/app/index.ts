/**
 * Mayfly application startup and current-Agent selection. Harness domain
 * behavior stays on the ordinary dsh Cordis services.
 *
 * @module @ephemeral-ai/mayfly/app
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import type { MayflyRequestLifecycle } from './request-lifecycle.ts'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import { MayflyCurrentAgentService } from './current-agent.ts'
import { interruptAgentTree } from './agent-interrupt.ts'
import { armExitEpitaph, epitaphFor } from './exit-epitaph.ts'
import { profileNameFromArgv } from '../internal/profile.ts'
import { createMayflyRequestController } from './request-lifecycle.ts'
import { installRetractionService } from './retraction.ts'
import { installSessionTitleCadence } from './title-cadence.ts'

export {
  MayflyCurrentAgentService,
  type MayflyAgentViewSnapshot,
  type MayflyAuxiliaryView,
} from './current-agent.ts'
export { createMayflyRequestController, type MayflyRequestController } from './request-lifecycle.ts'
export type { MayflyRetractionService, MayflyTurnRetraction } from './retraction.ts'
export type { MayflyRequestLifecycle, MayflyRequestRef, MayflyRequestState } from './request-lifecycle.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'mayfly/request-state-changed'(lifecycle: MayflyRequestLifecycle): void
    'mayfly/session-epoch-changed'(sessionEpoch: number): void
    'mayfly/request-resume'(sessionId: string): void
    'mayfly/request-new'(): void
    'mayfly/request-fork'(): void
    'mayfly/request-rewind'(sessionId: string, atSeq: number): void
  }
}

/** Stable Cordis plugin name. */
export const name = 'mayfly-app'

/** Direct dsh services required by the startup coordinator. */
export const inject = ['mayflyStartup', 'agents', 'sessionController', 'subagents', 'mayflyScreen']

/** Launch values resolved by the startup provider. */
export interface Config {
  readonly task?: string
  readonly resume?: string
}

export const Config: z<Config> = z.object({
  task: z.string(),
  resume: z.string(),
})

interface MayflyIo {
  stderr: { write(chunk: string): unknown }
  exit(code: number): void
}

/** Process-facing diagnostic stream; tests may replace it. */
export const internals: { stderr: MayflyIo['stderr'] } = { stderr: process.stderr }

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function resolvedAgent(result: Awaited<ReturnType<SessionController['resolveAgent']>>): Agent {
  if ('error' in result) throw result.error
  return result.agent
}

/** Mount startup, navigation, request lifecycle, and current-Agent selection. */
export function apply(ctx: Context, config: Config): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('mayfly-app: the launcher must provide ctx.appExit before the tree mounts')
  const io: MayflyIo = { stderr: internals.stderr, exit }
  const current = new MayflyCurrentAgentService(ctx)
  const requests = createMayflyRequestController(ctx)
  const controller = ctx.sessionController
  let selectedRevision = current.revision()
  const offSelection = current.subscribe((_agent, revision) => {
    if (revision === selectedRevision) return
    selectedRevision = revision
    requests.commitSession()
  })
  ctx.effect(() => offSelection)

  const offTitleCadence = installSessionTitleCadence(ctx, () => current.current()?.session)
  ctx.effect(() => offTitleCadence)
  installRetractionService(
    ctx,
    () => current.current(),
    requests,
    message => { io.stderr.write(`dsh: ${message}\n`) },
    (agent) => {
      const result = interruptAgentTree(ctx, agent, current.view(), { keepInbox: true })
      for (const failure of result.failures) io.stderr.write(`dsh: could not interrupt ${failure}\n`)
    },
  )

  ctx.on('session/event', (session, event) => {
    if (session !== current.current()?.session || event.type !== 'turn/end') return
    const ref = requests.active()
    if (ref === undefined) return
    const reason = event.data.reason.kind
    requests.transition(
      ref,
      reason === 'aborted' || reason === 'interrupted'
        ? 'interrupted'
        : reason === 'error'
          ? 'failed'
          : 'completed',
      reason,
    )
  })

  ctx.effect(() => () => {
    const agent = current.current()
    armExitEpitaph(agent !== null && agent.session.seq > 0
      ? epitaphFor(String(agent.id), profileNameFromArgv(process.argv))
      : undefined)
  })

  let chain = Promise.resolve()
  const enqueue = (operation: () => Promise<void>): void => {
    chain = chain.then(operation).catch((error: unknown) => {
      io.stderr.write(`dsh: ${describe(error)}\n`)
    })
  }

  const select = (agent: Agent): void => {
    current.select(agent)
  }

  const resolve = async (sessionId: string): Promise<Agent> => {
    return resolvedAgent(await controller.resolveAgent(SessionId(sessionId)))
  }

  const create = async (): Promise<Agent> => {
    const created = await controller.create({ cwd: process.cwd() })
    return resolve(String(created.sessionId))
  }

  enqueue(async () => {
    await ctx.get('loader')?.await()
    try {
      const agent = config.resume === undefined ? await create() : await resolve(config.resume)
      select(agent)
      /* v8 ignore else -- the no-task startup path is covered explicitly; V8 retains a synthetic empty else arm. */
      if (config.task !== undefined) {
        requests.begin('main')
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: config.task }],
          source: { kind: 'user' },
        }))
      }
    } catch (error) {
      io.stderr.write(`dsh: ${describe(error)}\n`)
      io.exit(1)
    }
  })

  ctx.on('mayfly/request-resume', (sessionId) => {
    enqueue(async () => {
      current.closeAuxiliary()
      try { select(await resolve(sessionId)) }
      catch (error) { io.stderr.write(`dsh: could not resume session ${sessionId}: ${describe(error)}\n`) }
    })
  })

  ctx.on('mayfly/request-new', () => {
    enqueue(async () => {
      current.closeAuxiliary()
      try { select(await create()) }
      catch (error) { io.stderr.write(`dsh: could not start a new session: ${describe(error)}\n`) }
    })
  })

  ctx.on('mayfly/request-fork', () => {
    enqueue(async () => {
      const agent = current.primary()
      current.closeAuxiliary()
      if (agent === null) {
        io.stderr.write('dsh: no live session to fork\n')
        return
      }
      try {
        const forked = await controller.fork({ sessionId: agent.id })
        select(await resolve(String(forked.sessionId)))
      } catch (error) {
        io.stderr.write(`dsh: could not fork session ${String(agent.id)}: ${describe(error)}\n`)
      }
    })
  })

  ctx.on('mayfly/request-rewind', (sessionId, atSeq) => {
    enqueue(async () => {
      const agent = current.primary()
      current.closeAuxiliary()
      if (agent === null || String(agent.id) !== sessionId) {
        io.stderr.write(`dsh: rewind request is stale for session ${sessionId}\n`)
        return
      }
      try {
        const forked = await controller.fork({ sessionId: agent.id, atSeq })
        select(await resolve(String(forked.sessionId)))
      } catch (error) {
        io.stderr.write(`dsh: could not rewind session ${sessionId}: ${describe(error)}\n`)
      }
    })
  })
}
