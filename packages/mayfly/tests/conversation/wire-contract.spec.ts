/** Host is the only owner of the conversation wire types; the TUI imports them and declares none. @module */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const SRC = new URL('../../src/', import.meta.url).pathname

it('declares no conversation wire type of its own', async () => {
  const files = (await readdir(SRC, { recursive: true })).filter(file => file.endsWith('.ts'))
  const declared: string[] = []
  for (const file of files) {
    const source = await readFile(join(SRC, file), 'utf8')
    for (const match of source.matchAll(/^\s*(?:export\s+)?(?:interface|type)\s+(Conversation\w*)\b/gmu)) declared.push(`${file}: ${match[1]}`)
  }
  expect(declared).toEqual([])
  const users = await Promise.all(files.map(file => readFile(join(SRC, file), 'utf8')))
  expect(users.some(source => source.includes("from '@ephemeral-ai/mayfly-host/types'"))).toBe(true)
})
