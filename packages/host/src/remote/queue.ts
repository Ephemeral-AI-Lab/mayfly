/** Single-consumer AsyncIterable queue owned by one Remote stream and its cancellation signal. @module */

interface Pending<T> {
  readonly resolve: (result: IteratorResult<T>) => void
  readonly reject: (error: unknown) => void
}

/** Buffered stream values with terminal error propagation and idempotent cleanup. */
export class ChangeQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private pending: Pending<T> | undefined
  private finished = false
  private failed = false
  private failure: unknown
  private readonly offAbort: () => void

  constructor(signal: AbortSignal) {
    const abort = (): void => { this.fail(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    this.offAbort = () => { signal.removeEventListener('abort', abort) }
    if (signal.aborted) abort()
  }

  push(value: T): void {
    if (this.finished) return
    if (this.pending !== undefined) {
      const pending = this.pending
      this.pending = undefined
      pending.resolve({ value, done: false })
      return
    }
    this.values.push(value)
  }

  fail(error: unknown): void {
    if (this.finished) return
    this.finished = true
    this.failed = true
    this.failure = error
    this.values.length = 0
    if (this.pending !== undefined) {
      const pending = this.pending
      this.pending = undefined
      pending.reject(error)
    }
    this.offAbort()
  }

  finish(): void {
    if (this.finished) return
    this.finished = true
    if (this.pending !== undefined) {
      const pending = this.pending
      this.pending = undefined
      pending.resolve({ value: undefined, done: true })
    }
    this.offAbort()
  }

  next(): Promise<IteratorResult<T>> {
    if (this.failed) return Promise.reject(this.failure)
    const value = this.values.shift()
    if (value !== undefined) return Promise.resolve({ value, done: false })
    if (this.finished) return Promise.resolve({ value: undefined, done: true })
    return new Promise<IteratorResult<T>>((resolve, reject) => { this.pending = { resolve, reject } })
  }

  return(): Promise<IteratorResult<T>> {
    this.finish()
    return Promise.resolve({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this
  }
}
