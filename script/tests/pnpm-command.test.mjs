/** Native pnpm invocation preserves paths and arguments without shell parsing. @module script/tests/pnpm-command */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pnpmCommand } from '../pnpm-command.mjs'

test('executes the pnpm script through Node with literal Unicode, spaces and shell characters', () => {
  const root = mkdtempSync(join(tmpdir(), 'mayfly pnpm 中文 '))
  try {
    const entry = join(root, 'pnpm.cjs')
    writeFileSync(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
    const args = ['exec', 'a b', '中文', '$(never-run)', '&', '"quoted"']
    assert.deepEqual(JSON.parse(execFileSync(...pnpmCommand(args, { env: { npm_execpath: entry } }), { encoding: 'utf8' })), args)
    const directory = join(root, 'bin')
    mkdirSync(join(directory, 'node_modules/pnpm/bin'), { recursive: true })
    writeFileSync(join(directory, 'pnpm.cmd'), '@echo off')
    const installed = join(directory, 'node_modules/pnpm/bin/pnpm.cjs')
    writeFileSync(installed, '')
    assert.deepEqual(pnpmCommand(['build'], { env: { PATH: directory }, platform: 'win32' }), [process.execPath, [installed, 'build']])
    assert.throws(() => pnpmCommand([], { env: {} }), /Cannot locate pnpm/u)
    assert.throws(() => pnpmCommand([], { env: { npm_execpath: join(root, 'npm-cli.js') } }), /Cannot locate pnpm/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
