import { MayflyUiSurfaceRuntime, compileMayflyUiSurfaceNode } from '../../src/core/ui-compiler.ts'
import type { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import type { MayflyComponents, MayflyMarkdownOptions } from '../../src/core/types.ts'
import { visibleWidth, truncateToWidth, wrapTextWithAnsi } from '../../src/core/width.ts'
import { createFakeEditor } from '../core/fake-editor.ts'
import { FakeMayflyMarkdown } from './fakes.ts'
import { plainColors } from '../helpers.ts'

const colors = plainColors()
const components = { createEditor: createFakeEditor, createMarkdown: (options: MayflyMarkdownOptions) => new FakeMayflyMarkdown(options), visibleWidth, truncateToWidth, wrapText: wrapTextWithAnsi } as unknown as MayflyComponents
export const flushRequests = () => new Promise<void>(resolve => { setImmediate(resolve) })

export function renderRequest(
  model: UiSurfaceModel,
  viewport = { columns: 80, rows: 24 },
  runtime = new MayflyUiSurfaceRuntime(model),
) {
  const result = compileMayflyUiSurfaceNode(model.decisionNode ?? model.node, {
    surfaceRuntime: runtime, components, colors, screenMode: 'alternate', getViewport: () => viewport,
    emit: event => model.emit(event), onUnhandledEscape: () => model.requestClose(),
  })
  if (!result.ok) throw new Error(result.message)
  // A surface without controls (a decision card's hidden actions) has no
  // focus target; its component still holds the keys, as the renderer routes
  // them while the overlay is focused.
  const inputTarget = (result.value.focusTarget ?? result.value.component) as { handleInput?(data: string): void, focused?: boolean }
  if ('focused' in inputTarget) inputTarget.focused = true
  return { runtime, ...result.value, input: (data: string) => { inputTarget.handleInput?.(data) } }
}
