/**
 * Views lane (roadmap slice 1.10b): a pane with `placement: 'views'` is a view of status row 2. It declares a
 * `summary` (a status node and a tab count) that joins the row, and its node is the panel shown in place of the row
 * while the view is entered (`Alt+↓`, `F5` or `F6`; `←/→` switch views; `Esc` returns to the prompt). The view
 * updates the row with `setSummary` and takes itself out with `setSummary(null)`.
 *
 * @module @mayfly-example/ui-gallery/groups/views
 */
import type { Context } from '@deepseek-ai/cordis'
import { ui, type MayflyPaneSummary } from '@ephemeral-ai/mayfly-ui'

const RUNS = ['build', 'test', 'lint']

/** The row-2 chip: a muted label, an accent dot, and how many runs are tracked. */
function summaryFor(tracked: number): MayflyPaneSummary {
  return {
    node: ui.richText([{ text: 'Gallery ', tone: 'muted' }, { text: '●', tone: 'accent' }, { text: ` ${String(tracked)} runs` }]),
    count: tracked,
  }
}

/** The panel: the tracked runs and the actions that change the summary. */
function panelFor(tracked: number) {
  return ui.stack.column([
    ui.text('A view of status row 2. Its summary sits in the row; this panel replaces the row while you are inside.', { tone: 'muted' }),
    ui.list({
      id: 'gallery-view-runs',
      role: 'browse',
      selectedIds: [],
      items: RUNS.slice(0, tracked).map(run => ({ id: `gallery-view-${run}`, label: run, detail: 'tracked run' })),
    }),
    ui.actions({
      id: 'gallery-view-actions',
      items: [
        { id: 'gallery-view-track', label: 'Track another run', intent: 'primary', disabled: tracked >= RUNS.length, disabledReason: 'every run is tracked' },
        { id: 'gallery-view-clear', label: 'Hide the view', intent: 'secondary' },
      ],
    }),
  ])
}

/**
 * Register the gallery's view through the public pane service. The panel reacts to its own actions: tracking a run
 * republishes the panel and the summary, and hiding the view takes it out of row 2 until the next track.
 * @param ctx - a context that injects `mayflyPanes`.
 */
export function registerGalleryView(ctx: Context): void {
  let tracked = 2
  const pane = ctx.mayflyPanes.register({
    id: 'example.ui-gallery.view',
    title: 'Gallery',
    placement: 'views',
    priority: 100,
    summary: summaryFor(tracked),
    onEvent: {
      action: event => {
        if (event.kind !== 'activate') return { kind: 'completed' }
        if (event.actionId === 'gallery-view-clear') pane.setSummary(null)
        else {
          tracked = Math.min(RUNS.length, tracked + 1)
          pane.setSummary(summaryFor(tracked))
          pane.set(panelFor(tracked))
        }
        return { kind: 'completed', feedback: { severity: 'info', message: 'Gallery view updated' } }
      },
    },
  }, panelFor(tracked))
}
