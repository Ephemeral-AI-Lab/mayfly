/** Local process results, abort ownership, and renderer-safe shell output. @module */
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalProcessOwner, failureDetail, runInheritedShell, runLocalTool } from '../../src/app/local/process.ts'
import { EditorShell } from '../../src/app/editor/shell.ts'
import { visibleWidth } from '../../src/core/width.ts'
import type { MayflyComponent, MayflyComponents, MayflyScreen, MayflySemanticColors } from '../../src/core.ts'

const native = vi.hoisted(() => ({ execFile: vi.fn(), exec: vi.fn(), spawn: vi.fn() }))
vi.mock('node:child_process', () => native)
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

function child() {
  return Object.assign(new EventEmitter(), {
    kill: vi.fn(), stdin: { on: vi.fn(), end: vi.fn(), destroy: vi.fn() }, stdout: { destroy: vi.fn() }, stderr: { destroy: vi.fn() },
  })
}

describe('bounded local helper execution', () => {
  it('passes exact argv, byte buffers, input, environment and cwd, then settles once', async () => {
    const process = child()
    native.execFile.mockReturnValueOnce(process)
    const lifetime = new AbortController()
    const running = runLocalTool('clipboard', ['literal $(value)', 'secret'], { input: 'text', cwd: '/local', env: { LOCAL_ENV: 'yes' }, signal: lifetime.signal, timeoutMs: 100, maxBuffer: 20 })
    const [command, args, options, callback] = native.execFile.mock.calls[0]!
    expect([command, args]).toEqual(['clipboard', ['literal $(value)', 'secret']])
    expect(options).toMatchObject({ encoding: 'buffer', cwd: '/local', env: { LOCAL_ENV: 'yes' }, maxBuffer: 20, killSignal: 'SIGKILL', windowsHide: true })
    expect(process.stdin.end).toHaveBeenCalledExactlyOnceWith('text')
    process.stdin.on.mock.calls[0]![1](new Error('closed stdin'))
    callback(null, Buffer.from([0, 255]), Buffer.from('warning'))
    callback(new Error('late error'), Buffer.alloc(0), Buffer.alloc(0))
    expect(await running).toEqual({ ok: true, code: 0, killed: false, stdout: Buffer.from([0, 255]), stderr: 'warning' })
    lifetime.abort()
    expect(process.kill).not.toHaveBeenCalled()
  })

  it.each([
    [{ code: 'ENOENT' }, 'ENOENT', false],
    [{ code: 3, killed: true }, 3, true],
    [{}, undefined, false],
    [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', false],
  ])('retains safe failure identity from %j', async (error, code, killed) => {
    const process = child()
    native.execFile.mockReturnValueOnce(process)
    const running = runLocalTool('clipboard', [])
    native.execFile.mock.calls[0]![3](error, Buffer.from('partial'), Buffer.from('diagnostic'))
    expect(await running).toEqual({ ok: false, code, killed, stdout: Buffer.from('partial'), stderr: 'diagnostic' })
  })

  it('refuses an already-cancelled caller and kills a pending helper when cancelled', async () => {
    const lifetime = new AbortController()
    lifetime.abort()
    expect(await runLocalTool('clipboard', [], { signal: lifetime.signal })).toMatchObject({ ok: false, code: 'ABORT_ERR', killed: false })
    expect(native.execFile).not.toHaveBeenCalled()
    const process = child()
    native.execFile.mockReturnValueOnce(process)
    const active = new AbortController()
    const running = runLocalTool('clipboard', [], { signal: active.signal })
    active.abort()
    expect(await running).toMatchObject({ code: 'ABORT_ERR', stdout: Buffer.alloc(0) })
    expect(process.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    for (const stream of [process.stdin, process.stdout, process.stderr]) expect(stream.destroy).toHaveBeenCalledOnce()
    native.execFile.mock.calls[0]![3](null, Buffer.from('late data'), Buffer.alloc(0))
    expect(await running).toMatchObject({ ok: false, code: 'ABORT_ERR' })
  })

  it('times out hung helpers, handles missing stdio and synchronous launch failures', async () => {
    vi.useFakeTimers()
    const process = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> }
    process.kill = vi.fn()
    native.execFile.mockReturnValueOnce(process)
    const running = runLocalTool('clipboard', [], { timeoutMs: 5 })
    vi.advanceTimersByTime(5)
    expect(await running).toMatchObject({ code: 'ETIMEDOUT', killed: true })
    expect(process.kill).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    native.execFile.mockImplementationOnce(() => { throw Object.assign(new Error('not executable'), { code: 'EACCES' }) })
    expect(await runLocalTool('clipboard', [])).toMatchObject({ code: 'EACCES', stderr: 'Error: not executable' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not write stdin after a synchronous completion', async () => {
    const process = child()
    native.execFile.mockImplementationOnce((_command, _args, _options, callback) => {
      callback(null, Buffer.from('ready'), Buffer.alloc(0))
      return process
    })
    expect(await runLocalTool('clipboard', [])).toMatchObject({ ok: true })
    expect(process.stdin.end).not.toHaveBeenCalled()
  })

  it('shows only the first nonempty stderr line in bounded failure detail', () => {
    const base = { ok: false, code: 9, killed: false, stdout: Buffer.alloc(0), stderr: '\n first line \n private later line' }
    expect(failureDetail('clipboard', base)).toBe('clipboard exited with code 9: first line')
    expect(failureDetail('clipboard', { ...base, stderr: ' \n ' })).toBe('clipboard exited with code 9')
  })
})

describe('inherited local shell lifecycle', () => {
  it('keeps exit codes and inherited stdio, and settles null exit as zero', async () => {
    for (const code of [0, 7, null]) {
      const process = child()
      native.spawn.mockReturnValueOnce(process)
      const running = runInheritedShell('editor local-file', new AbortController().signal)
      expect(native.spawn).toHaveBeenLastCalledWith('editor local-file', { stdio: 'inherit', shell: true, windowsHide: false })
      process.emit('exit', code)
      process.emit('exit', 9)
      expect(await running).toBe(code ?? 0)
    }
  })

  it('cancels pending work once and drops late exits and errors', async () => {
    const process = child()
    native.spawn.mockReturnValueOnce(process)
    const lifetime = new AbortController()
    const running = runInheritedShell('editor file', lifetime.signal)
    lifetime.abort()
    process.emit('exit', 0)
    process.emit('error', new Error('late error'))
    expect(await running).toBe(1)
    expect(process.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    native.spawn.mockClear()
    expect(await runInheritedShell('editor file', lifetime.signal)).toBe(1)
    expect(native.spawn).not.toHaveBeenCalled()
  })

  it('rejects a real spawn failure without leaving the abort listener attached', async () => {
    const process = child()
    native.spawn.mockReturnValueOnce(process)
    const lifetime = new AbortController()
    const running = runInheritedShell('editor file', lifetime.signal)
    const observed = expect(running).rejects.toThrow('launch failed')
    process.emit('error', new Error('launch failed'))
    lifetime.abort()
    await observed
    expect(process.kill).not.toHaveBeenCalled()
  })
})

describe('local feature process ownership', () => {
  it('propagates existing and later parent cancellation, releases completed operations, and fences unload', () => {
    const owner = new LocalProcessOwner()
    const before = new AbortController()
    before.abort()
    const cancelled = owner.operation(before.signal)
    expect(cancelled.signal.aborted).toBe(true)
    cancelled.done()
    cancelled.done()
    const parent = new AbortController()
    const pending = owner.operation(parent.signal)
    parent.abort()
    expect(pending.signal.aborted).toBe(true)
    pending.done()
    const completed = owner.operation()
    completed.done()
    const active = owner.operation()
    owner.dispose()
    owner.dispose()
    expect(active.signal.aborted).toBe(true)
    expect(completed.signal.aborted).toBe(false)
    active.done()
    const late = owner.operation()
    expect(late.signal.aborted).toBe(true)
    late.done()
  })
})

function shellFixture() {
  const contents: MayflyComponent[] = []
  const slots: Array<{ dispose: ReturnType<typeof vi.fn> }> = []
  const identity = (text: string) => text
  const colors = { textMuted: identity, error: (text: string) => `error:${text}`, muted: identity, shellMode: identity } as unknown as MayflySemanticColors
  const components = { truncateToWidth: (text: string, width: number) => text.slice(0, width) } as MayflyComponents
  const screen = {
    requestRender: vi.fn(),
    mountContentSlot: vi.fn((_id: string, component: MayflyComponent) => { contents.push(component); const slot = { dispose: vi.fn() }; slots.push(slot); return slot }),
  } as unknown as MayflyScreen
  const shell = new EditorShell(screen, components, colors, (text, values) => text.replace(/\{([^}]+)\}/gu, (_token, key: string) => String(values?.[key])))
  const launch = (command = 'printf hello') => {
    const process = child()
    native.exec.mockReturnValueOnce(process)
    shell.run(command, '/local')
    const callback = native.exec.mock.calls.at(-1)![2] as (error: Error | null, stdout: string, stderr: string) => void
    return { process, callback }
  }
  return { shell, contents, slots, screen, launch, components, colors }
}

describe('local shell transcript echo', () => {
  it('renders successful output and warning stderr with width-bounded rows', () => {
    const f = shellFixture()
    const run = f.launch()
    run.callback(null, 'hello\n', 'warning\n')
    expect(f.contents[0]!.render(80)).toEqual(['  $ printf hello', '  hello', '  warning'])
    f.contents[0]!.invalidate?.()
    for (const width of [1, 3, 8, 40, 80, 120]) expect(f.contents[0]!.render(width).every(row => visibleWidth(row) <= width)).toBe(true)
    expect(f.screen.requestRender).toHaveBeenCalledOnce()
    f.shell.dispose()
    expect(f.slots[0]!.dispose).toHaveBeenCalledOnce()
  })

  it('renders control-free captured output through the shared core sanitizer', () => {
    const f = shellFixture()
    f.launch().callback(null, '\x1b]52;c;c2VjcmV0\x07\x1b[31mred\x1b[0m\x1b]0;title\x1b\\\x1b7\x00\tkeep\n', '')
    expect(f.contents[0]!.render(80)).toEqual(['  $ printf hello', '  red\tkeep'])
    f.shell.dispose()
  })

  it('paints nonzero and nonnumeric failures and labels empty output', () => {
    const f = shellFixture()
    f.launch().callback(Object.assign(new Error('exit'), { code: 4 }), '', 'failed\n')
    expect(f.contents[0]!.render(80)).toContain('  error:failed')
    expect(f.contents[0]!.render(80)).toContain('  error:exit code 4')
    f.launch().callback(new Error('launch failed'), '', '')
    expect(f.contents[1]!.render(80)).toContain('  (no output)')
    expect(f.contents[1]!.render(80)).toContain('  error:exit code 1')
    f.shell.dispose()
  })

  it.each([
    ['x'.repeat(64 * 1024 + 1), '', 1], ['', 'x'.repeat(64 * 1024 + 1), 1],
    [Array(202).fill('line').join('\n'), '', 200],
  ])('bounds oversized local output and labels truncation', (stdout, stderr, lines) => {
    const f = shellFixture()
    f.launch().callback(null, stdout, stderr)
    const rows = f.contents[0]!.render(80)
    expect(rows).toContain('  … output truncated')
    expect(rows).toHaveLength(lines + 2)
    f.shell.dispose()
  })

  it('kills pending children on teardown and ignores all late callbacks and launches', () => {
    const f = shellFixture()
    const pending = f.launch()
    f.shell.dispose()
    f.shell.dispose()
    expect(pending.process.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    pending.callback(null, 'late output', '')
    f.shell.run('late launch', '/local')
    expect(native.exec).toHaveBeenCalledOnce()
    expect(f.contents).toEqual([])
  })

  it('retires echoes and late output on a palette swap while commands retain their local lifetime', () => {
    const f = shellFixture()
    f.launch().callback(null, 'previous palette', '')
    const pending = f.launch()
    f.shell.retheme(f.components, f.colors)
    expect(f.slots[0]!.dispose).not.toHaveBeenCalled()
    const colors = { ...f.colors, textMuted: (text: string) => `new:${text}` }
    f.shell.retheme(f.components, colors)
    expect(f.slots[0]!.dispose).toHaveBeenCalledOnce()
    expect(pending.process.kill).not.toHaveBeenCalled()
    pending.callback(null, 'retired palette output', '')
    expect(f.contents).toHaveLength(1)
    f.launch().callback(null, 'current', '')
    expect(f.contents[1]!.render(80)).toEqual(['  $ printf hello', '  new:current'])
    const nextComponents = { ...f.components }
    f.shell.retheme(nextComponents, colors)
    expect(f.slots[1]!.dispose).toHaveBeenCalledOnce()
    const active = f.launch()
    f.shell.dispose()
    f.shell.retheme(f.components, f.colors)
    expect(active.process.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    expect(f.slots[0]!.dispose).toHaveBeenCalledOnce()
    expect(f.slots[1]!.dispose).toHaveBeenCalledOnce()
  })
})
