/**
 * Decision tests for the single-consumer stream queue: buffered delivery,
 * terminal states, abort propagation, and idempotent cleanup.
 * @module
 */
import { describe, expect, it } from 'vitest'
import { ChangeQueue } from '../../src/remote/queue.ts'

describe('ChangeQueue', () => {
  it('releases a blocked reader when a stream ends and ignores later failure', async () => {
    const queue = new ChangeQueue<number>(new AbortController().signal)
    const waiting = queue.next()
    queue.finish()
    queue.fail(new Error('late failure'))
    await expect(waiting).resolves.toEqual({ value: undefined, done: true })
    await expect(queue.next()).resolves.toEqual({ value: undefined, done: true })
  })

  it('buffers pushed values and delivers them in order to a later reader', async () => {
    const queue = new ChangeQueue<number>(new AbortController().signal)
    queue.push(1)
    queue.push(2)
    expect(await queue.next()).toEqual({ value: 1, done: false })
    expect(await queue.next()).toEqual({ value: 2, done: false })
    queue.finish()
    expect(await queue.next()).toEqual({ value: undefined, done: true })
  })

  it('hands a pushed value straight to a waiting reader without buffering', async () => {
    const queue = new ChangeQueue<number>(new AbortController().signal)
    const waiting = queue.next()
    queue.push(7)
    expect(await waiting).toEqual({ value: 7, done: false })
  })

  it('rejects a waiting reader and later reads with the abort reason', async () => {
    const controller = new AbortController()
    const queue = new ChangeQueue<number>(controller.signal)
    const waiting = queue.next()
    controller.abort(new Error('client hung up'))
    await expect(waiting).rejects.toThrow('client hung up')
    await expect(queue.next()).rejects.toThrow('client hung up')
  })

  it('fails immediately when constructed on an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort(new Error('too late'))
    const queue = new ChangeQueue<number>(controller.signal)
    queue.push(1)
    await expect(queue.next()).rejects.toThrow('too late')
  })

  it('drops buffered values and refuses pushes after a failure', async () => {
    const queue = new ChangeQueue<number>(new AbortController().signal)
    queue.push(1)
    queue.fail(new Error('upstream died'))
    queue.push(2)
    await expect(queue.next()).rejects.toThrow('upstream died')
  })

  it('treats finish and return as idempotent and clears the abort listener', async () => {
    const controller = new AbortController()
    const queue = new ChangeQueue<number>(controller.signal)
    queue.finish()
    queue.finish()
    await queue.return()
    // The listener is gone: a late abort must not resurrect a rejection.
    controller.abort(new Error('late abort'))
    expect(await queue.next()).toEqual({ value: undefined, done: true })
  })

  it('iterates as a single async stream to exhaustion', async () => {
    const queue = new ChangeQueue<string>(new AbortController().signal)
    queue.push('a')
    queue.push('b')
    queue.finish()
    const collected: string[] = []
    for await (const value of queue) collected.push(value)
    expect(collected).toEqual(['a', 'b'])
  })
})
