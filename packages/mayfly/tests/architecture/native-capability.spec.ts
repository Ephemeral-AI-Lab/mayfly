/**
 * Architecture guard for native-first capability ownership across the split.
 * The Host plugin runs in the dsh process: every service it reads, projection
 * key it reads or registers, and command it registers must name a native or
 * Mayfly-owned capability. The TUI runs its own Cordis tree: it reads only
 * official Client projection faces of those keys, and its frontend commands
 * never take a native Host command's name.
 *
 * The allowlists are the contract in `docs/native-capability-map.md`; a new key,
 * service, or command name is added there and here together.
 * @module architecture/native-capability
 */

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const tuiRoot = resolve(import.meta.dirname, '../../src')
const hostRoot = resolve(import.meta.dirname, '../../../host/src')

/** Native projection keys Mayfly is allowed to read. */
const NATIVE_PROJECTIONS = new Set([
  'title',
  'goal',
  'todos',
  'plan',
  'permissions',
  'userQuestions',
  'subagentCatalog',
  'subagentTiming',
  'subagent',
  'modelSelection',
  'workingDirectory',
  'sessionStats',
  'tokenUsage',
  'contextPressure',
  'contextBreakdown',
  'sessionListMetadata',
  'agentPreset',
  'inbox',
  'imageLimits',
  'turnOutline',
])

/** Mayfly-owned projection keys the Host registers, each justified in the capability map. */
const MAYFLY_PROJECTIONS = new Set([
  'mayflyConversation',
  'mayflyConversationFacts',
  'mayflyDeliverables',
  'mayflyJobs',
  'mayflyWorkflow',
  'mayflyRetraction',
])

/** The native services the Host plugin reads, exactly. */
const HOST_SERVICES = new Set([
  'agentDefaultModel',
  'agents',
  'appExit',
  'approval',
  'authorization',
  'connection',
  'credentials',
  'fs',
  'invocation',
  'llm',
  'mcpResources',
  'permissionPresets',
  'profileContext',
  'sessionController',
  'sessionProjections',
  'sessionQuery',
  'sessions',
  'settings',
  'shell',
  'skills',
  'subagents',
  'tools',
  'webApp',
  'workspaceChanges',
  'workspaceRegistry',
])

/** The official Client services the TUI reads from its own tree, exactly. */
const CLIENT_SERVICES = new Set(['connection', 'remote', 'fileUpload', 'sessions', 'workspaces'])

/** Cordis members a plugin may use on `ctx` without asking a capability map. */
const CORDIS_MEMBERS = new Set([
  'accessor',
  'dispose',
  'effect',
  'emit',
  'fiber',
  'get',
  'has',
  'inject',
  'is',
  'loader',
  'logger',
  'on',
  'plugin',
  'provide',
  'reflect',
  'registry',
  'root',
  'runtime',
  'scope',
  'set',
])

/**
 * Native Host command names a frontend command never takes. `/plan` (sessionless
 * startup intent) and `/export` (a local file) are documented frontend commands.
 */
const NATIVE_COMMANDS = new Set(['permission', 'goal', 'compact', 'feedback'])

/** Frontend command names that prove the allowlist is live. */
const MAYFLY_ONLY_COMMANDS = ['permissions', 'save'] as const

/** Fields the presentation-only facts projection no longer carries. */
const REMOVED_FACT_FIELDS = ['todos', 'contextTokens', 'contextWindow', 'flowUp', 'reasoningEffort'] as const

/** Host files that read the immutable header directory: workspace identity, and the fallback without a working-directory service. */
const HEADER_CWD_READERS = ['remote/stats.ts', 'remote/session.ts']

/** Source with comments removed, so a rule reads code and not prose. */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, match => match.replace(/[^\n]/gu, ' '))
    .replace(/\/\/[^\n]*/gu, '')
}

/** Every `.ts` file under `directory`, recursively. */
function sourceFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (entry.name.endsWith('.ts')) files.push(path)
  }
  return files
}

/** The source text of every file under `directory`, keyed by its path. */
function sources(directory: string): ReadonlyMap<string, string> {
  return new Map(sourceFiles(directory).map(path => [path, codeOf(readFileSync(path, 'utf8'))]))
}

