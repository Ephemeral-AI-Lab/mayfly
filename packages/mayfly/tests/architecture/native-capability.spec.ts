/**
 * Architecture guard for native-first capability ownership: every projection key,
 * service, and registration must name a native or Mayfly-owned capability, and
 * the terminal must not guess host internals or keep a parallel session store.
 *
 * The allowlists are the contract in `docs/native-capability-map.md`; a new key,
 * service, or command name is added there and here together.
 * @module architecture/native-capability
 */

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const sourceRoot = resolve(root, 'src')

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
])

/** Mayfly-owned projection keys, each justified in the capability map. */
const MAYFLY_PROJECTIONS = new Set([
  'mayflyConversation',
  'mayflyConversationFacts',
  'mayflyDeliverables',
])

/** Native services, plus the one explicit durable read `/save` needs. */
const NATIVE_SERVICES = new Set([
  'agentDefaultModel',
  'agentPresets',
  'agents',
  'appExit',
  'attachments',
  'authorization',
  'cmdlineArgs',
  'commands',
  'credentials',
  'deepseekAccount',
  'fileReferences',
  'fs',
  'goals',
  'jobs',
  'llm',
  'loader',
  'permissionPresets',
  'pluginManager',
  'schedule',
  'sessionController',
  'sessionPersistence',
  'sessionProjections',
  'sessionQuery',
  'sessions',
  'settings',
  'skills',
  'subagents',
  'tools',
  'userQuestions',
  'webServer',
  'workspaceChanges',
  'workspaceRegistry',
])

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

/** Native command names Mayfly must never register. */
const NATIVE_COMMANDS = new Set(['permission', 'export', 'plan', 'goal', 'compact', 'feedback'])

/** Command names this suite uses to prove the allowlist is live. */
const MAYFLY_ONLY_COMMANDS = ['permissions', 'save'] as const

/** Fields the presentation-only facts projection no longer carries. */
const REMOVED_FACT_FIELDS = ['todos', 'contextTokens', 'contextWindow', 'flowUp', 'reasoningEffort'] as const

/** The operation paths that must resolve the working directory through the projection. */
const OPERATION_PATHS = [
  'interaction/skills-catalog.ts',
  'interaction/editor-plus.ts',
  'interaction/deliverables-command.ts',
  'interaction/session-export.ts',
  'transcript/status-cwd.ts',
  'transcript/status-git.ts',
]

/** Source with comments removed, so a rule reads code and not prose. */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, match => match.replace(/[^\n]/gu, ' '))
    .replace(/\/\/[^\n]*/gu, '')
}

/** Every `.ts` file under `src`, recursively. */
function sourceFiles(directory = sourceRoot): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (entry.name.endsWith('.ts')) files.push(path)
  }
  return files
}

