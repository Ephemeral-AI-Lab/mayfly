/**
 * Host-owned Workflow baseline/replacement stream behind the Remote Workflow pane.
 * @module @ephemeral-ai/mayfly/remote/features/workflow
 */

import { ui, type MayflyPaneRegistration, type MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import type { MayflyWorkflowFrame } from '../../frontend/host-contract.ts'
import { mayflyHostRemote } from '../../frontend/host-mount.ts'
import { RemoteWorkflowSource } from '../../frontend/workflow.ts'
import type { RemoteFeatureContext } from '../features.ts'
import { remoteWorkflowNode } from '../panels/workflow.ts'
import { hasMayflyHostFeature, unavailableCapability } from './capabilities.ts'
import { RemoteFeatureLifecycle } from './lifecycle.ts'

type WorkflowBaseline = Extract<MayflyWorkflowFrame, { readonly type: 'baseline' }>
type WorkflowReplacement = Extract<MayflyWorkflowFrame, { readonly type: 'replacement' }>

class RemoteWorkflowController {
  private readonly options: RemoteFeatureContext
  private readonly t: MayflyTranslate
  private readonly lifecycle: RemoteFeatureLifecycle
  private readonly source = new RemoteWorkflowSource<WorkflowBaseline, WorkflowReplacement>()
  private readonly offSource: () => void
  private readonly pane: MayflyPaneRegistration
  private capabilityError: string | undefined
  private operationLifetime = new AbortController()
  private readonly timer: ReturnType<typeof setInterval>
  private disposed = false

  constructor(options: RemoteFeatureContext) {
    this.options = options
    this.t = memoizedLocaleTranslator(options.ctx, 'remote-workflow').translate
    this.lifecycle = new RemoteFeatureLifecycle(options, this.attach)
    this.offSource = this.source.subscribe(this.publish)
    this.pane = options.ctx.mayflyPanes.register({
      id: 'mayfly.pane.workflow',
      placement: 'bottom',
      priority: 60,
      narrow: 'bottom',
      onEvent: { action: event => {
        if (event.kind === 'activate' && event.actionId === 'workflow-refresh') void this.attach(this.lifecycle.currentGeneration())
        return { kind: 'completed' }
      } },
    }, null)
    this.lifecycle.start()
    this.timer = setInterval(this.publish, 1_000)
    this.timer.unref()
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.lifecycle.dispose()
    this.operationLifetime.abort()
    this.offSource()
    clearInterval(this.timer)
    this.pane.dispose()
    void this.source.dispose().catch((error: unknown) => {
      this.options.notice.set(error instanceof Error ? error.message : String(error))
    })
  }

  private readonly attach = (generation: number): void => {
    if (this.disposed) return
    this.operationLifetime.abort()
    this.operationLifetime = new AbortController()
    this.capabilityError = undefined
    void this.source.attach(null, undefined, undefined)
    const current = this.lifecycle.selection(generation)
    if (current === undefined) {
      this.publish()
      return
    }
    const signal = this.operationLifetime.signal
    void (async () => {
      try {
        // The capability read checks this operation's signal after its await;
        // refresh, selection changes, and unload all abort that exact signal.
        const capable = await hasMayflyHostFeature(current.client, 'followWorkflow', signal)
        if (!capable) {
          this.capabilityError = unavailableCapability('followWorkflow')
          this.publish()
          return
        }
        await this.source.attach(current.client, current.ref, {
          name: 'Remote Workflow replacements',
          open: streamSignal => mayflyHostRemote(current.client).followWorkflow({ sessionId: current.ref.sessionId }, streamSignal),
          isBaseline: (frame): frame is WorkflowBaseline => frame.type === 'baseline',
        })
      } catch (error) {
        if (!signal.aborted) {
          this.capabilityError = error instanceof Error ? error.message : String(error)
          this.publish()
        }
      }
    })()
    this.publish()
  }

  private readonly publish = (): void => {
    if (this.disposed) return
    const snapshot = this.source.snapshot()
    const node = remoteWorkflowNode(snapshot.frame?.value, Date.now(), this.t)
    const error = this.capabilityError ?? (snapshot.error === undefined ? undefined : snapshot.error instanceof Error ? snapshot.error.message : String(snapshot.error))
    this.pane.set(node === null && error === undefined ? null : ui.stack.column([
      ...node === null ? [] : [{ node }],
      ...error === undefined ? [] : [{ node: ui.text(error, { tone: 'danger', overflow: 'wrap' }) }],
      ...error === undefined ? [] : [{ node: ui.actions({ id: 'workflow-actions', items: [{ id: 'workflow-refresh', label: this.t('Refresh'), hintLabel: this.t('refresh'), semantic: 'refresh', hidden: true }] }) }],
    ]))
  }
}

/** Mount Host Workflow replacement consumption without a Remote workflow engine. */
export function mountWorkflowFeature(options: RemoteFeatureContext): () => void {
  const controller = new RemoteWorkflowController(options)
  return controller.dispose
}
