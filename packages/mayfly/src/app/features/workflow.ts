/**
 * The Workflow view: the Host's baseline and replacement stream behind a status item and a panel. A background run is a job,
 * so the job roster is followed only while the view is open with a run still working, to tell whether `x` can stop it.
 * @module @ephemeral-ai/mayfly/app/features/workflow
 */

import { ui, type MayflyPaneRegistration, type MayflyTranslate, type MayflyUiActionEvent, type MayflyUiActionReply, type MayflyUiEventContext } from '@ephemeral-ai/mayfly-ui'
import { memoizedLocaleTranslator } from '../../frontend/locale.ts'
import type { MayflyWorkflowFrame, MayflyWorkflowRun } from '../../hosts/host-contract.ts'
import { mayflyHostRemote } from '../../hosts/host-mount.ts'
import { RemoteJobSource } from '../../hosts/jobs.ts'
import { RemoteWorkflowSource } from '../../hosts/workflow.ts'
import type { SessionRef } from '../../client/types.ts'
import type { RemoteFeatureContext } from '../features.ts'
import { isRemoteJobLive } from '../panels/jobs.ts'
import { isWorkflowRunLive, shownWorkflowRuns, workflowPanel, workflowSummary, WORKFLOW_VIEW_LIST_ID, WORKFLOW_VIEW_STOP_ID } from '../panels/workflow.ts'
import { hasMayflyHostFeature, unavailableCapability } from './capabilities.ts'
import { RemoteFeatureLifecycle } from './lifecycle.ts'
import { remoteErrorMessage, remoteValue, type JobView } from './official.ts'

type WorkflowBaseline = Extract<MayflyWorkflowFrame, { readonly type: 'baseline' }>
type WorkflowReplacement = Extract<MayflyWorkflowFrame, { readonly type: 'replacement' }>

const VIEW_ID = 'mayfly.view.workflow'

/** The call the view shares with `/agents`: open one child's conversation. */
export interface WorkflowViewSeam {
  open(id: string, signal: AbortSignal): Promise<MayflyUiActionReply>
}

class RemoteWorkflowController {
  private readonly options: RemoteFeatureContext
  private readonly t: MayflyTranslate
  private readonly lifecycle: RemoteFeatureLifecycle
  private readonly source = new RemoteWorkflowSource<WorkflowBaseline, WorkflowReplacement>()
  private readonly jobs = new RemoteJobSource()
  private readonly offSource: () => void
  private readonly offJobs: () => void
  private readonly offViews: () => void
  private readonly pane: MayflyPaneRegistration
  private capabilityError: string | undefined
  private operationLifetime = new AbortController()
  private readonly timer: ReturnType<typeof setInterval>
  private jobsRef: SessionRef | undefined
  private disposed = false

  constructor(options: RemoteFeatureContext, private readonly seam: WorkflowViewSeam) {
    this.options = options
    this.t = memoizedLocaleTranslator(options.ctx, 'remote-workflow').translate
    this.lifecycle = new RemoteFeatureLifecycle(options, this.attach)
    this.offSource = this.source.subscribe(this.publish)
    this.offJobs = this.jobs.subscribe(this.publish)
    // Publishing changes the lane, which notifies here, so entering only moves the job roster.
    this.offViews = options.screen.views.subscribe(() => { this.syncJobs(this.runs()) })
    this.pane = options.ctx.mayflyPanes.register({ id: VIEW_ID, placement: 'views', priority: 13, onEvent: { action: this.act } }, null)
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
    this.offJobs()
    this.offViews()
    clearInterval(this.timer)
    this.pane.dispose()
    const report = (error: unknown): void => { this.options.notice.set(remoteErrorMessage(error)) }
    void this.source.dispose().catch(report)
    void this.jobs.dispose().catch(report)
  }

