/** Frontend-only renderer services and input bindings for extension tests. @module */
import { Context } from '@deepseek-ai/cordis'
import { MayflyEditorExtensionService } from '../../../ui/src/services.ts'
import { FakeScreen, FakeTheme, FakeKeymap, FakeMayflyComponents } from '../interaction/fakes.ts'
import type { MayflyAutocompleteProvider } from '../../src/core/types.ts'
import type { EditorExtensionRuntimeBindings } from '../../src/frontend/editor-extension-runtime.ts'

const sources = new WeakMap<Context, Map<string, MayflyAutocompleteProvider>>()
const listeners = new WeakMap<Context, Set<() => void>>()

export function editorContext() {
  const ctx = new Context()
  const screen = new FakeScreen()
  const theme = new FakeTheme()
  const keymap = new FakeKeymap()
  const components = new FakeMayflyComponents()
  ctx.provide('mayflyScreen', screen as never)
  ctx.provide('mayflyTheme', theme)
  ctx.provide('mayflyKeymap', keymap as never)
  ctx.provide('mayflyComponents', components as never)
  new MayflyEditorExtensionService(ctx)
  sources.set(ctx, new Map())
  listeners.set(ctx, new Set())
  return { ctx, screen, theme, keymap, components }
}

export function inputBindings(ctx: Context, shouldTransformSubmit = () => true): EditorExtensionRuntimeBindings {
  return {
    autocomplete: { sources: () => [...sources.get(ctx)!.values()], subscribe: listener => {
      listeners.get(ctx)!.add(listener)
      return () => { listeners.get(ctx)!.delete(listener) }
    } },
    beginWait: () => () => {},
    captureSubmit: source => ({ text: source, attachments: Object.freeze([]), prepare: text => ({ text }) }),
    shouldTransformSubmit,
  }
}

export function registerSource(ctx: Context, id: string, provider: MayflyAutocompleteProvider): () => void {
  sources.get(ctx)!.set(id, provider)
  for (const listener of listeners.get(ctx)!) listener()
  return () => {
    sources.get(ctx)!.delete(id)
    for (const listener of listeners.get(ctx)!) listener()
  }
}
