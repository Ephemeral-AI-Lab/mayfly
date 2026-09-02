/**
 * Compatibility mount helper for flexible bottom-dock components.
 *
 * @module @ephemeral-ai/mayfly/core/dock
 */

import type { MayflyComponent, MayflyDockOptions, MayflyScreen } from './types.ts'

/**
 * Mount a flexible pane through the shared dock allocator when the screen
 * supports it, falling back to the legacy bottom mount for structural fakes
 * and older renderer adapters.
 * @param screen - target screen service.
 * @param component - flexible pane component.
 * @param options - row-allocation metadata.
 * @returns the screen-owned unmount disposer.
 */
export function mountDockChild(
  screen: MayflyScreen,
  component: MayflyComponent,
  options?: MayflyDockOptions,
): () => void {
  return screen.addDockChild?.(component, options) ?? screen.addBottomChild(component)
}
