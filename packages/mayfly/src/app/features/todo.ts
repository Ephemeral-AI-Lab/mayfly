/** Native whole Todo and conversation-fact projections behind the reference status view. @module */
import type { ConversationFacts } from '@ephemeral-ai/mayfly-host/types'
import { todoPanel, todoSummary, TODO_DONE_LINGER_MS, type TodoPresentationItem } from '../../transcript/todo-model.ts'
import { mountTranscriptLocale, transcriptTranslator, observeTranscriptLocale, TRANSCRIPT_LOCALE } from '../../transcript/locale.ts'
import type { MayflyPaneRegistration, MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import type { RemoteFeatureContext } from '../features.ts'
import { RemoteFeatureLifecycle } from './lifecycle.ts'
import { RemoteFeatureOperation } from './official.ts'

class RemoteTodoController {
  private readonly t: MayflyTranslate
  private readonly lifecycle: RemoteFeatureLifecycle
  private readonly pane: MayflyPaneRegistration
  private readonly offSettings: () => void
  private readonly offDocument: () => void
  private readonly offLocale: () => void
  private owner: RemoteFeatureOperation | undefined
  private todos: readonly TodoPresentationItem[] = []
  private interrupted = false
  private tracking = false
  private done: { readonly total: number } | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(private readonly options: RemoteFeatureContext) {
    mountTranscriptLocale(options.ctx, 'remote-todo', TRANSCRIPT_LOCALE)
    this.t = transcriptTranslator(options.ctx, 'remote-todo')
    this.lifecycle = new RemoteFeatureLifecycle(options, this.attach)
    this.pane = options.ctx.mayflyPanes.register({ id: 'mayfly.view.todo', title: this.t('Todo'), placement: 'views', priority: 15 }, null)
    this.offSettings = options.ctx.on('mayfly/settings-source-ready', this.publish)
    this.offDocument = options.ctx.on('settings/document-updated', ns => { if (String(ns) === 'mayfly') this.publish() })
    this.offLocale = observeTranscriptLocale(options.ctx, this.publish)
    this.lifecycle.start()
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.lifecycle.dispose()
    this.owner?.dispose()
    this.offSettings()
    this.offDocument()
    this.offLocale()
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.pane.dispose()
  }

  private readonly attach = (generation: number): void => {
    this.owner?.dispose()
    this.owner = undefined
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.done = undefined
    this.tracking = false
    this.todos = []
    this.interrupted = false
    const current = this.lifecycle.selection(generation)
    if (current !== undefined) {
      const owner = new RemoteFeatureOperation(this.options, current.client, current)
      this.owner = owner
      const todos = current.binding.session.projections.faceOf('todos')
      const facts = current.binding.session.projections.faceOf('mayflyConversationFacts')
      const update = (): void => {
        if (!owner.valid()) return
        const next = todos.getSnapshot()
        const projected = facts.getSnapshot() as ConversationFacts | undefined
        this.interrupted = projected?.active === false && projected.runOutcome === 'failed'
        this.update(Array.isArray(next) ? next : [], owner)
      }
      owner.onDispose(todos.subscribe(update))
      owner.onDispose(facts.subscribe(update))
      update()
    }
    this.publish()
  }

  private update(next: readonly TodoPresentationItem[], owner: RemoteFeatureOperation): void {
    const settled = next.length > 0 && next.every(todo => todo.status === 'completed')
    if (settled) {
      if (this.tracking) {
        this.done = { total: next.length }
        this.timer = setTimeout(() => {
          if (!owner.valid()) return
          this.done = undefined
          this.timer = undefined
          this.publish()
        }, TODO_DONE_LINGER_MS)
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

  private readonly publish = (): void => {
    if (this.disposed) return
    const state = { todos: this.todos, interrupted: this.interrupted, history: this.options.ctx.get('mayflyInteractionState')?.settingsSource().viewHistory === true, ...this.done === undefined ? {} : { done: this.done } }
    this.pane.set(todoPanel(state, this.t))
    this.pane.setSummary(todoSummary(state, this.t))
  }
}

/** Mount exact native Todo/facts and the reference history/completion presentation. */
export function mountTodoFeature(options: RemoteFeatureContext): () => void {
  const controller = new RemoteTodoController(options)
  return controller.dispose
}
