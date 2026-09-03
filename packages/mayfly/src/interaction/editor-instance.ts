/**
 * Frontend-tree-scoped editor host. The service owns renderer references,
 * panel-slot replacement, enhancement presence, and submit transformations;
 * this module contains no product-level singleton state.
 *
 * @module @ephemeral-ai/mayfly/interaction/editor-instance
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { MayflyAutocompleteProvider, MayflyEditor } from '../core/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { mayflyPromptEditor: PromptEditorController }
  interface Events { 'mayfly/input-editor-changed'(): void }
}

/** The editor and callbacks published by `mayfly-input` while mounted. */
export interface SharedEditor {
  readonly editor: MayflyEditor
  readonly submitPrompt: (text: string) => void
  readonly abortPrompt?: () => void
  readonly notice?: (text: string) => void
}

/** Presence id of the optional editor-plus enhancement. */
export const ENHANCEMENT_EDITOR_PLUS = 'mayfly-editor-plus'

/** Per-frontend-tree editor host. */
export class PromptEditorController extends Service {
  private shared: SharedEditor | undefined
  private readonly enhancements = new Set<string>()
  private readonly editorStateListeners = new Set<() => void>()
  private readonly autocompleteSources = new Map<string, MayflyAutocompleteProvider>()

  constructor(ctx: Context) {
    super(ctx, 'mayflyPromptEditor')
  }

  get current(): SharedEditor | undefined { return this.shared }

  setCurrent(value: SharedEditor | undefined): void {
    this.shared = value
    this.emitEditorState()
  }

  markEnhancement(id: string): () => void {
    this.enhancements.add(id)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.enhancements.delete(id)
    }
  }

  hasEnhancement(id: string): boolean { return this.enhancements.has(id) }

  /** Observe editor and autocomplete-source changes. */
  subscribeEditorState(listener: () => void): () => void {
    this.editorStateListeners.add(listener)
    return () => { this.editorStateListeners.delete(listener) }
  }

  /** Register one Mayfly-owned completion source in stable insertion order. */
  registerAutocompleteSource(id: string, provider: MayflyAutocompleteProvider): () => void {
    if (this.autocompleteSources.has(id)) throw new Error(`editor autocomplete source "${id}" is already registered`)
    this.autocompleteSources.set(id, provider)
    this.emitEditorState()
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.autocompleteSources.delete(id)
      this.emitEditorState()
    }
  }

  /** Stable snapshot of Mayfly-owned completion sources. */
  listAutocompleteSources(): readonly MayflyAutocompleteProvider[] {
    return Object.freeze([...this.autocompleteSources.values()])
  }

  dispose(): void {
    this.shared = undefined
    this.enhancements.clear()
    this.autocompleteSources.clear()
    this.editorStateListeners.clear()
  }

  private emitEditorState(): void {
    for (const listener of this.editorStateListeners) listener()
  }
}

export const setSharedEditor = (ctx: Context, value: SharedEditor): void => { ctx.mayflyPromptEditor.setCurrent(value) }
export const clearSharedEditor = (ctx: Context): void => { ctx.mayflyPromptEditor.setCurrent(undefined) }
export const getSharedEditor = (ctx: Context): SharedEditor | undefined => ctx.get('mayflyPromptEditor')?.current
export const markEditorEnhancement = (ctx: Context, id: string): (() => void) => ctx.mayflyPromptEditor.markEnhancement(id)
export const hasEditorEnhancement = (ctx: Context, id: string): boolean => ctx.mayflyPromptEditor.hasEnhancement(id)
export const registerEditorAutocompleteSource = (ctx: Context, id: string, provider: MayflyAutocompleteProvider): (() => void) => ctx.mayflyPromptEditor.registerAutocompleteSource(id, provider)
