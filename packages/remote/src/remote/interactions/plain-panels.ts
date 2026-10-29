/**
 * Existing command, Session, release, and status panels over the shared Remote overlay host.
 * @module @ephemeral-ai/mayfly/remote/interactions/plain-panels
 */

import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { MAYFLY_VERSION } from '@ephemeral-ai/mayfly/banner-content'
import { contextPercent, formatTokens } from '@ephemeral-ai/mayfly/status-context'
import type {
  MayflyComponents,
  MayflyFocusable,
  MayflySemanticColors,
} from '@ephemeral-ai/mayfly/core'
import type { SessionRef } from '../../client/types.ts'
import type { HostActions } from '../../frontend/host-actions.ts'
import type { RemotePresentationFacts } from '../../transcript/remote-model.ts'
import type { RemoteOverlayHost, RemoteOverlayLease } from '../panels.ts'

/** One Host command descriptor exposed by the official Remote catalog. */
export type RemoteCommandDescriptor = Awaited<ReturnType<HostActions['listCommands']>>[number]

/** Panel operations consumed by the remote command router. */
export interface RemoteAppPanels {
  /** Show local and Host command descriptors. */
  showHelp(commands: readonly RemoteCommandDescriptor[]): void
  /** Show current Session facts. */
  showStatus(facts: RemotePresentationFacts): void
  /** Show the Frontend release. */
  showVersion(): void
  /** Show and select the current Host's Session catalog. */
  showSessions(sessions: readonly SessionSummary[], current: SessionRef | undefined, select: (sessionId: string) => void): void
}

interface PanelRow {
  readonly text: string
  readonly value?: string
  readonly current?: boolean
}

const MAX_VISIBLE_ROWS = 14

class RemotePlainPanel implements MayflyFocusable {
  focused = false
  private selected = 0
  private scrollTop = 0

  constructor(
    private readonly title: string,
    private readonly rows: readonly PanelRow[],
    private readonly components: MayflyComponents,
    private readonly colors: MayflySemanticColors,
    private readonly close: () => void,
    private readonly select?: (value: string) => void,
  ) {
    this.selected = Math.max(0, rows.findIndex(row => row.value !== undefined && row.current === true))
  }

  handleInput(data: string): void {
    if (data === '\x1b' || data === '\x03' || data === 'q' || data === 'Q') {
      this.close()
      return
    }
    if (data === '\x1b[A') {
      this.move(-1)
      return
    }
    if (data === '\x1b[B') {
      this.move(1)
      return
    }
    if ((data === '\r' || data === '\n') && this.select !== undefined) {
      const row = this.rows[this.selected]
      if (row?.value !== undefined) this.select(row.value)
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const visible = this.rows.slice(this.scrollTop, this.scrollTop + MAX_VISIBLE_ROWS)
    const lines = visible.map((row, index) => {
      const position = this.scrollTop + index
      const selected = this.select !== undefined && row.value !== undefined && position === this.selected
      const prefix = selected ? '> ' : row.current === true ? '* ' : '  '
      const text = `${prefix}${row.text}`
      return this.components.truncateToWidth(selected ? this.colors.accent(text) : row.current === true ? this.colors.primary(text) : text, width)
    })
    const range = this.rows.length === 0 ? '' : ` ${this.scrollTop + 1}-${Math.min(this.rows.length, this.scrollTop + MAX_VISIBLE_ROWS)}/${this.rows.length}`
    const hint = this.select === undefined ? 'Esc close' : '↑↓ select · Enter open · Esc close'
    return [
      this.components.truncateToWidth(this.colors.primary(this.title), width),
      ...lines,
      this.components.truncateToWidth(this.colors.muted(`${range}${range === '' ? '' : ' · '}${hint}`), width),
    ]
  }

  private move(delta: number): void {
    if (this.select === undefined) {
      this.scrollTop = Math.max(0, Math.min(Math.max(0, this.rows.length - MAX_VISIBLE_ROWS), this.scrollTop + delta))
      return
    }
    const selectable = this.rows.map((row, index) => row.value === undefined ? -1 : index).filter(index => index >= 0)
    if (selectable.length === 0) return
    const position = selectable.indexOf(this.selected)
    this.selected = selectable[Math.max(0, Math.min(selectable.length - 1, position + delta))]!
    if (this.selected < this.scrollTop) this.scrollTop = this.selected
    if (this.selected >= this.scrollTop + MAX_VISIBLE_ROWS) this.scrollTop = this.selected - MAX_VISIBLE_ROWS + 1
  }
}

/** Existing plain-panel behavior, separated from the feature-neutral overlay host. */
export class RemotePlainPanels implements RemoteAppPanels {
  constructor(
    private readonly overlays: RemoteOverlayHost,
    private readonly components: MayflyComponents,
    private readonly colors: MayflySemanticColors,
  ) {}

  showHelp(commands: readonly RemoteCommandDescriptor[]): void {
    this.open('Commands', commands.map(command => ({
      text: `/${command.name} — ${command.description}`,
    })))
  }

  showStatus(facts: RemotePresentationFacts): void {
    const context = facts.contextTokens <= 0
      ? 'no usage yet'
      : facts.contextWindow === undefined
        ? `${formatTokens(facts.contextTokens)} tokens`
        : `${contextPercent(facts.contextTokens, facts.contextWindow)}% (${formatTokens(facts.contextTokens)}/${formatTokens(facts.contextWindow)})`
    this.open('Session status', [
      { text: `Host: ${facts.ref?.host ?? 'none'}` },
      { text: `Session: ${facts.ref?.sessionId ?? 'none'}` },
      { text: `Directory: ${facts.cwd || 'unknown'}` },
      { text: `Model: ${facts.model ?? 'default'} · ${facts.provider ?? 'default'}` },
      { text: `Context: ${context}` },
      { text: `State: ${facts.active ? facts.phase : 'idle'}` },
      ...(facts.title === undefined ? [] : [{ text: `Title: ${facts.title}` }]),
    ])
  }

  showVersion(): void {
    this.open('Version', [{ text: `Mayfly v${MAYFLY_VERSION}` }])
  }

  showSessions(sessions: readonly SessionSummary[], current: SessionRef | undefined, select: (sessionId: string) => void): void {
    const rows = sessions.map(session => ({
      text: `${session.displayTitle} · ${String(session.id)}`,
      value: String(session.id),
      current: current?.sessionId === session.id,
    }))
    this.open('Sessions', rows.length === 0 ? [{ text: 'No Sessions on this Host' }] : rows, select)
  }

  private open(title: string, rows: readonly PanelRow[], select?: (value: string) => void): void {
    let lease!: RemoteOverlayLease
    lease = this.overlays.open(new RemotePlainPanel(title, rows, this.components, this.colors, () => lease.close(), select === undefined
      ? undefined
      : value => {
          select(value)
          lease.close()
        }))
  }
}