  private readonly attach = (generation: number): void => {
    this.operationLifetime.abort()
    this.operationLifetime = new AbortController()
    this.capabilityError = undefined
    void this.source.attach(null, undefined, undefined)
    this.jobsRef = undefined
    void this.jobs.attach(null)
    const current = this.lifecycle.selection(generation)
    // Passive child history has no live Agent for automatic Workflow reads.
    if (current === undefined || (current.access !== undefined && current.access !== 'interactive')) {
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

  private runs(): readonly MayflyWorkflowRun[] {
    return shownWorkflowRuns(this.source.snapshot().frame?.value, Date.now())
  }

  /** Follow the job roster only while the open view can stop something with it. */
  private syncJobs(runs: readonly MayflyWorkflowRun[]): void {
    const views = this.options.screen.views
    const wanted = views.isEntered && views.active === VIEW_ID && runs.some(isWorkflowRunLive) ? this.options.hosts.current() : undefined
    if (wanted?.ref === this.jobsRef) return
    this.jobsRef = wanted?.ref
    void this.jobs.attach(wanted?.client ?? null, wanted?.ref).catch((error: unknown) => { if (!this.disposed) this.options.notice.set(remoteErrorMessage(error), 'error') })
  }

  /** A background run's job: the one live workflow job with its name. Two with one name stay ambiguous, and neither is stopped. */
  private jobOf(run: MayflyWorkflowRun): JobView | undefined {
    const matching = this.jobs.snapshot().jobs.filter(job => job.kind === 'workflow' && isRemoteJobLive(job) && job.label === run.name)
    return matching.length === 1 ? matching[0] : undefined
  }

  private readonly blocked = (run: MayflyWorkflowRun): string | undefined => {
    if (!isWorkflowRunLive(run)) return this.t('The workflow has ended')
    return this.jobOf(run) === undefined ? this.t('A foreground workflow stops with Esc') : undefined
  }

  private readonly publish = (): void => {
    if (this.disposed) return
    const runs = this.runs()
    this.syncJobs(runs)
    const snapshot = this.source.snapshot()
    const node = workflowPanel(runs, this.blocked, Date.now(), this.t)
    const error = this.capabilityError ?? (snapshot.error === undefined ? undefined : remoteErrorMessage(snapshot.error))
    this.pane.setSummary(workflowSummary(runs, this.t) ?? (error === undefined ? null : { node: { kind: 'text', content: this.t('workflow unavailable'), tone: 'warning' } }))
    this.pane.set(error === undefined ? node : ui.stack.column([
      ...node === null ? [] : [{ node }],
      { node: ui.text(error, { tone: 'danger', overflow: 'wrap' }) },
      { node: ui.actions({ id: 'workflow-actions', items: [{ id: 'workflow-refresh', label: this.t('Refresh'), hintLabel: this.t('refresh'), semantic: 'refresh', hidden: true }] }) },
    ]))
  }

  private readonly act = async (event: MayflyUiActionEvent, context: MayflyUiEventContext): Promise<MayflyUiActionReply> => {
    if (this.disposed || context.signal.aborted) return { kind: 'cancelled' }
    if (event.kind === 'activate' && event.actionId === 'workflow-refresh') {
      this.attach(this.lifecycle.currentGeneration())
      return { kind: 'completed' }
    }
    if (event.kind === 'selection-accept' && event.controlId === WORKFLOW_VIEW_LIST_ID) {
      const id = event.selectedIds[0]
      return id === undefined ? { kind: 'completed' } : await this.seam.open(id, context.signal)
    }
    if (event.kind !== 'activate' || event.actionId !== WORKFLOW_VIEW_STOP_ID) return { kind: 'completed' }
    const id = event.inputs?.selections?.find(selection => selection.controlId === WORKFLOW_VIEW_LIST_ID)?.selectedIds[0]
    const run = this.runs().find(candidate => candidate.agents.some(agent => String(agent.childId) === id))
    const job = run === undefined ? undefined : this.jobOf(run)
    const ref = this.jobsRef
    if (run === undefined || job === undefined || ref === undefined) return { kind: 'failed', message: this.t('A foreground workflow stops with Esc') }
    try {
      await remoteValue(this.jobs.kill(ref, job.id))
      return context.signal.aborted ? { kind: 'cancelled' } : { kind: 'completed', feedback: { severity: 'success', message: this.t('Stopping {name}', { name: run.name }) } }
    } catch (error) {
      return context.signal.aborted ? { kind: 'cancelled' } : { kind: 'failed', message: remoteErrorMessage(error) }
    }
  }
}

/**
 * Mount the Workflow view.
 * @param options - the feature context.
 * @param seam - the child opener it shares with `/agents`.
 * @returns the disposer, which retires both streams, its timer, and its pane.
 */
export function mountWorkflowFeature(options: RemoteFeatureContext, seam: WorkflowViewSeam): () => void {
  return new RemoteWorkflowController(options, seam).dispose
}
