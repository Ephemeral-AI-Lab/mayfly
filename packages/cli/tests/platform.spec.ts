/** Native user service definitions and platform command contracts. @module */
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempTracked, registerTempDirCleanup } from '../../mayfly/tests/core/temp-dir.ts'

vi.mock('../src/state.ts', async original => {
  const actual = await original<typeof import('../src/state.ts')>()
  return { ...actual, execute: vi.fn(), privateDirectory: vi.fn(actual.privateDirectory) }
})
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: vi.fn() }))
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: vi.fn() }))

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { execute, paths, privateDirectory } from '../src/state.ts'
import { definition, isEnabled, register, removeSocket, serviceId, setEnabled, startService, stopService, systemdQuote, windowsQuote, xml } from '../src/platform.ts'

registerTempDirCleanup()
const platform = process.platform
function on(value: string): void { Object.defineProperty(process, 'platform', { value }) }
beforeEach(() => {
  const home = mkdtempTracked('mayfly-platform-')
  vi.mocked(homedir).mockReturnValue(home)
  vi.stubEnv('MAYFLY_HOME', join(home, 'mayfly'))
  vi.mocked(execute).mockReset().mockResolvedValue({ stdout: '', stderr: '' } as never)
})
afterEach(() => { on(platform); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('escapes native definitions and distinguishes data roots and profiles', () => {
  const p = paths('work')
  expect(systemdQuote('a%$"\\\n\r')).toBe('"a%%$$\\"\\\\\\n\\r"')
  expect(xml('<>&"\'')).toBe('&lt;&gt;&amp;&quot;&apos;')
  expect(windowsQuote('C:\\a b\\')).toBe('"C:\\a b\\\\"')
  expect(windowsQuote('a"b')).toBe('"a\\"b"')
  expect(serviceId(p)).not.toBe(serviceId(paths('other')))
  expect(definition(p, 'work', '/bin with spaces', 'linux')).toContain('Restart=on-failure')
  expect(definition(p, 'work', '/bin', 'darwin', true)).toContain('<key>RunAtLoad</key><true/>')
  expect(definition(p, 'work', '/bin', 'darwin')).toContain('<key>RunAtLoad</key><false/>')
})

it('registers, starts, enables and stops systemd without enabling during registration', async () => {
  on('linux')
  const p = paths('work')
  const bin = '/a bin'
  await register(p, 'work', bin)
  const file = join(homedir(), '.config/systemd/user', `${serviceId(p)}.service`)
  expect(await readFile(file, 'utf8')).toContain('UMask=0077')
  expect(execute).toHaveBeenCalledWith('systemctl', ['--user', 'daemon-reload'])
  vi.mocked(execute).mockClear()
  await register(p, 'work', bin)
  expect(execute).not.toHaveBeenCalledWith('systemctl', ['--user', 'daemon-reload'])
  await startService(p, 'work', bin)
  await setEnabled(p, 'work', bin, true)
  await setEnabled(p, 'work', bin, false)
  await stopService(p)
  expect(execute).toHaveBeenCalledWith('systemctl', ['--user', 'stop', `${serviceId(p)}.service`])
  vi.mocked(execute).mockResolvedValueOnce({ stdout: 'enabled\n' } as never)
  expect(await isEnabled(p)).toBe(true)
  vi.mocked(execute).mockRejectedValueOnce(new Error('disabled'))
  expect(await isEnabled(p)).toBe(false)
  await stopService(paths('absent'))
  await removeSocket(p)
})

it('registers and controls LaunchAgents and reads their login policy', async () => {
  on('darwin')
  const p = paths('work')
  await register(p, 'work', '/bin')
  await startService(p, 'work', '/bin')
  await stopService(p)
  vi.mocked(execute).mockImplementation(async (_cmd, args) => {
    if (args?.[0] === 'print') throw new Error('not loaded')
    return { stdout: '', stderr: '' } as never
  })
  await startService(p, 'work', '/bin')
  await stopService(p)
  expect(execute).toHaveBeenCalledWith('launchctl', ['bootstrap', expect.any(String), expect.any(String)])
  await setEnabled(p, 'work', '/bin', true)
  expect(await isEnabled(p)).toBe(true)
  await setEnabled(p, 'work', '/bin', false)
  expect(await isEnabled(p)).toBe(false)
  expect(await isEnabled(paths('absent'))).toBe(false)
})

it('detaches Windows supervision and changes only HKCU login startup', async () => {
  on('win32')
  const p = paths('work')
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
  vi.mocked(spawn).mockImplementation(() => { queueMicrotask(() => child.emit('spawn')); return child as never })
  await startService(p, 'work', 'C:\\a b\\bin.js')
  expect(spawn).toHaveBeenCalledWith(process.execPath, expect.arrayContaining(['__service', 'work']), { detached: true, windowsHide: true, stdio: 'ignore' })
  expect(child.unref).toHaveBeenCalled()
  await setEnabled(p, 'work', 'C:\\a b\\bin.js', true)
  await setEnabled(p, 'work', 'C:\\a b\\bin.js', false)
  vi.mocked(execute).mockRejectedValueOnce(new Error('absent'))
  await setEnabled(p, 'work', '/bin', false)
  await stopService(p)
  await removeSocket(p)
  vi.mocked(spawn).mockImplementation(() => { queueMicrotask(() => child.emit('error', new Error('spawn failed'))); return child as never })
  await expect(startService(p, 'work', '/bin')).rejects.toThrow('spawn failed')
})

it('rejects unsupported systems and propagates native registration failures', async () => {
  const p = paths('work')
  on('freebsd')
  await expect(register(p, 'work', '/bin')).rejects.toThrow('supports Linux')
  on('linux')
  vi.mocked(privateDirectory).mockRejectedValueOnce(new Error('permissions'))
  await expect(register(p, 'work', '/bin')).rejects.toThrow('permissions')
  // A changed executable path regenerates an existing definition.
  await register(p, 'work', '/bin')
  const file = join(homedir(), '.config/systemd/user', `${serviceId(p)}.service`)
  await writeFile(file, 'outdated')
  await register(p, 'work', '/new bin')
  expect(await readFile(file, 'utf8')).toContain('/new bin')
})
