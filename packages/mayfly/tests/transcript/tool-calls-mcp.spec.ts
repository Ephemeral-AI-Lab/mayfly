/** How a call to an MCP tool reads: the public name, the arguments on a line and under it, and a result that is JSON. @module @ephemeral-ai/mayfly/tests/transcript/tool-calls-mcp */
import { describe, expect, it } from 'vitest'
import { mcpArguments, mcpNameOf, mcpResultRows } from '../../src/transcript/tool-calls-mcp.ts'

describe('the name of an MCP tool', () => {
  it('reads as its server and tool, and a double underscore after the first belongs to the tool', () => {
    expect(mcpNameOf('mcp__github__get_issue')).toEqual({ server: 'github', tool: 'get_issue' })
    expect(mcpNameOf('mcp__a__b__c')).toEqual({ server: 'a', tool: 'b__c' })
  })

  it('leaves out the hash of a name the Harness had to change', () => {
    expect(mcpNameOf('mcp__my_server__get_x_0123456789ab')).toEqual({ server: 'my_server', tool: 'get_x' })
  })

  it('names only what is left of a name cut before its separator, or with nothing after it', () => {
    expect(mcpNameOf('mcp__a_very_long_server_name_0123456789ab')).toEqual({ tool: 'a_very_long_server_name' })
    expect(mcpNameOf('mcp__server__')).toEqual({ tool: 'server__' })
    expect(mcpNameOf('mcp____tool')).toEqual({ tool: '__tool' })
  })
})

describe('the arguments of an MCP call', () => {
  const of = (args: unknown) => mcpArguments(JSON.stringify(args))

  it('has nothing to say about no arguments, or arguments that are not an object', () => {
    expect(of({})).toEqual({})
    expect(of([1])).toEqual({})
  })

  it('reads a lone scalar as its value, on one line and within the line\'s bound', () => {
    expect(of({ url: 'https://pi.dev' })).toEqual({ target: 'https://pi.dev' })
    expect(of({ limit: 3 })).toEqual({ target: '3' })
    expect(of({ all: null })).toEqual({ target: 'null' })
    expect(of({ query: 'two\n  lines' })).toEqual({ target: 'two lines' })
    expect(of({ query: 'x'.repeat(90) }).target).toHaveLength(60)
  })

  it('reads several as key=value, quoting a string only where it could not be told apart', () => {
    expect(of({ owner: 'acme', repo: 'web', issue_number: 1423 })).toEqual({ target: 'owner=acme, repo=web, issue_number=1423' })
    expect(of({ query: 'is:open label:bug', per_page: 30 })).toEqual({ target: 'query="is:open label:bug", per_page=30' })
    expect(of({ a: 'x,y', b: 'x=y', c: 'say "x"' })).toEqual({ target: 'a="x,y", b="x=y", c="say \\"x\\""' })
    expect(of({ a: '', b: true })).toEqual({ target: 'a="", b=true' })
  })

  it('shows at most three on the line and counts the rest, which the row lists', () => {
    expect(of({ a: 1, b: 2, c: 3, d: 4, e: 5 })).toEqual({ target: 'a=1, b=2, c=3, +2', args: 'd=4 · e=5' })
  })

  it('leaves what nests to the row, and counts it even when nothing is on the line beside it', () => {
    expect(of({ title: 'x', labels: ['docs'] })).toEqual({ target: 'title=x, +1', args: 'labels=["docs"]' })
    expect(of({ filter: { a: 1 } })).toEqual({ target: '+1', args: 'filter={"a":1}' })
  })

  it('gives a later scalar that does not fit to the row, cut there, while a shorter one after it keeps its place', () => {
    const long = 'Draft the notes for 0.1.5 and link every merged change.'
    expect(of({ title: 'Release notes', description: long, draft: true })).toEqual({
      target: 'title="Release notes", draft=true, +1',
      args: `description=${JSON.stringify(`${long.slice(0, 29)}…`)}`,
    })
  })

  it('cuts a first argument too long for the line rather than lose it', () => {
    const { target } = of({ description: 'x'.repeat(90), draft: true })
    expect(target).toMatch(/^description=x+…, \+1$/u)
    expect(target!.length).toBeLessThan(70)
  })

  it('keeps a value a key leaves no room for to at least its ellipsis', () => {
    expect(of({ [`k${'e'.repeat(70)}`]: 'value', b: 1 }).target).toMatch(/^ke+=…, \+1$/u)
  })

  it('reads arguments that still stream as far as their strings have gone', () => {
    expect(mcpArguments('{"owner":"acme","repo":"we')).toEqual({ target: 'owner=acme, repo=we' })
    expect(mcpArguments('{"per_page":3')).toEqual({})
  })
})

describe('the result of an MCP call', () => {
  const of = (value: unknown) => mcpResultRows(JSON.stringify(value))

  it('leaves text that is no JSON list or object as it is', () => {
    expect(mcpResultRows('ENG-212 Selection reset')).toBeUndefined()
    expect(mcpResultRows('42')).toBeUndefined()
    expect(mcpResultRows('null')).toBeUndefined()
  })

  it('reads a list as a row per item, an object by its values in the server\'s order', () => {
    expect(of([{ number: 1423, title: 'Lost selection', state: 'open' }, 'plain', 3])).toEqual({ lines: ['1423 · Lost selection · open', 'plain', '3'], items: 3 })
    expect(of([])).toEqual({ lines: [], items: 0 })
  })

  it('reads an object as a row per field, a list of scalars by its items and what nests as its JSON', () => {
    expect(of({ title: 'one\nline', labels: ['bug', 'ui'], user: { id: 1 }, mixed: [{ a: 1 }] })).toEqual({
      lines: ['title: one line', 'labels: bug, ui', 'user: {"id":1}', 'mixed: [{"a":1}]'],
    })
  })
})
