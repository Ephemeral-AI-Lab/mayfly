/**
 * Bounded Remote-local child processes with operation and feature-lifetime cancellation.
 * @module @ephemeral-ai/mayfly/remote/local/process
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'

export interface LocalToolRun {
  readonly ok: boolean
  readonly code: string | number | undefined
  readonly killed: boolean
  readonly stdout: Buffer
  readonly stderr: string
}

export interface LocalToolOptions {
  readonly input?: string
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly timeoutMs?: number
  readonly maxBuffer?: number
  readonly signal?: AbortSignal
}

/** Format one helper failure with its exit identity and first stderr line. */
export function failureDetail(command: string, run: LocalToolRun): string {
  const first = run.stderr.split('\n').map(line => line.trim()).find(line => line.length > 0)
  return first === undefined
    ? `${command} exited with code ${String(run.code)}`
    : `${command} exited with code ${String(run.code)}: ${first}`
}

/** Run one helper without rejecting for ordinary spawn, timeout, or nonzero-exit failures. */
export function runLocalTool(command: string, args: readonly string[], options: LocalToolOptions = {}): Promise<LocalToolRun> {
  if (options.signal?.aborted === true) return Promise.resolve({ ok: false, code: 'ABORT_ERR', killed: false, stdout: Buffer.alloc(0), stderr: '' })
  return new Promise(resolve => {
    let settled = false
    let child: ChildProcess | undefined
    const timeout = setTimeout(() => stop('ETIMEDOUT', true), options.timeoutMs ?? 3_000)
    const finish = (result: LocalToolRun): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      resolve(result)
    }
    const stop = (code: string | number | undefined, killed: boolean, stderr = ''): void => {
      finish({ ok: false, code, killed, stdout: Buffer.alloc(0), stderr })
      child?.kill('SIGKILL')
      child?.stdin?.destroy()
      child?.stdout?.destroy()
      child?.stderr?.destroy()
    }
    const abort = (): void => { stop('ABORT_ERR', false) }
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      child = execFile(command, args, {
        encoding: 'buffer',
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        killSignal: 'SIGKILL',
        maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error === null) {
          finish({ ok: true, code: 0, killed: false, stdout, stderr: stderr.toString() })
          return
        }
        finish({
          ok: false,
          code: error.code ?? undefined,
          killed: error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? false : error.killed ?? false,
          stdout,
          stderr: stderr.toString(),
        })
      })
      if (settled) return
      child.stdin?.on('error', () => {})
      child.stdin?.end(options.input)
    } catch (error) {
      stop((error as NodeJS.ErrnoException).code, false, String(error))
    }
  })
}

/** Spawn a shell command with inherited terminal stdio and abort-safe settlement. */
export function runInheritedShell(command: string, signal: AbortSignal): Promise<number> {
  if (signal.aborted) return Promise.resolve(1)
  return new Promise((resolve, reject) => {
    let settled = false
    const child = spawn(command, { stdio: 'inherit', shell: true, windowsHide: false })
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      resolve(code)
    }
    const abort = (): void => {
      child.kill('SIGKILL')
      finish(1)
    }
    signal.addEventListener('abort', abort, { once: true })
    child.once('error', error => {
      signal.removeEventListener('abort', abort)
      if (!settled) {
        settled = true
        reject(error)
      }
    })
    child.once('exit', code => { finish(code ?? 0) })
  })
}

/** One feature owner for all local process generations. */
export class LocalProcessOwner {
  private readonly controllers = new Set<AbortController>()
  private disposed = false

  /** Link one operation to feature teardown and return its independent signal. */
  operation(parent?: AbortSignal): { readonly signal: AbortSignal, readonly done: () => void } {
    const controller = new AbortController()
    if (this.disposed || parent?.aborted === true) controller.abort()
    this.controllers.add(controller)
    const abort = (): void => { controller.abort() }
    parent?.addEventListener('abort', abort, { once: true })
    let completed = false
    return {
      signal: controller.signal,
      done: () => {
        if (completed) return
        completed = true
        parent?.removeEventListener('abort', abort)
        this.controllers.delete(controller)
      },
    }
  }

  dispose(): void {
    this.disposed = true
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
  }
}
