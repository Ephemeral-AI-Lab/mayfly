/**
 * The frontend model of a `slider` node: the level it pins. Like the prompt, form, and choice models it is immutable and
 * reduced by intents, so a republish, a theme swap, or a core reload keeps what the user chose. The surface model owns
 * one per slider and turns the effect a reduction returns into the `slider-accept` event the host sees.
 *
 * The pinned level and the inherited level follow the segment strip's rules: while nothing is pinned the slider rests on
 * the inherited level (when it has one), stepping onto the inherited level unpins, a slider with nothing to rest on
 * starts from the edge the arrow points into, and the ends clamp.
 *
 * @module @ephemeral-ai/mayfly/core/ui-interaction-slider
 */
import type { MayflySliderLevel, MayflySliderNode } from '@ephemeral-ai/mayfly-ui'
import type { UiControlAddress } from './ui-interaction-tree.ts'

/** The immutable state of one slider. */
export interface UiSliderModel {
  readonly address: UiControlAddress
  readonly definition: MayflySliderNode
  /** The level the user pinned, or `null` while the slider follows its inherited level (or has none). */
  readonly pinned: string | null
  /** Counts the changes to `pinned`. */
  readonly revision: number
}

export type UiSliderIntent =
  | { readonly kind: 'step', readonly delta: -1 | 1 }
  /** `Home` or `End`: the first or last level that can be chosen. */
  | { readonly kind: 'edge', readonly end: 'start' | 'end' }
  /** `Delete`: back to the inherited level. */
  | { readonly kind: 'unpin' }
  | { readonly kind: 'accept' }

/** What a reduction asks the surface model to tell the host. */
export type UiSliderEffect = { readonly kind: 'accept', readonly value: string | null }

const enabled = (definition: MayflySliderNode): readonly MayflySliderLevel[] => definition.levels.filter(level => level.disabled !== true)

/** A seeded or kept level is pinned only while it is still one of the levels that can be chosen. */
function pinnable(definition: MayflySliderNode, id: string | undefined | null): string | null {
  return id !== undefined && id !== null && enabled(definition).some(level => level.id === id) ? id : null
}

export function createSliderModel(address: UiControlAddress, definition: MayflySliderNode): UiSliderModel {
  return { address, definition, pinned: pinnable(definition, definition.selectedId), revision: 0 }
}

/** The model for a republished definition: the pinned level survives while it is still a level that can be chosen. */
export function reconcileSlider(previous: UiSliderModel, definition: MayflySliderNode): UiSliderModel {
  if (previous.definition === definition) return previous
  const kept = pinnable(definition, previous.pinned)
  // A republish that names another seed replaces the pin; one that keeps the seed keeps what the user chose.
  const pinned = previous.definition.selectedId !== definition.selectedId ? pinnable(definition, definition.selectedId) : kept
  return { ...previous, definition, pinned, revision: pinned === previous.pinned ? previous.revision : previous.revision + 1 }
}

/** The level the slider shows: the pinned one, else the inherited one; `undefined` when it rests on nothing. */
export function sliderActive(model: UiSliderModel): string | undefined {
  return model.pinned ?? model.definition.inheritedId
}

/** What `←` and `→` can still do from the level on show, and whether `Delete` has a pin to drop. */
export function sliderGrammar(model: UiSliderModel): { readonly stuckLeft: boolean, readonly stuckRight: boolean, readonly unpin: boolean, readonly adjustable: boolean } {
  const choices = enabled(model.definition)
  const position = choices.findIndex(level => level.id === sliderActive(model))
  return {
    adjustable: choices.length > 1,
    stuckLeft: choices.length < 2 || position === 0,
    stuckRight: choices.length < 2 || position === choices.length - 1,
    unpin: model.pinned !== null && model.definition.inheritedId !== undefined,
  }
}

function moved(model: UiSliderModel, id: string): UiSliderModel {
  // Stepping onto the inherited level is unpinning.
  const pinned = id === model.definition.inheritedId ? null : id
  return pinned === model.pinned ? model : { ...model, pinned, revision: model.revision + 1 }
}

/** Reduce one intent; a reduction that changes nothing returns the same model and no effects. */
export function reduceSlider(model: UiSliderModel, intent: UiSliderIntent): { readonly model: UiSliderModel, readonly effects: readonly UiSliderEffect[] } {
  const none = { model, effects: [] as const }
  if (intent.kind === 'accept') return { model, effects: [{ kind: 'accept', value: model.pinned }] }
  if (intent.kind === 'unpin') {
    if (model.pinned === null || model.definition.inheritedId === undefined) return none
    return { model: { ...model, pinned: null, revision: model.revision + 1 }, effects: [] }
  }
  const choices = enabled(model.definition)
  if (choices.length < 2) return none
  const current = sliderActive(model)
  let target: MayflySliderLevel
  if (intent.kind === 'edge') target = intent.end === 'start' ? choices[0]! : choices.at(-1)!
  else {
    const position = choices.findIndex(level => level.id === current)
    // A slider resting on nothing starts from the edge the arrow points into; the ends clamp.
    target = position < 0 ? (intent.delta > 0 ? choices[0]! : choices.at(-1)!) : choices[Math.max(0, Math.min(choices.length - 1, position + intent.delta))]!
  }
  if (target.id === current) return none
  return { model: moved(model, target.id), effects: [] }
}
