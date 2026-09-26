/**
 * The command-group card: one tree for a run of consecutive terminal-card
 * calls (bash and friends). Each member leads as a command row carrying its
 * settlement state (a non-zero exit or signal reads as failed); the expanded
 * card nests the member's bounded output tail under its row. Once the turn
 * has ended, a member still pending reads as cancelled.
 *
 * @module @ephemeral-ai/mayfly/transcript/command-group
 */

import { sanitizePluginText, type MayflyComponent, type MayflyComponents, type MayflySemanticColors } from '../core/index.ts'
import { interpolateLocaleMessage, type CommandCallModel, type MayflyTranslate, type TranscriptCommandGroupModel } from '../frontend/index.ts'
import { moreRowsHint } from './hints.ts'

/** Tree rows kept in the collapsed card before the expand hint. */
export const COMMAND_GROUP_ROW_LIMIT = 8

/** Colors plus width helpers threaded through the row builders. */
interface RenderDeps {
  readonly colors: MayflySemanticColors
  readonly components: MayflyComponents
  /** Whether the group's turn has ended: a pending member reads as cancelled. */
  readonly closed: boolean
}

/**
 * Render one command group as the kimi tool-card family shape: a blank spacer,
 * the status header, then the per-command tree.
 * @param model - the frozen group model.
 * @param colors - the semantic color table.
 * @param components - the component factory providing the width helpers.
 * @param t - transcript translator for the fold hint.
 */
export class CommandGroupComponent implements MayflyComponent {
  private expanded = false
  private keyed = true
  private closed = false
  private cache: { key: string; lines: string[] } | null = null

  constructor(
    private model: TranscriptCommandGroupModel,
    private readonly colors: MayflySemanticColors,
    private readonly components: MayflyComponents,
    private readonly t: MayflyTranslate = interpolateLocaleMessage,
  ) {}

  /** Adopt whether Ctrl-O reaches the card and whether its turn has ended. */
  setScope(scope: { readonly hint: boolean, readonly turnClosed: boolean }): void {
    this.keyed = scope.hint
    this.closed = scope.turnClosed
  }

  /** Switch between the collapsed tree and the expanded preview-bearing tree. */
  setExpanded(expanded: boolean): void { this.expanded = expanded }

  /** Drop the cached lines; the next render rebuilds. */
  invalidate(): void { this.cache = null }

  /** Replace the immutable group snapshot while preserving expansion state. */
  update(model: TranscriptCommandGroupModel): void { this.model = model; this.invalidate() }

  /** @param width - current viewport width in columns. @returns the rows. */
  render(width: number): string[] {
    const key = `${String(width)}:${String(this.expanded)}:${String(this.keyed)}:${String(this.closed)}`
    if (this.cache?.key === key) return this.cache.lines
    const lines = this.renderTree(width)
    this.cache = { key, lines }
    return lines
  }

  private renderTree(width: number): string[] {
    const deps: RenderDeps = { colors: this.colors, components: this.components, closed: this.closed }
    const cut = (row: string): string => this.components.truncateToWidth(row, width)
    const clamp = (rows: string[]): string[] => rows.map(cut)
    const header = this.renderHeader(width)
    const tree = this.renderCommandRows(deps, cut)
    if (this.expanded) return clamp(['', header, ...tree])
    const limit = COMMAND_GROUP_ROW_LIMIT
    if (tree.length <= limit) return clamp(['', header, ...tree])
    const hint = moreRowsHint(this.t, tree.length - (limit - 1), this.keyed)
    return clamp(['', header, ...tree.slice(0, limit - 1), `  ${this.colors.textMuted(hint)}`])
  }

  private renderHeader(width: number): string {
    const { colors, components } = this
    const commands = this.model.commands
    const count = commands.length
    const unsettled = commands.filter(call => call.state === 'pending').length
    const pending = this.closed ? 0 : unsettled
    const failed = commands.filter(call => call.state === 'error').length
    const bold = (text: string): string => components.strong(String(text))
    const noun = count === 1 ? 'command' : 'commands'
    const label = pending > 0
      ? bold(colors.primary(`Running ${String(count)} ${noun}…`))
      : failed === count
        ? bold(colors.error(`Ran ${String(count)} ${noun} · failed`))
        : bold(colors.primary(`Ran ${String(count)} ${noun}`))
    let header = `${String(pending > 0 ? colors.text('● ') : failed === count ? colors.error('✗ ') : failed > 0 ? colors.warning('◐ ') : colors.success('✓ '))}${String(label)}`
    if (failed > 0 && failed < count) header += colors.error(` · ${String(failed)} failed`)
    if (this.closed && unsettled > 0) header += colors.muted(` · ${String(unsettled)} cancelled`)
    return components.truncateToWidth(header, width)
  }

  private renderCommandRow(call: CommandCallModel, branch: string, deps: RenderDeps, cut: (row: string) => string): string {
    const command = sanitizePluginText(call.command).replace(/[\r\n]+/gu, ' ')
    if (call.state === 'error') {
      const error = call.error === undefined ? '' : ` ${deps.colors.error(sanitizePluginText(call.error).replace(/[\r\n]+/gu, ' '))}`
      return cut(`  ${String(branch)} ${command} ${deps.colors.error('✗')}${error}`)
    }
    if (call.state === 'pending') return cut(`  ${String(branch)} ${command} ${deps.closed ? deps.colors.muted('⊘') : deps.colors.textMuted('…')}`)
    return cut(`  ${String(branch)} ${command} ${deps.colors.success('✓')}`)
  }

  private renderCommandRows(deps: RenderDeps, cut: (row: string) => string): string[] {
    const rows: string[] = []
    const commands = this.model.commands
    commands.forEach((call, index) => {
      const last = index === commands.length - 1
      const branch = last ? '└─' : '├─'
      const continuation = last ? '   ' : '│  '
      rows.push(this.renderCommandRow(call, branch, deps, cut))
      if (this.expanded && call.previewLines !== undefined) {
        for (const line of call.previewLines) {
          rows.push(cut(`  ${String(continuation)}${deps.colors.muted(sanitizePluginText(line).replace(/[\r\n]+/gu, ' '))}`))
        }
      }
    })
    return rows
  }
}
