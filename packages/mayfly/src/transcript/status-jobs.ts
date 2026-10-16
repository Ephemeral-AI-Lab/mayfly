/**
 * The Jobs item of the status row: a views pane over the background jobs the attached Agent owns. The row carries
 * `● jobs 2` (how many are live). When the last live job settles
 * the item holds `✓ jobs 3/3` (`✕` when one failed on its own) for five seconds and leaves. The panel, shown under
 * the row while the view is entered (`Alt+↓`), is a list with a cursor, live jobs first (oldest first), one line each:
 * the mark, the label, and the producer's progress line (`rebuilt 2`), with the time at the right edge; with the
 * `viewHistory` setting on, settled jobs follow, newest first, with their terminal detail (`exit code: 1`). `↑/↓` choose a row,
 * `Enter` opens the job's output in the reader `/jobs` uses (an interim target until Phase 6f), and `x` stops a running
 * job behind the shared Yes/No after rechecking `jobs.get`. Subagent jobs belong to the Agents item and are not listed.
 * The registration is the Fiber's.
 *
 * @module @ephemeral-ai/mayfly/transcript/status-jobs
 */

import type { Context } from '@deepseek-ai/cordis'
import { JobId, type JobView } from '@deepseek-ai/dsh-jobs'
import { ui, type MayflyInlineSpan, type MayflyListItem, type MayflyPaneSummary, type MayflyUiActionEvent, type MayflyUiActionReply, type MayflyUiEventContext, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/locale.ts'
import { interactionTranslator } from '../interaction/locale.ts'
import { isLiveJob, openJobOutput, sortJobs } from '../interaction/jobs.ts'
import { compactElapsedMs } from './agent-presentation.ts'
import { observeTranscriptLocale, transcriptTranslator } from './locale.ts'
import { DONE_LINGER_MS } from './pane-todo.ts'
import type { TickSource } from './tick.ts'
import { countSummary, followViewHistory, itemSummary, viewList } from './view-items.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-status-jobs'

/** Native and Mayfly services required by the view. */
export const inject = ['mayflyPanes', 'mayflyCurrentAgent', 'mayflyScreen', 'mayflyTick', 'mayflyOverlays', 'jobs']

/** The Jobs view's place in the status row: after git (10) and agents (11), before goal (13) and todo (14). */
const VIEW_PRIORITY = 12

const LIST_ID = 'jobs-list'
const STOP_ID = 'jobs-stop'

/** The reason handed to `jobs.kill` for a stop from the panel. */
const STOP_REASON = 'stopped from the Mayfly jobs view'

/** The jobs this item owns: every job except the subagents the Agents item shows. */
const isOwnJob = (job: JobView): boolean => job.kind !== 'subagent'

/** What the item renders from. */
export interface JobsState {
  /** The Agent's jobs (subagents left out), in the registry's order. */
  readonly jobs: readonly JobView[]
  /** The time the elapsed figures are measured against. */
  readonly now: number
  /** Whether settled jobs are listed beside the live ones (the `viewHistory` setting). */
  readonly history: boolean
  /** The jobs that were live together and have all settled: how many, and whether one failed. */
  readonly done?: { readonly total: number, readonly failed: boolean }
  /** The jobs the user stopped from the panel. */
  readonly stoppedByUser?: ReadonlySet<string>
}

/**
 * The summary in the row: `● jobs 2` while any job is live, `✓ jobs 3/3` (`✕` when one failed) while the last
 * group's closing line is held.
 * @param state - the jobs.
 * @param t - translator for the label.
 * @returns the summary, or `null` when nothing is live and no closing line is held.
 */
export function jobsSummary(state: JobsState, t: MayflyTranslate): MayflyPaneSummary | null {
  const live = state.jobs.filter(isLiveJob)
  if (live.length > 0) {
    return { node: countSummary({ text: '●', tone: 'accent' }, t('jobs'), live.length) }
  }
  if (state.done === undefined) return null
  const { total, failed } = state.done
  const mark: MayflyInlineSpan = failed ? { text: '✕', tone: 'danger' } : { text: '✓', tone: 'success' }
  return { node: itemSummary(mark, t('jobs'), total, total) }
}

function markOf(job: JobView, stopped: boolean): MayflyInlineSpan {
  if (job.status === 'running') return { text: '●', tone: 'accent' }
  if (job.status === 'stopping') return { text: '●', tone: 'muted' }
  if (job.status === 'killed' || stopped) return { text: '⊘', tone: 'muted' }
  return job.status === 'failed' ? { text: '✕', tone: 'danger' } : { text: '✓', tone: 'success' }
}

/** One row: `● npm run watch   rebuilt 2                                 41s`. */
function jobItem(job: JobView, state: JobsState, t: MayflyTranslate, unavailable: Readonly<Record<string, string>>): MayflyListItem {
  const stopped = job.status === 'killed' || state.stoppedByUser?.has(String(job.id)) === true
  const elapsed = compactElapsedMs(Math.max(0, (job.finishedAt ?? state.now) - job.startedAt))
  const trailing = isLiveJob(job) ? job.progress : stopped ? undefined : job.detail
  const status = job.status === 'stopping' ? t('stopping') : stopped ? t('stopped') : ''
  const muted = (text: string | undefined): readonly MayflyInlineSpan[] => text === undefined || text === '' ? [] : [{ text, tone: 'muted' }]
  // The columns line up down the list: the label, the producer's line, and the state word; the time is at the right edge.
  return {
    id: String(job.id),
    label: job.label,
    labelSpans: [markOf(job, stopped), { text: ' ' }],
    cells: [
      { spans: [{ text: job.label, tone: isLiveJob(job) ? 'default' : 'muted' }], max: 40 },
      { spans: muted(trailing), max: 30, shed: 2 },
      { spans: muted(status) },
    ],
    right: muted(elapsed),
    unavailableActions: unavailable,
  }
}

/** The jobs the panel lists: the live ones, oldest first, then (with history) the settled ones, newest first. */
export function listedJobs(state: JobsState): readonly JobView[] {
  const sorted = sortJobs(state.jobs)
  return state.history ? sorted : sorted.filter(isLiveJob)
}

/**
 * The panel: the listed jobs in the list every item with chosen rows shares, with `x` beside it (it names why it cannot
 * act on a row that cannot take it).
 * @param state - the jobs.
 * @param t - translator for the words.
 * @param unavailable - why `x` cannot act on a job, by job.
 * @returns the panel node, or `null` when no job is listed.
 */
export function jobsPanel(state: JobsState, t: MayflyTranslate, unavailable: (job: JobView) => Readonly<Record<string, string>>): MayflyUiNode | null {
  const listed = listedJobs(state)
  if (listed.length === 0) return null
  const actions = ui.actions({
    id: 'jobs-actions',
    items: [{
      id: STOP_ID, label: t('stop'), hidden: true, semantic: 'delete', hintLabel: t('stop'), selections: [{ pagePath: [], controlId: LIST_ID }],
      confirm: { title: t('Stop this job?'), detail: t('The job is asked to end; its output stays readable.'), confirmLabel: t('Stop'), tone: 'danger' },
    }],
  })
  return viewList(LIST_ID, listed.map(job => jobItem(job, state, t, unavailable(job))), actions)
}

/** Register the Jobs item under the calling Fiber. */
export function apply(ctx: Context): void {
  const t = transcriptTranslator(ctx, 'transcript')
  const ti = interactionTranslator(ctx)
  const tick = ctx.get('mayflyTick') as TickSource | undefined
  const lifetime = new AbortController()
  let unloaded = false

  /** The Agent the rows belong to: an action built for another is refused. */
  let owner = ctx.mayflyCurrentAgent.current()
  let jobs: readonly JobView[] = []
  let now = Date.now()
  let published = ''
  let offTick: (() => void) | undefined
  /** The jobs seen live since nothing was live, which the closing line counts. */
  const batch = new Set<string>()
  let batchLive = false
  let done: { readonly total: number, readonly failed: boolean, readonly at: number } | undefined
  /** The jobs the user stopped from the panel. */
  const stoppedByUser = new Set<string>()

  const unavailable = (job: JobView): Readonly<Record<string, string>> =>
    job.status === 'running' ? {} : { [STOP_ID]: job.status === 'stopping' ? t('Already stopping') : t('Already finished') }

  const act = async (event: MayflyUiActionEvent, context: MayflyUiEventContext): Promise<MayflyUiActionReply> => {
    const agent = ctx.mayflyCurrentAgent.current()
    if (agent === null || agent !== owner) return { kind: 'failed', message: t('The agent changed; open it again') }
    const stopping = event.kind === 'activate' && event.actionId === STOP_ID
    if (event.kind !== 'selection-accept' && !stopping) return { kind: 'completed' }
    const chosen = event.kind === 'selection-accept' ? event.selectedIds[0]
      : event.kind === 'activate' ? event.inputs?.selections?.find(selection => selection.controlId === LIST_ID)?.selectedIds[0]
        : undefined
    if (chosen === undefined || !jobs.some(job => String(job.id) === chosen)) return { kind: 'failed', message: t('Select a job first') }
    try {
      // The registry is the authority: the row may be a refresh behind.
      const id = JobId(chosen)
      const job = ctx.jobs.get(id, agent.id)
      if (event.kind === 'selection-accept') {
        ctx.mayflyScreen.leaveViews()
        // Closing the reader brings the user back to this view, not to the prompt. The overlay hands focus back to the
        // prompt as it goes, so the view is entered after that.
        await openJobOutput(ctx, agent, id, lifetime.signal, ti, () => {
          setImmediate(() => { if (!unloaded && ctx.mayflyCurrentAgent.current() === agent) ctx.mayflyScreen.enterViews() })
        })
        return { kind: 'completed' }
      }
      if (context.signal.aborted || unloaded) return { kind: 'cancelled' }
      if (job.status !== 'running') return { kind: 'failed', message: job.status === 'stopping' ? t('Already stopping') : t('Already finished') }
      ctx.jobs.kill(id, agent.id, STOP_REASON)
      stoppedByUser.add(chosen)
      refresh()
      return { kind: 'completed', feedback: { severity: 'success', message: t('Stopping {job}', { job: job.label }) } }
    } catch (error) {
      return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
    }
  }
  const pane = ctx.mayflyPanes.register({ id: 'mayfly.view.jobs', placement: 'views', priority: VIEW_PRIORITY, onEvent: { action: act } }, null)
  const view = followViewHistory(ctx, () => { published = ''; publish() })

  const syncTick = (): void => {
    if (!jobs.some(isLiveJob) && done === undefined) { offTick?.(); offTick = undefined; return }
    offTick ??= tick?.subscribe((at) => {
      now = at
      if (done !== undefined && at - done.at >= DONE_LINGER_MS) done = undefined
      publish()
    })
  }
  /** Group the live jobs and turn the end of a group into its closing line. */
  const track = (): void => {
    const live = jobs.filter(isLiveJob)
    if (live.length > 0) {
      if (!batchLive) { batch.clear(); done = undefined; batchLive = true }
      for (const job of live) batch.add(String(job.id))
      return
    }
    if (!batchLive) return
    batchLive = false
    const ran = jobs.filter(job => batch.has(String(job.id)))
    batch.clear()
    if (ran.length === 0) return
    done = {
      total: ran.length,
      failed: ran.some(job => job.status === 'failed'),
      at: now,
    }
  }
  const publish = (): void => {
    syncTick()
    const state: JobsState = { jobs, now, history: view.history(), stoppedByUser, ...done === undefined ? {} : { done: { total: done.total, failed: done.failed } } }
    const summary = jobsSummary(state, t)
    const panel = jobsPanel(state, t, unavailable)
    const key = JSON.stringify([summary, panel])
    if (key === published) return
    published = key
    pane.set(panel)
    pane.setSummary(summary)
  }
  const refresh = (): void => {
    if (unloaded) return
    now = Date.now()
    const agent = ctx.mayflyCurrentAgent.current()
    try {
      jobs = agent === null ? [] : ctx.jobs.list(agent.id).filter(isOwnJob)
    } catch (error) {
      ctx.logger.warn(`could not list background jobs for status: ${error instanceof Error ? error.message : String(error)}`)
      jobs = []
    }
    track()
    publish()
  }

  const offJobs = ctx.jobs.events.subscribe({ owners: 'scope' }, (event) => {
    // Output chunks cannot change a row: every status or progress change arrives as its own registered/progress/stopping/
    // settled/removed event, so a chatty background job no longer lists per chunk.
    if (event.type === 'output') return
    const current = ctx.mayflyCurrentAgent.current()
    if (event.job.owner === undefined || event.job.owner === current?.id) refresh()
  })
  const offAgent = ctx.mayflyCurrentAgent.subscribe((agent) => {
    if (agent === owner) return
    owner = agent
    jobs = []
    batch.clear()
    batchLive = false
    done = undefined
    stoppedByUser.clear()
    refresh()
  })
  const offLocale = observeTranscriptLocale(ctx, () => { published = ''; publish() })
  ctx.effect(() => () => {
    unloaded = true
    lifetime.abort()
    offJobs()
    offAgent()
    offLocale()
    offTick?.()
    pane.dispose()
  })
  refresh()
}
