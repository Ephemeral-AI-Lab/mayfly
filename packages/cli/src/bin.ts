#!/usr/bin/env node
/**
 * The `mayfly` bin is only a hand-off to the independent Remote Frontend.
 * @module @ephemeral-ai/mayfly-cli/bin
 */
import { run } from '@ephemeral-ai/mayfly-remote/remote-bin'

await run()