/** The source text of every file, keyed by its path. */
function sources(): ReadonlyMap<string, string> {
  return new Map(sourceFiles().map(path => [path, codeOf(readFileSync(path, 'utf8'))]))
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

/** Projection keys used by `snapshot`, `stateOf`, or `onChanged` calls. */
function projectionKeys(code: string): string[] {
  const keys = new Set<string>()
  for (const method of ['snapshot', 'stateOf', 'onChanged']) {
    for (const call of callsIn(code, new RegExp(`(?:sessionProjections|projections)\\??\\.${method}\\(`, 'gu'))) {
      for (const key of literals(call)) keys.add(key)
    }
  }
  return [...keys]
}

/** Constant key arrays that name projections (`SESSION_INFO_KEYS`, `CONTEXT_KEYS`, `MODE_KEYS`, …). */
function constantKeys(code: string): string[] {
  const keys = new Set<string>()
  for (const match of code.matchAll(/const [A-Z][A-Z_]*KEYS\s*=\s*(?:new Set\()?\[([\s\S]*?)\]/gu)) {
    const values = literals(match[1]!)
    // Key-grammar constants also end in KEYS; only arrays naming projections are in scope.
    if (values.filter(value => isAllowedProjection(value)).length < 2) continue
    for (const key of values) keys.add(key)
  }
  return [...keys]
}

/** Service names read through `ctx.get`, injection arrays, or `ctx.inject`. */
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

/** Registered Mayfly command names. */
function commandNames(code: string): string[] {
  const names = new Set<string>()
  for (const call of [...callsIn(code, /commands\.register\(/gu), ...callsIn(code, /registerOwnedCommand\(/gu)]) {
    const match = /name:\s*'([^']+)'/u.exec(call)
    if (match !== null) names.add(match[1]!)
  }
  return [...names]
}

/** Whether a projection key is native or Mayfly-owned. */
function isAllowedProjection(key: string): boolean {
  return NATIVE_PROJECTIONS.has(key) || MAYFLY_PROJECTIONS.has(key)
}

/** Whether a service is native, Cordis infrastructure, or Mayfly's. */
function isAllowedService(name: string): boolean {
  return NATIVE_SERVICES.has(name) || CORDIS_MEMBERS.has(name) || /^mayfly[A-Z]/u.test(name)
}

/** Whether a Mayfly command name collides with a native command. */
function isNativeCommand(name: string): boolean {
  return NATIVE_COMMANDS.has(name)
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

describe('native capability ownership', () => {
  it('reads only native projections and the three justified Mayfly keys', () => {
    const found = new Set<string>()
    for (const code of sources().values()) for (const key of projectionKeys(code)) found.add(key)
    const unknown = [...found].filter(key => !isAllowedProjection(key))
    expect(unknown).toEqual([])
    for (const code of sources().values()) {
      for (const key of constantKeys(code)) expect(isAllowedProjection(key), key).toBe(true)
    }
    // Mayfly registers only the three justified keys.
    const conversation = resolve(sourceRoot, 'conversation')
    for (const path of sourceFiles(conversation)) {
      const code = codeOf(readFileSync(path, 'utf8'))
      for (const match of code.matchAll(/key:\s*'([^']+)'/gu)) expect(MAYFLY_PROJECTIONS, path).toContain(match[1]!)
    }
    // The allowlist itself stays live: both halves are used.
    expect([...found].some(key => NATIVE_PROJECTIONS.has(key))).toBe(true)
    expect([...found].some(key => MAYFLY_PROJECTIONS.has(key))).toBe(true)
  })

  it('uses only native services, Cordis infrastructure, or Mayfly services', () => {
    const found = new Set<string>()
    for (const code of sources().values()) for (const name of serviceNames(code)) found.add(name)
    const unknown = [...found].filter(name => !isAllowedService(name))
    expect(unknown).toEqual([])
  })

  it('registers no native command name and keeps /permissions and /save Mayfly-only', () => {
    const names = new Set<string>()
    for (const code of sources().values()) for (const name of commandNames(code)) names.add(name)
    expect([...names].filter(isNativeCommand)).toEqual([])
    for (const name of MAYFLY_ONLY_COMMANDS) expect(names, name).toContain(name)
    expect(names).not.toContain('permission')
    expect(names).not.toContain('export')
  })

  it('never writes the profile patch, guesses FiberState/MCP numbers, or names old delegation modes', () => {
    for (const [path, code] of sources()) {
      expect(code, path).not.toMatch(/\bFiberState\b|\bfiberState\b/u)
      expect(code, path).not.toMatch(/\bstarted subagent\b|\brun_in_background\b|\bbackgroundMode\b/u)
      expect(code, path).not.toMatch(/(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|rename|renameSync|copyFile|copyFileSync)\([^)]*cordis\.patch\.yml/su)
      expect(code, path).not.toMatch(/\$DSH_HOME[\s\S]{0,120}cordis\.patch\.yml/u)
    }
  })

  it('resolves the working directory through the projection in current-operation paths', () => {
    for (const relative of OPERATION_PATHS) {
      const code = codeOf(readFileSync(resolve(sourceRoot, relative), 'utf8'))
      expect(code, relative).not.toContain('.header.cwd')
      expect(code, relative).toMatch(/agentDirectory|sessionDirectory|workingDirectory/u)
    }
  })

  it('browses sessions through the native controller, never persistence or the projection cache', () => {
    for (const [path, code] of sources()) {
      expect(code, path).not.toContain('sessionProjectionCache')
      expect(code, path).not.toContain('readColdSessionLog')
      if (!path.endsWith('interaction/session-export.ts')) expect(code, path).not.toContain('sessionPersistence')
    }
    const listing = codeOf(readFileSync(resolve(sourceRoot, 'interaction/session-list-reads.ts'), 'utf8'))
    expect(listing).toContain('sessionController')
    expect(listing).not.toContain('sessionPersistence')
  })

  it('keeps mayflyConversationFacts free of removed domain fields', () => {
    const facts = codeOf(readFileSync(resolve(sourceRoot, 'conversation/facts.ts'), 'utf8'))
    const types = codeOf(readFileSync(resolve(sourceRoot, 'conversation/types.ts'), 'utf8'))
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

  it('reads code, not comments', () => {
    expect(codeOf("// run_in_background and FiberState are prose\nconst a = 1")).not.toMatch(/run_in_background|FiberState/u)
    expect(projectionKeys(codeOf("// sessionProjections.snapshot(session, ['bogus'])\nconst a = 1"))).toEqual([])
  })
})
