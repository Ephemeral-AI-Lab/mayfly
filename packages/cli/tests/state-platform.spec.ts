/** Windows directory ACLs and filesystem ownership refusal without invoking system tools. @module */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempTracked, registerTempDirCleanup } from '../../mayfly/tests/core/temp-dir.ts'

const native = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  const util = await import('node:util')
  const file = Object.assign(vi.fn(), { [util.promisify.custom]: native.run })
  return { ...actual, execFile: file }
})
import { execute, paths, privateDirectory } from '../src/state.ts'

registerTempDirCleanup()
const platform = process.platform
const uid = process.getuid
afterEach(() => { Object.defineProperty(process, 'getuid', { value: uid, configurable: true }); Object.defineProperty(process, 'platform', { value: platform }); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('resolves defaults and Windows pipes and installs an exact current-user ACL', async () => {
  vi.stubEnv('MAYFLY_HOME', '')
  expect(paths('work').home).toContain('.mayfly')
  Object.defineProperty(process, 'platform', { value: 'win32' })
  expect(paths('work').socket).toMatch(/^\\\\\.\\pipe\\mayfly-/u)
  native.run.mockResolvedValue({ stdout: '', stderr: '' })
  await privateDirectory(mkdtempTracked('mayfly-acl-'))
  expect(native.run).toHaveBeenCalledWith('powershell.exe', expect.arrayContaining([expect.stringContaining('SetAccessRuleProtection($true,$false)')]), expect.objectContaining({ encoding: 'utf8', env: expect.objectContaining({ MAYFLY_ACL_PATH: expect.any(String) }) }))
  native.run.mockRejectedValueOnce(new Error('ACL refused'))
  await expect(privateDirectory(mkdtempTracked('mayfly-acl-fail-'))).rejects.toThrow('ACL refused')
  expect(await execute('tool', [], { timeout: 10 })).toHaveProperty('stdout')
})

it('refuses a directory owned by a different POSIX user', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  Object.defineProperty(process, 'getuid', { value: () => 0x7fffffff, configurable: true })
  await expect(privateDirectory(mkdtempTracked('mayfly-owner-'))).rejects.toThrow('another user')
})
