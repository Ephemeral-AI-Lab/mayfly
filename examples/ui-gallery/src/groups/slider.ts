/**
 * The slider of the `/effort` panel, to run beside scene 23 of the design prototype: a discrete level selector with
 * captions over the ends of its track, a provider default that carries `(default)`, and a slider with no default. The
 * showcase pane's single handler answers `slider-accept` with a demo note.
 *
 * @module @mayfly-example/ui-gallery/groups/slider
 */
import { ui } from '@ephemeral-ai/mayfly-ui'

const levels = (...ids: string[]) => ids.map(id => ({ id, label: id }))

/** The gallery rows of the slider. */
export function sliderGroup() {
  return [
    ui.divider({ label: 'Slider' }),
    ui.text('←/→ steps, Home/End jump, Delete returns to the default, Enter confirms; the marker rests on the default until a level is pinned', { tone: 'muted' }),
    ui.slider({ id: 'gallery-effort', levels: levels('off', 'low', 'high', 'max'), inheritedId: 'high', startCaption: 'Faster', endCaption: 'Smarter' }),
    ui.text('no default known: no marker until the first ←/→', { tone: 'muted' }),
    ui.slider({ id: 'gallery-effort-plain', levels: levels('low', 'high'), selectedId: 'low' }),
  ]
}
