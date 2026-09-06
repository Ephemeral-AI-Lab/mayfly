/**
 * Release information embedded in the `/changelog` panel.
 *
 * Mayfly starts a new release history at the repository migration boundary,
 * so this module intentionally carries no legacy release notes.
 *
 * @module @ephemeral-ai/mayfly/interaction/changelog-content
 */

/** One release's panel content. */
export interface ChangelogEntry {
  /** The release version. */
  readonly version: string
  /** The release summary. */
  readonly summary: string
  /** The most important changes. */
  readonly highlights: readonly string[]
  /** Known limitations in this release. */
  readonly knownIssues: readonly string[]
}

/** Mayfly releases, newest first. */
export const CHANGELOG_ENTRIES: readonly ChangelogEntry[] = [
  {
    version: '0.1.0-alpha.3',
    summary: 'OAuth provider onboarding, independent plan and permission controls, and clearer streaming progress.',
    highlights: [
      'OAuth providers - discover available sign-in flows in /provider and create the provider profile after authorization succeeds.',
      'Plan and permissions - Shift+Tab toggles plan independently from /permission, and the status line can display plan and yolo together.',
      'Explicit confirmations - use Yes/No actions with No initially focused; cancelling provider deletion preserves the edit draft.',
      'Output progress - finish the thinking animation when the answer starts and show output counts and estimated token rates for the active phase, with narrow-width fallbacks.',
      'Streaming responsiveness - defer transcript conversion until the next snapshot read and keep shared session views responsive during output bursts.',
      'Updater compatibility - accept npm 12 JSON result arrays when checking for updates.',
    ],
    knownIssues: [],
  },
  {
    version: '0.1.0-alpha.2',
    summary: 'Complete transcript output, cancellable UI providers, and more reliable agent and plugin workflows.',
    highlights: [
      'Complete content - retain transcript history, expanded tool output, and chart data; browse large background-job logs through bounded output pages.',
      'Async UI snapshots - cancel pane and overlay loads, page pane content, contain startup failures, and preserve newer explicit snapshots.',
      'Stable rendering - preserve scroll anchors when content changes and refresh cached layouts after viewport or session changes.',
      'Agent views - reuse the session layout for auxiliary agents, hide inherited BTW history, and scope interruption to the selected agent and its running descendants.',
      'Plugin marketplace - browse and install plugins in Mayfly and discover available packages on the website.',
      'Platform reliability - improve editor input, clipboard helpers, exact-host commands, and concurrent CLI runtime cache repair across Linux, macOS, and Windows.',
    ],
    knownIssues: [],
  },
  {
    version: '0.1.0-alpha.1',
    summary: 'Mayfly begins with a consolidated three-package terminal UI for DeepSeek Harness.',
    highlights: [
      'Three-package distribution — @ephemeral-ai/mayfly contains the complete runtime and composition, @ephemeral-ai/mayfly-ui contains renderer-neutral contracts and four direct UI services, and @ephemeral-ai/mayfly-cli launches the pinned Harness host.',
      'Direct Harness integration — plugins consume native dsh services directly and use Mayfly APIs only for panes, status, overlays, and editor extensions.',
      'Flat Cordis composition — runtime entries are public Mayfly subpaths in one package, with ordinary Fiber ownership and no compatibility packages, capability host, catalog layer, or private runtime realm.',
      'Clean migration boundary — package names, CLI, profiles, settings, events, storage, documentation, and examples use the Mayfly brand without legacy compatibility aliases.',
    ],
    knownIssues: [],
  },
]
