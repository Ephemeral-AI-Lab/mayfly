/**
 * Small Remote-owned menu and draft-form components for the feature-neutral
 * overlay lease host. Drafts remain in the component across data republishes.
 * @module @ephemeral-ai/mayfly/remote/features/panel
 */

import type {
  MayflyComponents,
  MayflyFocusable,
  MayflySemanticColors,
} from '@ephemeral-ai/mayfly/core'
import type { RemoteFeatureContext, RemoteFeatureOverlayLease } from './contracts.ts'

/** One selectable menu row. */
export interface RemotePanelRow {
  readonly id?: string | undefined
  readonly text: string
  readonly detail?: string | undefined
  readonly current?: boolean | undefined
  readonly disabled?: boolean | undefined
}

/** One draft form field; secret values are write-only and masked. */
export interface RemotePanelField {
  readonly id: string
  readonly label: string
  readonly kind: 'input' | 'secret' | 'select' | 'toggle'
  readonly value?: string | undefined
  readonly options?: readonly { readonly id: string, readonly label: string }[] | undefined
  readonly placeholder?: string | undefined
  readonly disabled?: boolean | undefined
}

/** Complete plain component model. */
export interface RemotePanelModel {
  readonly title: string
  readonly subtitle?: string | undefined
  readonly rows?: readonly RemotePanelRow[] | undefined
  readonly fields?: readonly RemotePanelField[] | undefined
  readonly hint?: string | undefined
  readonly footer?: string | undefined
}

/** Actions emitted by a Remote panel. Values are operation-local and never logged here. */
export type RemotePanelAction = (
  action: 'accept' | 'submit' | 'refresh' | 'delete' | 'copy' | 'manual' | 'previous' | 'next' | 'cancel',
  id: string | undefined,
  values: Readonly<Record<string, string>>,
) => void

const MAX_ROWS = 12

/** Keyboard-operable list/form with controller-owned facts and component-owned drafts. */
export class RemoteFeaturePanel implements MayflyFocusable {
  focused = false
  private selected = 0
  private scrollTop = 0
  private model: RemotePanelModel
  private readonly drafts = new Map<string, string>()

  constructor(
    initial: RemotePanelModel,
    private readonly components: MayflyComponents,
    private readonly colors: MayflySemanticColors,
    private readonly close: () => void,
    private readonly action: RemotePanelAction,
    private readonly changed: () => void,
  ) {
    this.model = initial
    for (const field of initial.fields ?? []) this.drafts.set(field.id, field.value ?? '')
    const current = initial.rows?.findIndex(row => row.current === true && row.id !== undefined && row.disabled !== true) ?? -1
    if (current >= 0) this.selected = current
  }

  /** Replace facts while preserving every draft and the focused row. */
  update(model: RemotePanelModel): void {
    this.model = model
    for (const field of model.fields ?? []) if (!this.drafts.has(field.id)) this.drafts.set(field.id, field.value ?? '')
    this.changed()
  }

  /** Current form values, passed directly to an explicit operation. */
  values(): Readonly<Record<string, string>> {
    return Object.fromEntries(this.drafts)
  }

  handleInput(data: string): void {
    if (data === '\x1b' || data === '\x03') { this.action('cancel', undefined, this.values()); this.close(); return }
    if (data === '\x12') { this.action('refresh', undefined, this.values()); return }
    if (data === '\x18') { this.action('delete', this.currentId(), this.values()); return }
    if (data === '\x19') { this.action('copy', this.currentId(), this.values()); return }
    if (data === 'p' && this.model.fields === undefined) { this.action('manual', this.currentId(), this.values()); return }
    if (this.model.fields !== undefined) { this.handleFormInput(data); return }
    if (data === '\x1b[D') { this.action('previous', this.currentId(), this.values()); return }
    if (data === '\x1b[C') { this.action('next', this.currentId(), this.values()); return }
    if (data === '\x1b[A' || data === '\x1b[Z') { this.move(-1); return }
    if (data === '\x1b[B' || data === '\t') { this.move(1); return }
    if (data === '\r' || data === '\n') this.action('accept', this.currentId(), this.values())
  }

  invalidate(): void {}

  render(width: number): string[] {
    const rows = this.model.fields === undefined ? this.listRows(width) : this.formRows(width)
    const title = this.colors.primary(this.model.title)
    const subtitle = this.model.subtitle === undefined ? [] : [this.colors.muted(this.model.subtitle)]
    const footer = this.model.footer === undefined ? [] : this.model.footer.split('\n').map(line => this.colors.muted(line))
    const hint = this.model.hint ?? (this.model.fields === undefined ? '↑↓ select · Enter open · Esc close' : '↑↓ fields · Tab/Enter next · Ctrl+R action · Esc close')
    return [
      this.components.truncateToWidth(title, width),
      ...subtitle.map(line => this.components.truncateToWidth(line, width)),
      ...rows,
      ...footer.map(line => this.components.truncateToWidth(line, width)),
      this.components.truncateToWidth(this.colors.muted(hint), width),
    ]
  }

