/**
 * App-owned request lifecycle controller shared by Mayfly interaction and
 * presentation effects.
 *
 * @module @ephemeral-ai/mayfly/app/request-lifecycle
 */

import type { Context } from '@deepseek-ai/cordis'

export type MayflyRequestState = 'started' | 'streaming' | 'completed' | 'failed' | 'aborted' | 'interrupted'
export interface MayflyRequestRef {
  readonly sessionEpoch: number
  readonly requestEpoch: number
  readonly scope: 'main' | 'btw' | 'subagent'
}
export interface MayflyRequestLifecycle {
  readonly ref: MayflyRequestRef
  readonly state: MayflyRequestState
  readonly reason?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mayflyRequests: MayflyRequestController
  }
}

/** Narrow controller that never exposes Agent or Session objects. */
export interface MayflyRequestController {
  readonly sessionEpoch: number
  active(): MayflyRequestRef | undefined
  begin(scope?: MayflyRequestRef['scope']): MayflyRequestRef
  transition(ref: MayflyRequestRef, state: MayflyRequestState, reason?: string): void
  interrupt(ref?: MayflyRequestRef): void
  commitSession(): number
}

/** Create and provide a Fiber-owned lifecycle controller. */
export function createMayflyRequestController(ctx: Context): MayflyRequestController {
  let sessionEpoch = 0
  let requestEpoch = 0
  let active: MayflyRequestRef | undefined
  let disposed = false
  const terminal = new Set<MayflyRequestState>(['completed', 'failed', 'aborted', 'interrupted'])
  const allowed = new Map<MayflyRequestState, ReadonlySet<MayflyRequestState>>([
    ['started', new Set(['streaming', 'completed', 'failed', 'aborted', 'interrupted'])],
    ['streaming', new Set(['completed', 'failed', 'aborted', 'interrupted'])],
    ['completed', new Set()],
    ['failed', new Set()],
    ['aborted', new Set()],
    ['interrupted', new Set()],
  ])
  let state: MayflyRequestState | undefined
  const emit = (lifecycle: MayflyRequestLifecycle): void => {
    if (!disposed) ctx.emit('mayfly/request-state-changed', lifecycle)
  }
  const controller: MayflyRequestController = {
    get sessionEpoch() {
      return sessionEpoch
    },
    active() {
      return active
    },
    begin(scope = 'main') {
      const ref: MayflyRequestRef = { sessionEpoch, requestEpoch: ++requestEpoch, scope }
      active = ref
      state = 'started'
      emit({ ref, state: 'started' })
      return ref
    },
    transition(ref, nextState, reason) {
      if (ref.sessionEpoch !== sessionEpoch || active?.requestEpoch !== ref.requestEpoch || state === undefined) return
      if (!allowed.get(state)!.has(nextState)) return
      state = nextState
      emit({ ref, state: nextState, ...(reason === undefined ? {} : { reason }) })
      if (terminal.has(nextState)) active = undefined
    },
    interrupt(ref = active) {
      if (ref !== undefined) controller.transition(ref, 'interrupted', 'user')
    },
    commitSession() {
      sessionEpoch += 1
      active = undefined
      state = undefined
      ctx.emit('mayfly/session-epoch-changed', sessionEpoch)
      return sessionEpoch
    },
  }
  ctx.provide('mayflyRequests', controller)
  ctx.effect(() => () => {
    disposed = true
    active = undefined
  })
  return controller
}
