#!/usr/bin/env node
/**
 * Unified terminal launcher and local background Host management.
 * @module @ephemeral-ai/mayfly-cli/bin
 */
import { run, validateArguments } from '@ephemeral-ai/mayfly/bin'
import { parse, HELP } from './options.ts'
import { ensure, manage, ownBin } from './manager.ts'
import { packageManifest } from './profiles.ts'
import { supervise } from './supervisor.ts'
import { redact } from './logs.ts'

try {
  const argv = process.argv.slice(2)
  if (argv[0] === '__service') {
    if (argv.length !== 3 || !/^[a-zA-Z0-9_-]+$/u.test(argv[1]!)) throw new Error('Invalid internal service invocation')
    process.env.MAYFLY_HOME = argv[2]!
    await supervise(argv[1]!)
  } else {
    const options = parse(argv)
    if (!options.server) validateArguments(options.remote)
    if (options.help) process.stdout.write(HELP)
    else if (options.version) process.stdout.write(`mayfly ${packageManifest('@ephemeral-ai/mayfly-cli').version}\n`)
    else if (options.server) await manage(options, ownBin(), text => process.stdout.write(text))
    else if (process.env.MAYFLY_DSH_STARTUP_URL || options.remote.some(arg => /^--host(?:=|$)/u.test(arg))) await run(options.remote)
    else {
      const state = await ensure(options, ownBin(), text => process.stderr.write(text))
      await run(options.remote, state.url!)
    }
  }
} catch (error) {
  process.stderr.write(`mayfly: ${redact(error instanceof Error ? error.message : String(error))}\n`)
  process.exitCode = 1
}
