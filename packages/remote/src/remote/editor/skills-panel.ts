/**
 * Width-responsive official skill list/detail overlay.
 * @module @ephemeral-ai/mayfly/remote/editor/skills-panel
 */

import type {
  MayflyComponents,
  MayflyFocusable,
  MayflyOverlayHandle,
  MayflyScreen,
  MayflySemanticColors,
} from '@ephemeral-ai/mayfly/core'
import type { SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import type { MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import type { EditorSkills } from './skills.ts'
import { errorMessage } from './utils.ts'

interface SkillsPanelOptions {
  readonly skills: EditorSkills
  readonly screen: MayflyScreen
  readonly components: MayflyComponents
  readonly colors: MayflySemanticColors
  readonly t: MayflyTranslate
  readonly restoreFocus: () => void
}

class SkillsPanel implements MayflyFocusable {
  focused = false
  private selected = 0
  private detail = false
  private filtering = false
  private filter = ''

  constructor(
    private readonly options: SkillsPanelOptions,
    private readonly close: () => void,
    private readonly refresh: () => Promise<void>,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.filtering) {
      if (data === '\x1b' || data === '\r' || data === '\n') {
        this.filtering = false
        return
      }
      if (data === '\x7f' || data === '\b') {
        this.filter = this.filter.slice(0, -1)
        this.selected = 0
        return
      }
      if (data.length === 1 && data >= ' ' && data !== '\x7f') {
        this.filter += data
        this.selected = 0
        return
      }
    }
    if (data === '\x1b') {
      if (this.detail) this.detail = false
      else this.close()
      return
    }
    if (data === '\x03' || (!this.filtering && (data === 'q' || data === 'Q'))) {
      this.close()
      return
    }
    if (!this.filtering && data === '/') {
      this.filtering = true
      return
    }
    if (!this.filtering && (data === 'r' || data === 'R')) {
      void this.refresh()
      return
    }
    if (data === '\x1b[A') {
      this.selected = Math.max(0, this.selected - 1)
      return
    }
    if (data === '\x1b[B') {
      this.selected = Math.min(Math.max(0, this.rows().length - 1), this.selected + 1)
      return
    }
    if (data === '\r' || data === '\n' || data === '\x1b[C') {
      if (this.rows().length > 0) this.detail = !this.detail
      return
    }
    if (data === '\x1b[D') this.detail = false
  }

  render(width: number): string[] {
    const safe = Math.max(1, Math.floor(width))
    const snapshot = this.options.skills.snapshot()
    const rows = this.rows()
    this.selected = Math.min(this.selected, Math.max(0, rows.length - 1))
    const focused = rows[this.selected]
    const title = this.detail && focused !== undefined ? focused.name : this.options.t('Skills')
    const warning = snapshot.complete
      ? snapshot.error === undefined ? [] : [this.options.colors.warning(this.options.t('Skill catalog is incomplete; showing the last complete catalog'))]
      : [this.options.colors.warning(this.options.t('Skill catalog is incomplete; showing the last complete catalog'))]
    const heading = this.filtering || this.filter !== '' ? `/${this.filter}` : ''
    const body = rows.length === 0
      ? [this.options.colors.muted(this.options.t('No skills available'))]
      : this.detail && focused !== undefined
        ? this.detailRows(focused, safe)
        : this.listRows(rows, focused, safe)
    const hint = this.filtering
      ? 'Type filter · Enter/Esc done'
      : `${heading === '' ? '' : `${heading} · `}↑↓ select · Enter ${this.detail ? 'list' : 'detail'} · / filter · r refresh · Esc ${this.detail ? 'back' : 'close'}`
    return [
      this.options.components.truncateToWidth(this.options.colors.primary(title), safe),
      ...warning.map(line => this.options.components.truncateToWidth(line, safe)),
      ...body,
      this.options.components.truncateToWidth(this.options.colors.muted(hint), safe),
    ]
  }

  private rows(): readonly SkillEntry[] {
    const query = this.filter.toLocaleLowerCase()
    return this.options.skills.list()
      .filter(skill => query === '' || skill.name.toLocaleLowerCase().includes(query) || skill.description.toLocaleLowerCase().includes(query))
      .toSorted((left, right) => left.name.localeCompare(right.name))
  }

  private listRows(rows: readonly SkillEntry[], focused: SkillEntry | undefined, width: number): string[] {
    const wide = width >= 64 && focused !== undefined
    const listWidth = wide ? Math.max(24, Math.floor(width * 0.42)) : width
    const lines = rows.slice(Math.max(0, this.selected - 11), Math.max(0, this.selected - 11) + 12).map((skill) => {
      const selected = skill === focused
      const badge = skill.modelInvocable ? '' : ` [${this.options.t('user-only')}]`
      const text = `${selected ? '> ' : '  '}${skill.name}${badge} — ${skill.description}`
      const line = this.options.components.truncateToWidth(text, listWidth)
      return selected ? this.options.colors.accent(line) : line
    })
    if (!wide || focused === undefined) return lines
    const detail = this.detailRows(focused, width - listWidth - 2)
    const height = Math.max(lines.length, detail.length)
    return Array.from({ length: height }, (_, index) => {
      const left = lines[index] ?? ''
      const right = detail[index] ?? ''
      const padding = Math.max(0, listWidth - this.options.components.visibleWidth(left))
      return this.options.components.truncateToWidth(`${left}${' '.repeat(padding)}  ${right}`, width)
    })
  }

  private detailRows(skill: SkillEntry, width: number): string[] {
    const text = [
      skill.description,
      ...skill.whenToUse === undefined ? [] : ['', skill.whenToUse],
      '',
      `${this.options.t('Invocation')}: ${skill.modelInvocable ? 'model + user' : this.options.t('user-only')}`,
      ...skill.path === undefined ? [] : [`${this.options.t('Path')}: ${skill.path}`],
    ]
    return text.flatMap(line => line === ''
      ? ['']
      : this.options.components.wrapText(line, Math.max(1, width)).map(row => this.options.colors.muted(row)))
  }
}

/** Owns one skill overlay and refreshes it on every open and explicit refresh. */
export class EditorSkillsPanel {
  private handle: MayflyOverlayHandle | undefined
  private generation = 0

  constructor(private readonly options: SkillsPanelOptions) {}

  get open(): boolean { return this.handle !== undefined }

  async show(): Promise<void> {
    const generation = ++this.generation
    this.handle?.hide()
    this.handle = undefined
    await this.options.skills.refresh()
    if (generation !== this.generation) return
    const close = (): void => {
      if (generation !== this.generation) return
      this.handle?.hide()
      this.handle = undefined
      this.options.restoreFocus()
    }
    const refresh = async (): Promise<void> => {
      try {
        await this.options.skills.refresh()
      } catch (error) {
        if (generation === this.generation) throw new Error(errorMessage(error, 'skill refresh failed'))
      }
      if (generation === this.generation) this.options.screen.requestRender()
    }
    const panel = new SkillsPanel(this.options, close, refresh)
    this.handle = this.options.screen.showOverlay(panel, { width: '85%', maxHeight: '75%' })
    this.options.screen.requestRender()
  }

  close(): void {
    this.generation += 1
    this.handle?.hide()
    this.handle = undefined
  }
}
