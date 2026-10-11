/**
 * Alternate-screen protection against writes that bypass the renderer.
 * Out-of-band stdout/stderr still reach the terminal, then a forced frame
 * restores cells around the renderer-owned hardware cursor.
 *
 * The boundary is the `Terminal` object handed to the renderer, not one
 * method: `ProcessTerminal` reaches `process.stdout` from `start`, `stop`,
 * `drainInput`, the cursor and clearing methods, `setTitle` and the progress
 * methods — wrapping only `write` let every such call masquerade as ambient
 * output and force a repaint. `renderer(terminal)` returns a facade that
 * brackets every function-valued property in the renderer scope, so a write
 * that did not go through it is ambient by definition.
 *
 * @module @ephemeral-ai/mayfly/core/output-recovery
 */

import type { Terminal } from '@earendil-works/pi-tui'

/** The writable face used by process stdout/stderr and source-plane fakes. */
export interface AmbientOutputStream {
  write: NodeJS.WriteStream['write']
}

/** Pair of process output streams guarded while alternate-screen owns them. */
export interface AmbientOutput {
  readonly stdout: AmbientOutputStream
  readonly stderr: AmbientOutputStream
}

/** Reversible ownership handle for alternate-screen output recovery. */
interface OutputRecovery {
  /** Install the stream guards. Idempotent. */
  activate(): void
  /** Restore the original streams while the terminal is released. */
  deactivate(): void
  /**
   * The renderer-facing terminal facade: every function-valued property runs
   * inside the renderer write scope; getters pass through.
   * @param terminal - the concrete terminal the facade delegates to.
   * @returns the terminal to hand to the renderer.
   */
  renderer(terminal: Terminal): Terminal
}

/**
 * Guard ambient writes while preserving renderer-owned terminal writes.
 * External output is deliberately written first: command-line hosts retain
 * their stdout/stderr contract, and the forced repaint repairs the alternate
 * screen on the next tick.
 * @param output - ambient stdout/stderr streams shared by host plugins.
 * @param repaint - forced frame request after an out-of-band write.
 * @returns an idempotent activate/deactivate handle plus the renderer facade.
 */
export function createOutputRecovery(
  output: AmbientOutput,
  repaint: () => void,
): OutputRecovery {
  const stdoutWrite = output.stdout.write
  const stderrWrite = output.stderr.write
  let active = false
  let rendererWriteDepth = 0

  const guard = (stream: AmbientOutputStream, original: NodeJS.WriteStream['write']): NodeJS.WriteStream['write'] => {
    return function (...args: Parameters<NodeJS.WriteStream['write']>): boolean {
      const written = Reflect.apply(original, stream, args) as boolean
      if (rendererWriteDepth === 0) repaint()
      return written
    } as NodeJS.WriteStream['write']
  }
  const guardedStdoutWrite = guard(output.stdout, stdoutWrite)
  const guardedStderrWrite = guard(output.stderr, stderrWrite)

  return {
    activate() {
      if (active) return
      active = true
      output.stdout.write = guardedStdoutWrite
      output.stderr.write = guardedStderrWrite
    },
    deactivate() {
      if (!active) return
      active = false
      if (output.stdout.write === guardedStdoutWrite) output.stdout.write = stdoutWrite
      if (output.stderr.write === guardedStderrWrite) output.stderr.write = stderrWrite
    },
    renderer(terminal: Terminal): Terminal {
      return new Proxy(terminal, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property)
          if (typeof value !== 'function') return value
          return (...args: unknown[]) => {
            rendererWriteDepth += 1
            try {
              return Reflect.apply(value, target, args)
            } finally {
              rendererWriteDepth -= 1
            }
          }
        },
      })
    },
  }
}
