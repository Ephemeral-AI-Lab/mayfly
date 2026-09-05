/** Native Windows command shims must execute without Git Bash. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { updaterInternals } from '../../src/interaction/updater/io.ts'
import { mkdtempTracked, registerTempDirCleanup } from '../core/temp-dir.ts'

registerTempDirCleanup()

describe.skipIf(process.platform !== 'win32')('Windows command shims', () => {
  it('resolves npm.cmd and pnpm.cmd with spaces and Unicode in PATH', async () => {
    const parent = mkdtempTracked('mayfly-command-')
    const root = join(parent, 'space 中文')
    mkdirSync(root)
    for (const command of ['npm', 'pnpm']) {
      writeFileSync(join(root, `${command}.cmd`), '@echo off\r\necho %*\r\n')
      const result = await updaterInternals.spawnOnce(command, ['config', 'get', 'registry'], { env: { PATH: root }, timeoutMs: 5000 })
      expect(result.code).toBe(0)
      expect(result.stdout.trim()).toBe('config get registry')
    }
  })
})