  private listRows(width: number): string[] {
    const rows = this.model.rows ?? []
    const visible = rows.slice(this.scrollTop, this.scrollTop + MAX_ROWS)
    const lines = visible.flatMap((row, index) => {
      const position = this.scrollTop + index
      const selected = row.id !== undefined && row.disabled !== true && position === this.selected
      const prefix = selected ? '> ' : row.current === true ? '* ' : '  '
      const text = `${prefix}${row.text}`
      const painted = row.disabled === true ? this.colors.muted(text) : selected ? this.colors.accent(text) : row.current === true ? this.colors.primary(text) : text
      return [
        this.components.truncateToWidth(painted, width),
        ...row.detail === undefined ? [] : [this.components.truncateToWidth(this.colors.muted(`  ${row.detail}`), width)],
      ]
    })
    if (rows.length === 0) lines.push(this.colors.muted('  —'))
    if (rows.length > MAX_ROWS) lines.push(this.colors.muted(`  ${this.scrollTop + 1}-${Math.min(rows.length, this.scrollTop + MAX_ROWS)}/${rows.length}`))
    return lines
  }

  private formRows(width: number): string[] {
    const fields = this.model.fields ?? []
    if (this.selected >= fields.length) this.selected = Math.max(0, fields.length - 1)
    return fields.map((field, index) => {
      const selected = index === this.selected
      const value = this.drafts.get(field.id) ?? ''
      const shown = field.kind === 'secret' && value.length > 0 ? '•'.repeat(Math.min(12, value.length))
        : field.kind === 'toggle' ? value === 'true' ? 'on' : 'off'
          : field.kind === 'select' ? field.options?.find(option => option.id === value)?.label ?? value
            : value || field.placeholder || ''
      const line = `${selected ? '> ' : '  '}${field.label}: ${shown}`
      const painted = field.disabled === true || value.length === 0 && field.placeholder !== undefined ? this.colors.muted(line) : selected ? this.colors.accent(line) : line
      return this.components.truncateToWidth(painted, width)
    })
  }

  private handleFormInput(data: string): void {
    const fields = this.model.fields ?? []
    const field = fields[this.selected]
    if (field === undefined) return
    if (data === '\x1b[A' || data === '\x1b[Z') { this.moveField(-1); return }
    if (data === '\x1b[B' || data === '\t') { this.moveField(1); return }
    if (data === '\r' || data === '\n') {
      if (this.selected === fields.length - 1) this.action('submit', field.id, this.values())
      else this.moveField(1)
      return
    }
    if (field.disabled === true) return
    if (field.kind === 'select' || field.kind === 'toggle') {
      if (!['\x1b[C', '\x1b[D', ' ', '\r'].includes(data)) return
      const options = field.kind === 'toggle'
        ? [{ id: 'false', label: 'off' }, { id: 'true', label: 'on' }]
        : field.options ?? []
      if (options.length === 0) return
      const current = options.findIndex(option => option.id === this.drafts.get(field.id))
      const direction = data === '\x1b[D' ? -1 : 1
      const next = options[(Math.max(0, current) + direction + options.length) % options.length]!
      this.drafts.set(field.id, next.id)
      this.action('accept', field.id, this.values())
      this.changed()
      return
    }
    if (data === '\x7f' || data === '\b') {
      const value = this.drafts.get(field.id) ?? ''
      this.drafts.set(field.id, [...value].slice(0, -1).join(''))
      this.changed()
      return
    }
    if (data === '\x15') { this.drafts.set(field.id, ''); this.changed(); return }
    if (data.length > 0 && !data.startsWith('\x1b') && !/[\x00-\x1f\x7f]/u.test(data)) {
      this.drafts.set(field.id, `${this.drafts.get(field.id) ?? ''}${data}`)
      this.changed()
    }
  }

  private currentId(): string | undefined {
    if (this.model.fields !== undefined) return this.model.fields[this.selected]?.id
    return this.model.rows?.[this.selected]?.id
  }

  private move(delta: number): void {
    const selectable = (this.model.rows ?? []).map((row, index) => row.id !== undefined && row.disabled !== true ? index : -1).filter(index => index >= 0)
    if (selectable.length === 0) return
    const position = selectable.indexOf(this.selected)
    this.selected = selectable[(Math.max(0, position) + delta + selectable.length) % selectable.length]!
    if (this.selected < this.scrollTop) this.scrollTop = this.selected
    if (this.selected >= this.scrollTop + MAX_ROWS) this.scrollTop = this.selected - MAX_ROWS + 1
    this.changed()
  }

  private moveField(delta: number): void {
    const count = this.model.fields?.length ?? 0
    if (count === 0) return
    this.selected = (this.selected + delta + count) % count
    this.changed()
  }
}

/** One mounted plain panel and its feature-neutral lease. */
export interface RemoteMountedPanel {
  readonly panel: RemoteFeaturePanel
  readonly lease: RemoteFeatureOverlayLease
}

/** Open a plain panel through the foundation lease host. */
export function openRemoteFeaturePanel(
  context: RemoteFeatureContext,
  model: RemotePanelModel,
  action: RemotePanelAction,
  onClosed: () => void,
): RemoteMountedPanel {
  let lease!: RemoteFeatureOverlayLease
  const panel = new RemoteFeaturePanel(
    model,
    context.components,
    context.colors,
    () => { lease.close() },
    action,
    () => { context.screen.requestRender() },
  )
  lease = context.overlays.open(panel, { onClosed })
  return { panel, lease }
}
