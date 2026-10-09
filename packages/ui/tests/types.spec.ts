/** Type fixtures for the public contract (component inference, `memo`, rejected shapes, custom kinds) compile against the built declarations. */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('compiles every type fixture, including each @ts-expect-error', () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url))
  const tsc = fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url))
  const run = (): string => {
    try {
      return execFileSync(process.execPath, [tsc, '-p', 'packages/ui/tests/tsconfig.json', '--pretty', 'false'], { cwd: root, encoding: 'utf8', stdio: 'pipe' })
    } catch (error) {
      return String((error as { stdout?: unknown }).stdout ?? error)
    }
  }
  expect(run()).toBe('')
}, 120_000)
