

/** The waits in flight, newest last; `shown` once the delay has passed. */
export interface PromptWaits {
  readonly active: Array<{ readonly message: string, shown: boolean, timer: ReturnType<typeof setTimeout> | undefined }>
}

