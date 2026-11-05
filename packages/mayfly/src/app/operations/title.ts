/**
 * Terminal title projection for the current Session, deduplicated and restored
 * on selection change and unload.
 * @module @ephemeral-ai/mayfly/remote/operations/title
 */

import { sanitizeTitleText, TITLE_MAX_CHARS } from '../../core/terminal-escape.ts'
import type { RemoteFeatureSelection } from '../features.ts'
import { RemoteFeatureLifecycle } from '../features/lifecycle.ts'
import { isRemoteRecord, registerRemoteOperationsLocale, remoteReadString, type RemoteOperationsContext } from './support.ts'

const FALLBACK_TITLE = 'mayfly'

const zh: Readonly<Record<string, string>> = {}

/** Sanitize and cap one candidate title, returning the fallback for an empty result. */
function normalizeTitle(text: string | undefined): string {
  const sanitized = text === undefined ? '' : [...sanitizeTitleText(text)].slice(0, TITLE_MAX_CHARS).join('')
  return sanitized === '' ? FALLBACK_TITLE : sanitized
}

class RemoteTitleController {
  private readonly lifecycle: RemoteFeatureLifecycle
  private subscriptions: readonly (() => void)[] = []
  private last: string | undefined
  private disposed = false

  constructor(private readonly context: RemoteOperationsContext) {
    const { base } = context
    registerRemoteOperationsLocale(base, 'remote-operations-title', zh)
    this.lifecycle = new RemoteFeatureLifecycle(base, this.attach)
    this.lifecycle.start()
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.lifecycle.dispose()
    for (const dispose of this.subscriptions) dispose()
    this.subscriptions = []
    this.context.base.screen.setTitle(FALLBACK_TITLE)
    this.last = undefined
  }

  private readonly attach = (generation: number): void => {
    for (const dispose of this.subscriptions) dispose()
    this.subscriptions = []
    const current = this.lifecycle.selection(generation)
    if (current !== undefined) {
      const title = current.binding.session.projections.faceOf('title')
      const catalog = current.client.sessions.list
      const update = (): void => { if (this.lifecycle.owns(generation)) this.publish(current) }
      this.subscriptions = [title.subscribe(update), catalog.subscribe(update)]
    }
    this.publish(current)
  }

  private publish(current: RemoteFeatureSelection | undefined): void {
    const projected = current === undefined ? undefined : current.binding.session.projections.faceOf('title').getSnapshot()
    const projectedTitle = typeof projected === 'string'
      ? projected
      : isRemoteRecord(projected) ? remoteReadString(projected, 'value') : undefined
    const summary = current === undefined ? undefined : current.client.sessions.list.getSnapshot().byId[current.ref.sessionId]
    const title = normalizeTitle(projectedTitle ?? summary?.displayTitle)
    if (title === this.last) return
    this.last = title
    this.context.base.screen.setTitle(title)
  }
}

/** Mount the deduplicated terminal title for the exact current Session. */
export function mountRemoteTitleOperations(context: RemoteOperationsContext): () => void {
  const controller = new RemoteTitleController(context)
  return () => controller.dispose()
}
