/**
 * Registry-aware Remote footer with existing Session facts and canonical status admission.
 * @module @ephemeral-ai/mayfly/remote/status/footer
 */

import { shortenCwd } from '@ephemeral-ai/mayfly/status-cwd'
import { contextPercent, formatTokens } from '@ephemeral-ai/mayfly/status-context'
import {
  compileMayflyStatusNode,
  type MayflyComponent,
  type MayflyComponents,
  type MayflyScreenService,
  type MayflySemanticColors,
  type MayflyStatusComponent,
} from '@ephemeral-ai/mayfly/core'
import { ui, type MayflyStatusEntry, type MayflyUiChild, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { Context } from '@deepseek-ai/cordis'
import type { RemotePresentationFacts } from '../../transcript/remote-model.ts'

/** Entered-view state used to underline its summary. */
export interface RemoteStatusFooterState {
  readonly active?: string | undefined
}

function childOf(entry: MayflyStatusEntry, active: string | undefined): MayflyUiChild {
  const { definition } = entry
  return ui.child(entry.node!, {
    id: entry.id,
    priority: definition.priority ?? 0,
    band: definition.band ?? 'left',
    ...definition.overflow === undefined ? {} : { overflow: definition.overflow },
    ...entry.id === active ? { mark: 'underline' as const } : {},
  })
}

/** Build one canonical status row from registry and views entries. */
export function buildRemoteStatusFooter(entries: readonly MayflyStatusEntry[], state: RemoteStatusFooterState = {}): MayflyUiNode | null {
  const shown = entries.filter(entry => entry.node !== null)
    .toSorted((left, right) => (left.definition.priority ?? 0) - (right.definition.priority ?? 0) || left.id.localeCompare(right.id))
  if (shown.length === 0) return null
  return ui.surface({ chrome: 'none', padding: 1, child: ui.stack.row(shown.map(entry => childOf(entry, state.active))) })
}

function factEntries(current: RemotePresentationFacts): readonly MayflyStatusEntry[] {
  const model = current.ref === undefined ? '' : current.model ?? 'default'
  const cwd = shortenCwd(current.cwd, '')
  const context = current.contextTokens <= 0
    ? ''
    : current.contextWindow === undefined
      ? `ctx ${formatTokens(current.contextTokens)}`
      : `context: ${String(contextPercent(current.contextTokens, current.contextWindow))}% (${formatTokens(current.contextTokens)}/${formatTokens(current.contextWindow)})`
  return [
    { id: 'remote.facts', definition: { id: 'remote.facts', priority: 0, band: 'left', overflow: 'truncate' }, revision: 0, node: model === '' && cwd === ''
      ? null
      : ui.richText([
          ...model === '' ? [] : [{ text: model }],
          ...model === '' || cwd === '' ? [] : [{ text: '  ' }],
          ...cwd === '' ? [] : [{ text: cwd, tone: 'muted' as const }],
        ]) },
    { id: 'remote.context', definition: { id: 'remote.context', priority: 6, band: 'right', overflow: 'hide' }, revision: 0, node: context === '' ? null : ui.text(context) },
    { id: 'remote.title', definition: { id: 'remote.title', priority: 20, band: 'right', overflow: 'truncate' }, revision: 0, node: current.title === undefined ? null : ui.text(current.title, { tone: 'muted' }) },
  ]
}

/** Footer component ready for the foundation to install in place of its facts-only implementation. */
export class RemoteRegistryStatusComponent implements MayflyComponent {
  private readonly offStatus: () => void
  private readonly offViews: () => void
  private base: { readonly key: string, readonly component: MayflyStatusComponent } | undefined
  private registry: { readonly key: string, readonly component: MayflyStatusComponent } | undefined
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly screen: MayflyScreenService,
    private readonly components: MayflyComponents,
    private readonly colors: MayflySemanticColors,
    private readonly facts: () => RemotePresentationFacts,
  ) {
    const request = (): void => {
      if (!this.disposed) this.screen.requestRender()
    }
    this.offStatus = this.ctx.mayflyStatus.subscribe(request)
    this.offViews = this.screen.views.subscribe(request)
  }

  /** Render existing Session facts and every registered productivity summary within the width budget. */
  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width))
    const current = this.facts()
    const baseNode = buildRemoteStatusFooter(factEntries(current))
    const entries = [...this.ctx.mayflyStatus.list(), ...this.screen.views.statusEntries()]
    const active = this.screen.views.isEntered && this.screen.views.active !== undefined ? `views/${this.screen.views.active}` : undefined
    const registryNode = buildRemoteStatusFooter(entries, { active })
    return [
      ...this.row('base', baseNode, safeWidth),
      ...this.row('registry', registryNode, safeWidth),
    ]
  }

  /** Recompile only changed rows and invalidate retained status components. */
  invalidate(): void {
    this.base?.component.invalidate()
    this.registry?.component.invalidate()
  }

  /** Release registry listeners and retained components. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.offStatus()
    this.offViews()
    this.base = undefined
    this.registry = undefined
  }

  private row(kind: 'base' | 'registry', node: MayflyUiNode | null, width: number): string[] {
    const previous = this[kind]
    if (node === null) {
      this[kind] = undefined
      return []
    }
    const key = `${String(width)}|${JSON.stringify(node)}`
    if (previous?.key !== key) {
      const compiled = compileMayflyStatusNode(node, {
        components: this.components,
        colors: this.colors,
        getViewport: () => ({ columns: width, rows: 1 }),
        screenMode: 'alternate',
        maxRows: 1,
      })
      this[kind] = { key, component: compiled.ok ? compiled.value.component : compiled.errorComponent }
    }
    return this[kind]!.component.render(width)
  }
}