/** The single-quoted string literals in `text`. */
function literals(text: string): string[] {
  return [...text.matchAll(/'([^'\\]*(?:\\.[^'\\]*)*)'/gu)].map(match => match[1]!)
}

/**
 * The complete call text starting at the first `(` after each match, with
 * balanced parentheses and string/template contents skipped.
 */
function callsIn(code: string, pattern: RegExp): string[] {
  const calls: string[] = []
  const finder = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  for (let match = finder.exec(code); match !== null; match = finder.exec(code)) {
    // The pattern ends at the opening parenthesis this call scans from.
    let index = finder.lastIndex
    let depth = 1
    while (index < code.length) {
      const character = code[index]!
      if (character === "'" || character === '"') {
        const quote = character
        index += 1
        while (index < code.length && code[index] !== quote) index += code[index] === '\\' ? 2 : 1
        index += 1
        continue
      }
      if (character === '`') {
        index += 1
        while (index < code.length && code[index] !== '`') index += code[index] === '\\' ? 2 : 1
        index += 1
        continue
      }
      if (character === '(') depth += 1
      else if (character === ')') {
        depth -= 1
        if (depth === 0) { index += 1; break }
      }
      index += 1
    }
    calls.push(code.slice(match.index, index))
    finder.lastIndex = index
  }
  return calls
}

/** Projection keys a Host plugin reads through `sessionProjections`. */
function hostProjectionKeys(code: string): string[] {
  const keys = new Set<string>()
  for (const method of ['snapshot', 'stateOf', 'onChanged']) {
    for (const call of callsIn(code, new RegExp(`(?:sessionProjections|projections)\\??\\.${method}\\(`, 'gu'))) {
      for (const key of literals(call)) keys.add(key)
    }
  }
  return [...keys]
}

/** Projection keys the TUI reads through official Client faces, and constant key arrays naming projections. */
function tuiProjectionKeys(code: string): string[] {
  const keys = new Set<string>()
  for (const match of code.matchAll(/faceOf\('([^']+)'\)/gu)) keys.add(match[1]!)
  for (const match of code.matchAll(/const [A-Z][A-Z_]*KEYS\s*=\s*(?:new Set\()?\[([\s\S]*?)\]/gu)) {
    const values = literals(match[1]!)
    // Key-grammar constants also end in KEYS; only arrays naming projections are in scope.
    if (values.filter(value => isAllowedProjection(value)).length < 2) continue
    for (const key of values) keys.add(key)
  }
  return [...keys]
}

/** Projection keys a Host definition registers. */
function registeredKeys(code: string): string[] {
  return [...code.matchAll(/Projection(?:Definition)?(?::\s*\w+)?\s*=\s*\{\s*key:\s*'([^']+)'/gu)].map(match => match[1]!)
}

/** Service names read through `ctx.get`, injection arrays, `ctx.inject`, or a `ctx` member. */
function serviceNames(code: string): string[] {
  const names = new Set<string>()
  for (const match of code.matchAll(/ctx\.get\('([^']+)'\)/gu)) names.add(match[1]!)
  for (const match of code.matchAll(/(?:export const inject|inject\s*:)\s*(?:=\s*)?\[([\s\S]*?)\]/gu)) {
    for (const name of literals(match[1]!)) names.add(name)
  }
  for (const match of code.matchAll(/ctx\.inject\(\[([\s\S]*?)\]/gu)) {
    for (const name of literals(match[1]!)) names.add(name)
  }
  for (const match of code.matchAll(/\bctx\.([a-zA-Z_$][\w$]*)/gu)) {
    if (!CORDIS_MEMBERS.has(match[1]!)) names.add(match[1]!)
  }
  return [...names]
}

/** Registered command names. */
function commandNames(code: string): string[] {
  const names = new Set<string>()
  for (const call of callsIn(code, /commands\.register\(/gu)) {
    const match = /name:\s*'([^']+)'/u.exec(call)
    if (match !== null) names.add(match[1]!)
  }
  return [...names]
}

/** Whether a projection key is native or Mayfly-owned. */
function isAllowedProjection(key: string): boolean {
  return NATIVE_PROJECTIONS.has(key) || MAYFLY_PROJECTIONS.has(key)
}

/** The `{ ... }` body of an interface or object literal after `marker`. */
function bodyAfter(code: string, marker: RegExp): string {
  const match = marker.exec(code)
  if (match === null) return ''
  let index = code.indexOf('{', match.index + match[0].length)
  if (index < 0) return ''
  let depth = 0
  const start = index
  while (index < code.length) {
    if (code[index] === '{') depth += 1
    else if (code[index] === '}') {
      depth -= 1
      if (depth === 0) return code.slice(start, index + 1)
    }
    index += 1
  }
  return code.slice(start)
}

describe('Host native capability ownership', () => {
  it('reads only native projections and the Mayfly keys, and registers exactly the Mayfly keys', () => {
    const read = new Set<string>()
    const registered: string[] = []
    for (const code of sources(hostRoot).values()) {
      for (const key of hostProjectionKeys(code)) read.add(key)
      registered.push(...registeredKeys(code))
    }
    expect([...read].filter(key => !isAllowedProjection(key))).toEqual([])
    expect([...read].some(key => NATIVE_PROJECTIONS.has(key))).toBe(true)
    expect(registered.toSorted()).toEqual([...MAYFLY_PROJECTIONS].toSorted())
  })

  it('uses exactly the mapped native services, Cordis infrastructure, or Mayfly services', () => {
    const found = new Set<string>()
    for (const code of sources(hostRoot).values()) for (const name of serviceNames(code)) found.add(name)
    expect([...found].filter(name => !HOST_SERVICES.has(name) && !CORDIS_MEMBERS.has(name) && !/^mayfly[A-Z]/u.test(name))).toEqual([])
    expect([...HOST_SERVICES].filter(name => !found.has(name))).toEqual([])
  })

  it('registers no native command', () => {
    for (const [path, code] of sources(hostRoot)) expect(commandNames(code), path).toEqual([])
  })

  it('reads the working directory through the projection, and the header only for workspace identity or its fallback', () => {
    for (const [path, code] of sources(hostRoot)) {
      if (!code.includes('.header.cwd')) continue
      expect(HEADER_CWD_READERS.some(relative => path.endsWith(relative)), path).toBe(true)
    }
    const session = codeOf(readFileSync(resolve(hostRoot, 'remote/session.ts'), 'utf8'))
    expect(session).toMatch(/sessionProjections\.snapshot\(session, \['workingDirectory'\]\)\.values\.workingDirectory \?\? session\.header\.cwd/u)
  })

  it('keeps mayflyConversationFacts free of removed domain fields', () => {
    const facts = codeOf(readFileSync(resolve(hostRoot, 'conversation/facts.ts'), 'utf8'))
    const types = codeOf(readFileSync(resolve(hostRoot, 'conversation/types.ts'), 'utf8'))
    const schema = bodyAfter(facts, /conversationFactsSchema\s*=\s*z\.object/u)
    const shape = bodyAfter(types, /export interface ConversationFacts\s*/u)
    expect(schema).not.toBe('')
    expect(shape).not.toBe('')
    for (const field of REMOVED_FACT_FIELDS) {
      expect(schema, field).not.toMatch(new RegExp(`\\b${field}\\??\\s*:`, 'u'))
      expect(shape, field).not.toMatch(new RegExp(`\\b${field}\\??\\s*:`, 'u'))
    }
    for (const field of ['model', 'provider']) {
      expect(shape, field).not.toMatch(new RegExp(`\\b${field}\\??\\s*:`, 'u'))
    }
  })
})

describe('TUI native capability ownership', () => {
  it('reads only native and Host-registered Mayfly projection faces', () => {
    const found = new Set<string>()
    for (const code of sources(tuiRoot).values()) for (const key of tuiProjectionKeys(code)) found.add(key)
    expect([...found].filter(key => !isAllowedProjection(key))).toEqual([])
    expect([...found].some(key => NATIVE_PROJECTIONS.has(key))).toBe(true)
    expect([...found].some(key => MAYFLY_PROJECTIONS.has(key))).toBe(true)
  })

  it('uses exactly the official Client services, Cordis infrastructure, and Mayfly services in its own tree', () => {
    const found = new Set<string>()
    for (const code of sources(tuiRoot).values()) for (const name of serviceNames(code)) found.add(name)
    expect([...found].filter(name => !CLIENT_SERVICES.has(name) && !CORDIS_MEMBERS.has(name) && !/^mayfly[A-Z]/u.test(name))).toEqual([])
    expect([...CLIENT_SERVICES].filter(name => !found.has(name))).toEqual([])
  })

  it('never takes a native Host command name and keeps /permissions and /save Mayfly-only', () => {
    const names = new Set<string>()
    for (const code of sources(tuiRoot).values()) for (const name of commandNames(code)) names.add(name)
    expect([...names].filter(name => NATIVE_COMMANDS.has(name))).toEqual([])
    for (const name of MAYFLY_ONLY_COMMANDS) expect(names, name).toContain(name)
  })
})

describe('both halves', () => {
  it('never write the profile patch, guess FiberState/MCP numbers, or name old delegation modes', () => {
    for (const [path, code] of [...sources(hostRoot), ...sources(tuiRoot)]) {
      expect(code, path).not.toMatch(/\bFiberState\b|\bfiberState\b/u)
      expect(code, path).not.toMatch(/\bstarted subagent\b|\brun_in_background\b|\bbackgroundMode\b/u)
      expect(code, path).not.toMatch(/(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|rename|renameSync|copyFile|copyFileSync)\([^)]*cordis\.patch\.yml/su)
      expect(code, path).not.toMatch(/\$DSH_HOME[\s\S]{0,120}cordis\.patch\.yml/u)
    }
  })

  it('browse sessions through the native controller, never persistence or the projection cache', () => {
    for (const [path, code] of [...sources(hostRoot), ...sources(tuiRoot)]) {
      expect(code, path).not.toContain('sessionProjectionCache')
      expect(code, path).not.toContain('readColdSessionLog')
      expect(code, path).not.toContain('sessionPersistence')
    }
  })

  it('read code, not comments', () => {
    expect(codeOf("// run_in_background and FiberState are prose\nconst a = 1")).not.toMatch(/run_in_background|FiberState/u)
    expect(hostProjectionKeys(codeOf("// sessionProjections.snapshot(session, ['bogus'])\nconst a = 1"))).toEqual([])
    expect(tuiProjectionKeys(codeOf("// faceOf('bogus')\nconst a = 1"))).toEqual([])
  })
})
