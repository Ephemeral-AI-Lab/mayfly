/**
 * Composition spike: the `/model` and `/effort` pickers as pure components, the way roadmap Phase 2a prescribes
 * (`defineMayflyComponent` from plain facts plus a translator to `ui.*` nodes). It imports only
 * `@ephemeral-ai/mayfly-ui`, reads no width, paints nothing, and sees no key. It lives under `tests/` because
 * Phase 2a creates `src/components/`; nothing in the product imports it.
 *
 * @module tests/design/spike/model-picker
 */

import { defineMayflyComponent, ui, type MayflyListItem, type MayflyListSegment } from '@ephemeral-ai/mayfly-ui'

/**
 * The translator the commands hand a component (`interactionTranslator`, a `MayflyTranslate`): an English key with
 * `{name}` placeholders in, catalog text out. It is declared here because a component may not import `frontend/`.
 */
export type Translate = (key: string, values?: Readonly<Record<string, string | number>>) => string

/** One catalog row, the shape of `ModelPickerItem` in `interaction/model-picker-model.ts`. */
export interface ModelFact {
  readonly provider: string
  readonly providerLabel: string
  readonly id: string
  readonly name: string
  readonly contextWindow?: number | undefined
  readonly efforts?: readonly string[] | undefined
  readonly defaultEffort?: string | undefined
}

/** The session's model selection, the shape of `currentModelSelection` (`reasoningEffort` absent means unpinned). */
export interface SelectionFact {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string | undefined
}

export interface ModelPickerProps {
  readonly models: readonly ModelFact[]
  readonly current: SelectionFact | undefined
  readonly t: Translate
}

export interface EffortPickerProps {
  /** The surface title: `Provider Name/model`. */
  readonly title: string
  readonly levels: readonly string[]
  readonly defaultLevel?: string | undefined
  readonly current: SelectionFact | undefined
  readonly t: Translate
}

/** `formatContextWindow` of `interaction/model-picker-model.ts`, copied: a component may not import `interaction/`. */
export function formatContextWindow(tokens: number): string {
  if (tokens < 1024) return `${tokens}`
  const units = ['k', 'm', 'g']
  let value = tokens
  let unit = -1
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  const text = Number.isInteger(value) || value >= 10 ? `${Math.round(value)}` : value.toFixed(1)
  return `${text}${units[unit]}`
}

/** The row id the commit path maps back to a catalog row. */
export const modelRowId = (provider: string, id: string): string => JSON.stringify([provider, id])

function strip(model: ModelFact, pinned: string | undefined, t: Translate): MayflyListSegment {
  return {
    label: t('Thinking'),
    options: model.efforts!.map(id => ({ id, label: id })),
    ...(pinned === undefined ? {} : { selectedId: pinned }),
    ...(model.defaultEffort === undefined ? {} : { inheritedId: model.defaultEffort }),
  }
}

function row(model: ModelFact, current: SelectionFact | undefined, t: Translate): MayflyListItem {
  const live = current !== undefined && current.provider === model.provider && current.model === model.id
  // An effort the model does not list cannot be pinned on its strip, so the row reads as unpinned.
  const pinned = live && current.reasoningEffort !== undefined && model.efforts?.includes(current.reasoningEffort) === true ? current.reasoningEffort : undefined
  return {
    id: modelRowId(model.provider, model.id),
    label: `${model.providerLabel}/${model.name}`,
    group: model.providerLabel,
    ...(model.contextWindow === undefined ? {} : { detail: t('{size} context', { size: formatContextWindow(model.contextWindow) }) }),
    ...(live ? { badge: current.reasoningEffort === undefined ? t('current') : t('current · {effort}', { effort: current.reasoningEffort }) } : {}),
    ...(model.efforts === undefined || model.efforts.length === 0 ? {} : { segment: strip(model, pinned, t) }),
  }
}

/** `/model`: a filterable browse list grouped by provider, a thinking strip on each row that has efforts. */
export const ModelPicker = defineMayflyComponent<ModelPickerProps>({
  id: 'mayfly.model-picker',
  memo: true,
  render: ({ models, current, t }) => ui.surface({
    title: t('Select a model'),
    chrome: 'overlay',
    child: ui.list({
      id: 'selection',
      role: 'browse',
      filterable: true,
      acceptVerb: 'choose',
      selectedIds: [],
      // `empty` is for an empty catalog; a filter that matches nothing is core's own `No matches` row.
      empty: ui.empty({ title: t('No models advertised') }),
      items: models.map(model => row(model, current, t)),
    }),
  }),
})

/** `/effort`: a numbered choose list with the provider default first. */
export const EffortPicker = defineMayflyComponent<EffortPickerProps>({
  id: 'mayfly.effort-picker',
  memo: true,
  render: ({ title, levels, defaultLevel, current, t }) => {
    const active = current?.reasoningEffort ?? 'default'
    const mark = (id: string): Pick<MayflyListItem, 'badge'> | Record<string, never> => (active === id ? { badge: t('current') } : {})
    return ui.surface({
      title,
      chrome: 'overlay',
      child: ui.list({
        id: 'effort',
        role: 'choose',
        numbered: true,
        selectedIds: [],
        items: [
          { id: 'default', label: defaultLevel === undefined ? t('Provider default') : t('Provider default ({level})', { level: defaultLevel }), ...mark('default') },
          ...levels.map(level => ({ id: level, label: level, ...mark(level) })),
        ],
      }),
    })
  },
})
