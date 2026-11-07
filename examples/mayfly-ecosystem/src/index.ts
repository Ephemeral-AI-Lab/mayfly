/**
 * A TUI source composition of the five ecosystem examples: the ordinary `mayfly` startup with their plugins added to
 * the TUI's Cordis tree.
 *
 * @module @mayfly-example/ecosystem
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { run } from '@ephemeral-ai/mayfly/bin'
import * as bottomLog from '@mayfly-example/bottom-log'
import * as header from '@mayfly-example/header'
import * as overlay from '@mayfly-example/overlay'
import * as inspector from '@mayfly-example/right-inspector'
import * as uiGallery from '@mayfly-example/ui-gallery'

/** The composed plugins, in load order; each runs in its own Fiber and unloads with the TUI. */
export const plugins: readonly Plugin[] = [header, inspector, bottomLog, overlay, uiGallery]

/**
 * Start the TUI with the composed plugins, taking the same options and environment as `mayfly`.
 * @param argv - the command line after the program name.
 */
export async function start(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  await run([...argv], { plugins })
}
