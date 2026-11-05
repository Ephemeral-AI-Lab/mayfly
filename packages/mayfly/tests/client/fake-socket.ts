/** Controllable ConnectionWebSocket used by Node transport specs. */
import type { ConnectionWebSocket } from '@deepseek-ai/dsh-client-connection/client'

interface EventMap {
  readonly open: object
  readonly error: object
  readonly close: object
  readonly message: { readonly data: unknown }
}

type EventName = keyof EventMap
type Listener = (event: never) => void

interface ListenerRecord {
  readonly listener: Listener
  readonly once: boolean
}

export class FakeSocket implements ConnectionWebSocket {
  readyState = 0
  readonly sent: string[] = []
  private readonly listeners = new Map<EventName, Set<ListenerRecord>>()

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    void code
    void reason
    if (this.readyState >= 2) return
    this.readyState = 2
    queueMicrotask(() => {
      this.readyState = 3
      this.emit('close', {})
    })
  }

  addEventListener<Event extends EventName>(
    event: Event,
    listener: (event: EventMap[Event]) => void,
    options?: { readonly once?: boolean },
  ): void {
    const records = this.listeners.get(event) ?? new Set<ListenerRecord>()
    records.add({ listener: listener as Listener, once: options?.once === true })
    this.listeners.set(event, records)
  }

  removeEventListener<Event extends EventName>(event: Event, listener: (event: EventMap[Event]) => void): void {
    const records = this.listeners.get(event)
    if (records === undefined) return
    for (const record of records) {
      if (record.listener === listener) records.delete(record)
    }
  }

  open(): void {
    this.readyState = 1
    this.emit('open', {})
  }

  emit<Event extends EventName>(event: Event, value: EventMap[Event]): void {
    if (event === 'close') this.readyState = 3
    const records = this.listeners.get(event)
    if (records === undefined) return
    for (const record of records) {
      if (record.once) records.delete(record)
      record.listener(value as never)
    }
  }
}
