/**
 * The command-group card: one tree for a run of consecutive terminal-card
 * calls (bash and friends). Each member leads as a command row carrying its
 * settlement state; the expanded card nests the member's bounded output tail
 * under its row. Compact detail renders only the header plus one row per
 * failed member — failures stay legible while the run stays a summary.
 *
 * @module @ephemeral-ai/mayfly/transcript/command-group
 */

import { sanitizePluginText, type MayflyComponent, type MayflyComponents, type MayflySemanticColors } from '../core/index.ts'
import type { CommandCallModel, TranscriptCommandGroupModel } from '../frontend/index.ts'
import type { TranscriptDetail } from './presentation-policy.ts'

/** Tree rows kept in the collapsed card before the expand hint. */
export const COMMAND_GROUP_ROW_LIMIT = 8

/** Colors plus width helpers threaded through the row builders. */
interface RenderDeps {
  readonly colors: MayflySemanticColors
  readonly components: MayflyComponents
}

/**
 * Render one command group as the kimi tool-card family shape: a blank spacer,
 * the status header, then the per-command tree.
 * @param model - the frozen group model.
 * @param colors - the semantic color table.
 * @param components - the component factory providing the width helpers.
 * @param detail - the `command` family's current detail level; `compact`
 *   renders the header plus failed-member rows only.
 */
export class CommandGroupComponent implements MayflyComponent {
  private expanded = false
  private cache: { key: string; lines: string[] } | null = null

  constructor(
    private model: TranscriptCommandGroupModel,
    private readonly colors: MayflySemanticColors,
    private readonly components: MayflyComponents,
    private readonly detail: () => TranscriptDetail = () => 'collapsed',
  ) {}

  /** Switch between the collapsed tree and the expanded preview-bearing tree. */
  setExpanded(expanded: boolean): void { this.expanded = expanded }

  /** Drop the cached lines; the next render rebuilds. */
  invalidate(): void { this.cache = null }

  /** Replace the immutable group snapshot while preserving expansion state. */
  update(model: TranscriptCommandGroupModel): void { this.model = model; this.invalidate() }

  /** @param width - current viewport width in columns. @returns the rows. */
  render(width: number): string[] {
    const detail = this.detail()
    const key = `${String(width)}:${String(this.expanded)}:${detail}`
    if (this.cache?.key === key) return this.cache.lines
    const lines = this.renderTree(width, detail)
    this.cache = { key, lines }
    return lines
  }

  private renderTree(width: number, detail: TranscriptDetail): string[] {
    const deps: RenderDeps = { colors: this.colors, components: this.components }
    const cut = (row: string): string => this.components.truncateToWidth(row, width)
    const clamp = (rows: string[]): string[] => rows.map(cut)
    const header = this.renderHeader(width)
    if (detail === 'compact' && !this.expanded) {
      const failed = this.model.commands.filter(call => call.state === 'error')
      return clamp(['', header, ...failed.map((call, index) =>
        this.renderCommandRow(call, index === failed.length - 1 ? '└─' : '├─', deps, cut))])
    }
    const tree = this.renderCommandRows(deps, cut)
    if (this.expanded || detail === 'full') return clamp(['', header, ...tree])
    const limit = COMMAND_GROUP_ROW_LIMIT
    if (tree.length <= limit) return clamp(['', header, ...tree])
    const hint = `... (${String(tree.length - (limit - 1))} more, ctrl+o to expand)`
    return clamp(['', header, ...tree.slice(0, limit - 1), this.colors.textMuted(cut(hint))])
  }

  private renderHeader(width: number): string {
    const { colors, components } = this
    const commands = this.model.commands
    const count = commands.length
    const pending = commands.filter(call => call.state === 'pending').length
    const failed = commands.filter(call => call.state === 'error').length
    const bold = (text: string): string => components.strong(String(text))
    const noun = count === 1 ? 'command' : 'commands'
    const label = pending > 0
      ? bold(colors.primary(`Running ${String(count)} ${noun}…`))
      : failed === count
        ? bold(colors.error(`Ran ${String(count)} ${noun} · failed`))
        : bold(colors.primary(`Ran ${String(count)} ${noun}`))
    let header = `${String(pending > 0 ? colors.text('● ') : failed === count ? colors.error('✗ ') : colors.success('✓ '))}${String(label)}`
    if (failed > 0 && failed < count) header += colors.error(` · ${String(failed)} failed`)
    return components.truncateToWidth(header, width)
  }

  private renderCommandRow(call: CommandCallModel, branch: string, deps: RenderDeps, cut: (row: string) => string): string {
    const command = sanitizePluginText(call.command).replace(/[\r\n]+/gu, ' ')
    if (call.state === 'error') {
      const error = call.error === undefined ? '' : ` ${deps.colors.error(sanitizePluginText(call.error).replace(/[\r\n]+/gu, ' '))}`
      return cut(`  ${String(branch)} ${command} ${deps.colors.error('✗')}${error}`)
    }
    if (call.state === 'pending') return cut(`  ${String(branch)} ${command} ${deps.colors.textMuted('…')}`)
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
      if ((this.expanded || this.detail() === 'full') && call.previewLines !== undefined) {
        for (const line of call.previewLines) {
          rows.push(cut(`  ${String(continuation)}${deps.colors.muted(sanitizePluginText(line).replace(/[\r\n]+/gu, ' '))}`))
        }
      }
    })
    return rows
  }
}
