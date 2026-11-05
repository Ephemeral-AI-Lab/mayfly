/** Unified bin dispatch without touching real user profiles or service managers. @module */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('@ephemeral-ai/mayfly/bin', () => ({ run: vi.fn(), validateArguments: vi.fn() }))
vi.mock('../src/manager.ts', () => ({ ensure: vi.fn(), manage: vi.fn(), ownBin: () => '/bin' }))
vi.mock('../src/profiles.ts', () => ({ packageManifest: () => ({ version: '1' }) }))
vi.mock('../src/supervisor.ts', () => ({ supervise: vi.fn() }))

import { run, validateArguments } from '@ephemeral-ai/mayfly/bin'
import { ensure, manage } from '../src/manager.ts'
import { supervise } from '../src/supervisor.ts'

const argv = process.argv
const code = process.exitCode
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubEnv('MAYFLY_DSH_STARTUP_URL', '')
  vi.mocked(ensure).mockResolvedValue({ state: 'running', url: 'http://localhost/?token=secret', pid: 1, version: '1', generation: 'one' })
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  process.argv = [...argv.slice(0, 2)]
})
afterEach(() => { process.argv = argv; process.exitCode = code; vi.unstubAllEnvs(); vi.restoreAllMocks() })
async function invoke(args: string[]): Promise<void> { process.argv.push(...args); await import('../src/bin.ts') }

it('prints help/version without initializing a Host', async () => {
  await invoke(['--help'])
  expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('background Host'))
  expect(ensure).not.toHaveBeenCalled()
  vi.resetModules()
  process.argv = [...argv.slice(0, 2)]
  await invoke(['--version'])
  expect(process.stdout.write).toHaveBeenCalledWith('mayfly 1\n')
})
it('starts the local server and passes credentials only in memory', async () => {
  vi.mocked(ensure).mockImplementation(async (_options, _bin, output) => {
    output('starting\n')
    return { state: 'running', url: 'http://localhost/?token=secret', pid: 1, version: '1', generation: 'one' }
  })
  await invoke(['--profile=work', 'task'])
  expect(ensure).toHaveBeenCalledWith(expect.objectContaining({ profile: 'work' }), '/bin', expect.any(Function))
  expect(run).toHaveBeenCalledWith(['task'], { localStartupUrl: 'http://localhost/?token=secret' })
})
it.each([[], ['--host=https://example.test']])('preserves explicit remote connection %j', async (...args) => {
  if (args.length === 0) vi.stubEnv('MAYFLY_DSH_STARTUP_URL', 'http://localhost/?token=secret')
  await invoke(args)
  expect(ensure).not.toHaveBeenCalled()
  expect(run).toHaveBeenCalledWith(args)
})
it('dispatches server management without starting the TUI', async () => {
  vi.mocked(manage).mockImplementation(async (_options, _bin, output) => { output('status\n') })
  await invoke(['server', 'status'])
  expect(manage).toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
})
it('admits only complete internal service invocations', async () => {
  vi.stubEnv('MAYFLY_HOME', '')
  await invoke(['__service', 'work', '/data root'])
  expect(supervise).toHaveBeenCalledWith('work')
  expect(process.env.MAYFLY_HOME).toBe('/data root')
})
it.each([['__service'], ['__service', '../bad', '/tmp'], ['server', 'unknown']])('reports invalid invocation %j', async (...args) => {
  await invoke(args)
  expect(process.exitCode).toBe(1)
  expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('mayfly:'))
})
it('redacts failures from delegated actions', async () => {
  vi.mocked(manage).mockRejectedValueOnce('http://localhost/?token=secret')
  await invoke(['server', 'status'])
  expect(process.stderr.write).toHaveBeenCalledWith('mayfly: http://localhost/?token=<redacted>\n')
})
it('refuses invalid terminal input before starting a local server', async () => {
  vi.mocked(validateArguments).mockImplementationOnce(() => { throw new Error('invalid terminal arguments') })
  await invoke(['--token=secret'])
  expect(ensure).not.toHaveBeenCalled()
  expect(process.exitCode).toBe(1)
})
