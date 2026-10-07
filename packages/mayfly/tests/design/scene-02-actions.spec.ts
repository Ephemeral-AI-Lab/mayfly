/**
 * Scene 2, Actions (roadmap slice 1.7): the actions row with a declared accelerator (`c`) and a hidden key with no
 * button (`Ctrl+Y copy link`). Every golden walk is compared cell by cell; the walks that wait for the visual language
 * of slice 1.2 are listed in `pending.ts` and must still differ. The key behavior of the walks is checked here now:
 * which key runs which action, and that the hint row names the effective keys.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { ui, type MayflyUiEvent } from '../../../ui/src/index.ts'
import { MayflyKeymapService } from '../../src/core/keymap.ts'
import { MayflyUiSurfaceRuntime, compileMayflyUiSurfaceNode } from '../../src/core/ui-compiler.ts'
import type { MayflyKeymap } from '../../src/core/types.ts'
import { INTERACTION_KEY_ACTIONS } from '../../src/interaction/keys.ts'
import { walks } from '../../../../script/design-golden-walks.mjs'
import { PROBE_PALETTE, compareCells, parityComponents, parseCells, readGoldenFrames } from './parity.ts'
import { PENDING_WALKS, pendingWalk } from './pending.ts'

/** The scene's node, as `ui-preview.mjs` builds it, with the real builders. */
function sceneNode() {
  return ui.surface({
    title: 'Edit provider', chrome: 'overlay', child: ui.stack.column([
      ui.text('Name: production · Endpoint: https://api.example.com/v1', { tone: 'muted' }),
      ui.spacer(),
      ui.actions({
        id: 'bar', items: [
          { id: 'save', label: 'Save', intent: 'primary' },
          { id: 'copy', label: 'Copy', key: 'c' },
          { id: 'delete', label: 'Delete provider', intent: 'danger', confirm: { title: 'Delete provider?', detail: 'Removes the stored credentials.', tone: 'danger' } },
          { id: 'archive', label: 'Archive', disabled: true, disabledReason: 'archive it first' },
          { id: 'copy-link', label: 'Copy link', key: 'ctrl+y', hidden: true, hintLabel: 'copy link' },
        ],
      }),
    ]),
  })
}

const runtimes: MayflyUiSurfaceRuntime[] = []
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.dispose() })

/** The scene compiled as a capturing overlay (Esc closes it) under the probe palette. */
function overlay(keymap?: MayflyKeymap) {
  const events: MayflyUiEvent[] = []
  const surfaceRuntime = new MayflyUiSurfaceRuntime()
  runtimes.push(surfaceRuntime)
  const result = compileMayflyUiSurfaceNode(sceneNode(), {
    components: parityComponents(),
    colors: PROBE_PALETTE,
    getViewport: () => ({ columns: 120, rows: 40 }),
    screenMode: 'alternate',
    emit: event => events.push(event),
    contextHints: { enabled: true },
    escapeHint: 'close',
    onUnhandledEscape: () => {},
    surfaceRuntime,
    ...(keymap === undefined ? {} : { keymap }),
  })
  if (!result.ok) throw new Error(result.message)
  const focus = result.value.focusTarget!
  focus.focused = true
  return {
    render: (width: number) => result.value.component.render(width),
    press: (key: string) => { focus.handleInput?.(key) },
    activated: () => events.flatMap(event => event.kind === 'activate' ? [event.actionId] : []),
    hint: (width: number) => result.value.component.render(width).at(-2) ?? '',
  }
}

const SCENE_WALKS = walks().filter(walk => walk.scene === 2)

describe('scene 2, Actions', () => {
  it('has a ledger entry only for walks the scene has', () => {
    expect(PENDING_WALKS.filter(entry => entry.scene === 2).every(entry => SCENE_WALKS.some(walk => walk.name === entry.walk))).toBe(true)
  })

  it.each(SCENE_WALKS.map(walk => [walk.name, walk] as const))('walk %s matches the prototype cell by cell, or is pending', async (_name, walk) => {
    const frames = readGoldenFrames(walk.dir, walk.name)
    const surface = overlay()
    let width = 78
    let differs = false
    for (const [index, step] of walk.steps.entries()) {
      // The scene's own keys change the demo, not the UI: `w` narrows the frame.
      if (step === 'w') width = 46
      else if (typeof step === 'string' && step !== '\0') surface.press(step)
      const expected = await parseCells(frames[index]!.rows.slice(3), 96, 'prototype')
      const actual = await parseCells(surface.render(width), 96, 'real')
      if (compareCells(expected, actual).length > 0) differs = true
    }
    expect(differs, pendingWalk(2, walk.name)?.reason ?? 'a matched walk').toBe(pendingWalk(2, walk.name) !== undefined)
  })

  it('runs the declared accelerator and the hidden key from anywhere on the surface, and arrows run nothing', () => {
    const surface = overlay()
    for (const key of ['\x1b[B', '\x1b[B', '\x1b[B', 'c', '\x19']) surface.press(key)
    expect(surface.activated()).toEqual(['copy', 'copy-link'])
  })

  it('names the effective keys in the hint row: Esc first to survive, then the primary operation and the accelerator', () => {
    const surface = overlay()
    const hint = surface.hint(78)
    expect(hint).toContain('Enter run')
    expect(hint).toContain('Esc close')
    expect(hint).not.toContain('Ctrl+Y')
    expect(surface.hint(100)).toContain('Ctrl+Y copy link')
  })

  it('keeps a plain accelerator on its own key when the common meaning of the same name is rebound', () => {
    const keymap = new MayflyKeymapService(new Context())
    keymap.register([...INTERACTION_KEY_ACTIONS])
    const surface = overlay(keymap)
    keymap.bind('ui.copy', 'y')
    surface.press('c')
    expect(surface.activated()).toEqual(['copy'])
  })
})
