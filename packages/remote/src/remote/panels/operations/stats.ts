/**
 * Current Session statistics panel assembled from official projections and the
 * Host session catalog, without fabricated history charts.
 * @module @ephemeral-ai/mayfly/remote/panels/operations/stats
 */

import { panel, ui, type MayflyTranslate, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

/** Session-scoped statistics read from the `sessionStats` projection. */
export interface RemoteStatsSession {
  readonly turns: number | undefined
  readonly steps: number | undefined
  readonly llmMs: number | undefined
  readonly toolMs: number | undefined
  readonly ttftMs: number | undefined
  readonly decodeMs: number | undefined
  readonly decodeTokens: number | undefined
}

/** Prompt-side and generation token accounting from `tokenUsage`. */
export interface RemoteStatsUsage {
  readonly input: number | undefined
  readonly cacheRead: number | undefined
  readonly cacheWrite: number | undefined
  readonly output: number | undefined
}

/** Occupancy facts from `contextPressure`. */
export interface RemoteStatsContext {
  readonly used: number | undefined
  readonly window: number | undefined
}

/** Currently selected model route from `modelSelection`. */
export interface RemoteStatsModel {
  readonly provider: string | undefined
  readonly model: string | undefined
  readonly reasoningEffort: string | undefined
}

/** One Host catalog row in the recent-session list. */
export interface RemoteStatsSessionRow {
  readonly id: string
  readonly title: string
  readonly updatedAt: number | undefined
  readonly running: boolean
  readonly current: boolean
}

/** Stats panel state; every field is a real projection or catalog value. */
export interface RemoteStatsState {
  readonly sessionId: string | undefined
  readonly session: RemoteStatsSession
  readonly usage: RemoteStatsUsage
  readonly context: RemoteStatsContext
  readonly model: RemoteStatsModel
  readonly totalSessions: number | undefined
  readonly recent: readonly RemoteStatsSessionRow[]
  readonly error: string | undefined
}

function formatTokens(count: number | undefined): string {
  if (count === undefined) return ''
  if (count >= 1024 * 1024) return `${(count / (1024 * 1024)).toFixed(1)}M`
  if (count >= 1024) return `${(count / 1024).toFixed(1)}k`
  return String(count)
}

/** Build the current Session statistics panel with the Host catalog tail. */
export function remoteStatsPanel(state: RemoteStatsState, t: MayflyTranslate): MayflyUiNode {
  const share = state.context.used !== undefined && state.context.window !== undefined && state.context.window > 0
    ? `${String(Math.round((state.context.used / state.context.window) * 100))}%`
    : ''
  const recent = state.recent.map(entry => ({
    id: entry.id,
    label: entry.title,
    cells: [
      { spans: [{ text: entry.running ? t('live') : '', tone: entry.running ? 'success' as const : 'muted' as const }] },
      { spans: [{ text: entry.updatedAt === undefined ? '' : new Date(entry.updatedAt).toISOString().slice(0, 16).replace('T', ' '), tone: 'muted' as const }], align: 'right' as const },
    ],
  }))
  return panel({
    title: t('Session statistics'),
    escapeLabel: 'close',
    body: ui.stack.column([
      ...state.error === undefined ? [] : [ui.text(state.error, { tone: 'danger', overflow: 'wrap' })],
      ui.divider({ label: t('Session') }),
      ui.fields([
        { label: t('Turns'), value: [{ text: state.session.turns === undefined ? t('unavailable') : String(state.session.turns) }] },
        { label: t('Steps'), value: [{ text: state.session.steps === undefined ? t('unavailable') : String(state.session.steps) }] },
        { label: t('Session'), value: [{ text: state.sessionId ?? t('unavailable'), tone: 'muted' }] },
      ]),
      ui.divider({ label: t('Model') }),
      ui.fields([
        { label: t('Provider'), value: [{ text: state.model.provider ?? t('unavailable') }] },
        { label: t('Model'), value: [{ text: state.model.model ?? t('unavailable') }] },
        { label: t('Reasoning'), value: [{ text: state.model.reasoningEffort ?? t('default') }] },
      ]),
      ui.divider({ label: t('Tokens') }),
      ui.fields([
        { label: t('Input'), value: [{ text: state.usage.input === undefined ? t('unavailable') : formatTokens(state.usage.input) }] },
        { label: t('Cache read'), value: [{ text: state.usage.cacheRead === undefined ? t('unavailable') : formatTokens(state.usage.cacheRead) }] },
        { label: t('Cache write'), value: [{ text: state.usage.cacheWrite === undefined ? t('unavailable') : formatTokens(state.usage.cacheWrite) }] },
        { label: t('Output'), value: [{ text: state.usage.output === undefined ? t('unavailable') : formatTokens(state.usage.output) }] },
      ]),
      ui.divider({ label: t('Context') }),
      ui.fields([
        { label: t('Used'), value: [{ text: state.context.used === undefined ? t('unavailable') : formatTokens(state.context.used) }] },
        { label: t('Window'), value: [{ text: state.context.window === undefined ? t('unavailable') : formatTokens(state.context.window) }] },
        { label: t('Share'), value: [{ text: share === '' ? t('unavailable') : share, tone: share !== '' && Number.parseInt(share, 10) >= 90 ? 'danger' : 'default' }] },
      ]),
      ui.divider({ label: t('Host sessions') }),
      ui.fields([
        { label: t('Total'), value: [{ text: state.totalSessions === undefined ? t('unavailable') : String(state.totalSessions) }] },
      ]),
      ...recent.length === 0 ? [ui.text(t('No sessions in the Host catalog'), { tone: 'muted' })] : [
        ui.list({ id: 'stats-recent', role: 'browse', selectedIds: [], items: recent }),
      ],
      ui.text(t('Figures come from live projections; no full history is replayed for this panel.'), { tone: 'muted' }),
    ]),
  })
}
