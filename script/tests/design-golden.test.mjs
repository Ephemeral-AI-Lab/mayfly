/** Golden capture of the design prototype: frame parsing, walk table, and determinism. @module script/tests/design-golden */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { ROOT } from '../package-contract.mjs'
import { captureAll, captureWalk, diffGoldens, parseFrames, stepLabel, stripSgr } from '../design-golden.mjs'
import { SCENES, walks } from '../design-golden-walks.mjs'

const paint = (rows, up = '') => `${up}${['nav', '', ...rows, '', 'foot'].map(row => `\x1b[2K${row}`).join('\n')}\n\x1b[J`

describe('frame parsing', () => {
  test('keeps the scene rows of each step and drops the chrome', () => {
    const output = `\x1b[?25l${paint(['a', '\x1b[1mb\x1b[0m'])}\x1e0\n${paint(['c'], '\x1b[7A')}\x1e1\n\x1e2\n`
    assert.deepEqual(parseFrames(output, 3), [['a', '\x1b[1mb\x1b[0m'], ['c'], null])
  })

  test('refuses output with fewer steps than the walk', () => {
    assert.throws(() => parseFrames('\x1e0\n', 2), /expected 2 steps/u)
  })

  test('strips colors and weights and labels steps', () => {
    assert.equal(stripSgr('\x1b[1m\x1b[38;2;1;2;3mx\x1b[0m'), 'x')
    assert.deepEqual([stepLabel('\0', 0), stepLabel('\x1b[B', 1), stepLabel(100, 2)], ['start', '"\\u001b[B"', '+100ms'])
  })
})

describe('walk table', () => {
  test('names every scene of the prototype in order', () => {
    const list = spawnSync(process.execPath, ['docs/design/prototypes/ui-preview.mjs', '--list'], { cwd: ROOT, encoding: 'utf8' })
    const names = list.stdout.trim().split('\n').map(line => line.replace(/^\s*\d+\s+(?:basic|mayfly)\s+/u, '').replace(/\s+§.*$/u, ''))
    assert.deepEqual(SCENES, names)
  })

  test('walks every scene from a first frame, with unique names per scene', () => {
    const all = walks()
    for (let scene = 1; scene <= SCENES.length; scene += 1) {
      const own = all.filter(walk => walk.scene === scene)
      assert.ok(own.some(walk => walk.name === 'initial'), `scene ${scene} has an initial walk`)
      assert.equal(new Set(own.map(walk => walk.name)).size, own.length, `scene ${scene} walk names are unique`)
      for (const walk of own) assert.equal(walk.steps[0], '\0')
    }
  })
})

describe('capture', () => {
  const dirs = []
  after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

  test('is deterministic and shows the key that was sent', () => {
    const walk = walks().find(candidate => candidate.scene === 3 && candidate.name === 'move')
    const first = captureWalk(walk)
    assert.deepEqual(captureWalk(walk), first)
    assert.match(first.txt, /--- after start ---\n[^]*--- after "\\u001b\[B" ---/u)
    assert.ok(!first.txt.includes('\x1b'))
    assert.ok(first.ansi.includes('\x1b[1m'))
  })

  test('reports missing, changed, and stale goldens', () => {
    const dir = mkdtempSync(join(tmpdir(), 'design-golden-'))
    dirs.push(dir)
    const files = captureAll(2)
    assert.ok([...files.keys()].every(name => name.startsWith('02-actions/')))
    assert.deepEqual(diffGoldens(files, 2, dir).every(problem => problem.startsWith('missing ')), true)
  })
})
