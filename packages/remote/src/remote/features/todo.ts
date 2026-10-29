/**
 * Official Todo and conversation-fact projections behind the Remote Todo view.
 * @module @ephemeral-ai/mayfly/remote/features/todo
 */

import type { ConversationProjection } from '@ephemeral-ai/mayfly-host/types'
import { memoizedLocaleTranslator, type MayflyTranslate } from '@ephemeral-ai/mayfly/frontend'
import type { MayflyPaneRegistration } from '@ephemeral-ai/mayfly-ui'
import type { RemoteFeatureContext } from '../features.ts'
import { remoteTodoPanel, remoteTodoSummary, type RemoteTodoItem } from '../panels/todo.ts'
import { RemoteFeatureLifecycle } from './lifecycle.ts'

const DONE_LINGER_MS = 5_000

class RemoteTodoController {
  private readonly t: MayflyTranslate
  private readonly lifecycle: RemoteFeatureLifecycle
  private readonly pane: MayflyPaneRegistration
  private todos: readonly RemoteTodoItem[] = []
  private interrupted = false
  private tracking = false
  private done: { readonly total: number } | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private subscriptions: readonly (() => void)[] = []
  private disposed = false

  constructor(options: RemoteFeatureContext) {
    this.t = memoizedLocaleTranslator(options.ctx, 'remote-todo').translate
    this.lifecycle = new RemoteFeatureLifecycle(options, this.attach)
    this.pane = options.ctx.mayflyPanes.register({ id: 'mayfly.view.todo', title: 'Todo', placement: 'views', priority: 14 }, null)
    options.ctx.effect(() => options.ctx.mayflyLocale.register('remote-todo', {
      en: Object.freeze({ todo: 'todo', interrupted: 'interrupted' }),
      zh: Object.freeze({ todo: '待办', interrupted: '已中断' }),
    }))
    this.lifecycle.start()
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.lifecycle.dispose()
    for (const dispose of this.subscriptions) dispose()
    this.subscriptions = []
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.pane.dispose()
  }

  private readonly attach = (generation: number): void => {
    if (this.disposed) return
    for (const dispose of this.subscriptions) dispose()
    this.subscriptions = []
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.done = undefined
    this.tracking = false
    this.todos = []
    this.interrupted = false
    const current = this.lifecycle.selection(generation)
    if (current !== undefined) {
      const todos = current.binding.session.projections.faceOf('todos')
      const conversation = current.binding.session.projections.faceOf('mayflyConversation')
      const update = (): void => {
        if (!this.lifecycle.owns(generation)) return
        const next = todos.getSnapshot() as readonly RemoteTodoItem[] | null | undefined
        const projected = conversation.getSnapshot() as ConversationProjection | undefined
        const latestTurn = projected?.turns.at(-1)
        this.interrupted = latestTurn?.endedAt !== undefined && latestTurn.outcome === 'error'
        this.update(Array.isArray(next) ? next : [])
      }
      this.subscriptions = [todos.subscribe(update), conversation.subscribe(update)]
      update()
    }
    this.publish()
  }

  private update(next: readonly RemoteTodoItem[]): void {
    const settled = next.length > 0 && next.every(todo => todo.status === 'completed')
    if (settled) {
      if (this.tracking) {
        this.done = { total: next.length }
        if (this.timer !== undefined) clearTimeout(this.timer)
        this.timer = setTimeout(() => {
          this.done = undefined
          if (!this.disposed) this.publish()
        }, DONE_LINGER_MS)
        this.timer.unref()
      }
      this.todos = []
      this.tracking = false
    } else {
      this.todos = next
      this.tracking = next.length > 0
      if (next.length > 0) {
        this.done = undefined
        if (this.timer !== undefined) clearTimeout(this.timer)
        this.timer = undefined
      }
    }
    this.publish()
  }

  private publish(): void {
    const state = { todos: this.todos, interrupted: this.interrupted, ...this.done === undefined ? {} : { done: this.done } }
    this.pane.set(remoteTodoPanel(state, this.t))
    this.pane.setSummary(remoteTodoSummary(state, this.t))
  }
}

/** Mount the official Todo projection and its closing-summary lifecycle. */
export function mountTodoFeature(options: RemoteFeatureContext): () => void {
  const controller = new RemoteTodoController(options)
  return controller.dispose
}
