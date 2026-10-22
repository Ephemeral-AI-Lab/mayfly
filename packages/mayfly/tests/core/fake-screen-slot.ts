/** Stable named-slot fake shared by renderer-adjacent tests.
 * @module @ephemeral-ai/mayfly/tests/core/fake-screen-slot
 */
import type { MayflyComponent, MayflyFocusable, MayflyScreenSlot } from '../../src/core/index.ts'

export function mountFakeScreenSlot(
  id: string,
  initial: MayflyComponent | null,
  mount: (component: MayflyComponent) => () => void,
  setFocus: (component: MayflyComponent | null) => void,
  requestRender: () => void,
): MayflyScreenSlot {
  let target = initial
  let live = true
  let focused = false
  const shell: MayflyFocusable = {
    get focused() { return live && focused },
    set focused(value: boolean) {
      const current = target as MayflyFocusable | null
      if (current !== null && typeof current.focused === 'boolean') current.focused = false
      focused = live && value
      const next = target as MayflyFocusable | null
      if (next !== null && typeof next.focused === 'boolean') next.focused = focused
    },
    render: width => live ? target?.render(width) ?? [] : [],
    invalidate: () => { if (live) target?.invalidate() },
    handleInput: data => { if (live) target?.handleInput?.(data) },
  }
  const unmount = mount(shell)
  return {
    id,
    get disposed() { return !live },
    component: shell,
    replace(component) {
      if (!live) return
      const wasFocused = focused
      shell.focused = false
      target = component
      shell.focused = wasFocused
      requestRender()
    },
    focus() { if (live && target !== null) setFocus(shell) },
    dispose() {
      if (!live) return
      if (focused) setFocus(null)
      shell.focused = false
      live = false
      target = null
      unmount()
      requestRender()
    },
  }
}
