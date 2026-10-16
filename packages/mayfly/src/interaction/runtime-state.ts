/**
 * Frontend-tree-owned mutable state shared by interaction child Fibers.
 * Theme swaps rebuild renderer-dependent children while this parent service
 * survives, so drafts and registries remain available without crossing into
 * another Cordis tree or process-wide module state.
 *
 * @module @ephemeral-ai/mayfly/interaction/runtime-state
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { CommandAliasRegistry } from './command-meta.ts'
import { DraftStash } from './draft-stash.ts'
import { SessionlessCommandRegistry } from './sessionless-commands.ts'
import type { FdProbeRuntimeState } from './file-mention.ts'
import type { ModelsDevIndex } from './models-dev.ts'
import type { PromptWaits } from './prompt-wait.ts'
import type { MayflySettings } from './settings.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { mayflyInteractionState: InteractionStateService }
}

/** Mutable state for clipboard-image paste within one frontend tree. */
interface PasteImageRuntimeState {
  backendOverride: 'auto' | 'wayland' | 'x11' | undefined
  readonly backendCooldowns: Map<string, number>
  readonly pastedImages: Map<string, ImageAttachmentRef>
  pasteCount: number
}

/** Mutable interaction state whose lifetime is the parent frontend tree. */
export class InteractionStateService extends Service {
  private live = true
  readonly aliases = new CommandAliasRegistry()
  /**
   * The launch screen's recent list as the editor browses it: the session ids on show, and the row `↑` has focused
   * (`undefined` while the prompt holds the keyboard). The banner writes the ids and paints the focus; the editor moves it.
   */
  readonly splash: { ids: readonly string[], focus: number | undefined } = { ids: [], focus: undefined }
  /** The Mayfly-owned commands that run while no session is selected. */
  readonly sessionless = new SessionlessCommandRegistry()
  readonly draft = new DraftStash()
  settingsSource: () => MayflySettings
  lastAppliedTheme: MayflySettings['theme'] = 'dark'
  currentThemeKey = 'dark'
  modelsDevCache: { at: number, index: ModelsDevIndex } | undefined
  readonly fdProbe: FdProbeRuntimeState = { result: undefined }
  updateInFlight = false
  /** The `@` mentions the user accepted from the completion list; the editor shows each as a token while its text stands. */
  readonly mentions = new Set<string>()
  /** The prompt's waits in flight (`prompt-wait.ts`). */
  readonly promptWaits: PromptWaits = { active: [] }
  readonly pasteImage: PasteImageRuntimeState = {
    backendOverride: undefined,
    backendCooldowns: new Map(),
    pastedImages: new Map(),
    pasteCount: 0,
  }

  constructor(ctx: Context, defaultSettings: MayflySettings) {
    super(ctx, 'mayflyInteractionState')
    this.settingsSource = () => defaultSettings
  }

  get disposed(): boolean { return !this.live }

  dispose(): void {
    this.live = false
    this.aliases.clear()
    this.sessionless.clear()
    this.splash.ids = []
    this.splash.focus = undefined
    this.draft.clearAll()
    this.modelsDevCache = undefined
    this.fdProbe.result = undefined
    this.pasteImage.backendCooldowns.clear()
    this.pasteImage.pastedImages.clear()
    this.mentions.clear()
    for (const wait of this.promptWaits.active.splice(0)) if (wait.timer !== undefined) clearTimeout(wait.timer)
    this.pasteImage.pasteCount = 0
    this.updateInFlight = false
  }
}
