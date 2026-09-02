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
