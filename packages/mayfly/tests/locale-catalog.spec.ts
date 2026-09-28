/**
 * Catalog integrity spec: every translator key must exist in a catalog, every
 * catalog key must still be referenced by source, catalogs stay symmetric, and
 * Chinese values keep the English placeholders. The spec imports the real
 * catalogs and resolves source usage through the TypeScript checker, so it
 * fails on both missing and dead keys.
 *
 * @module @ephemeral-ai/mayfly/tests/locale-catalog
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { COMMON_LOCALE } from '../src/frontend/common-locale.ts'
import { INTERACTION_LOCALE } from '../src/interaction/locale.ts'
import { CORE_CONTEXT_HINT_LOCALE } from '../src/core/context-hint-locale.ts'
import { ACTIVITY_LOCALE, BANNER_LOCALE, TRANSCRIPT_LOCALE } from '../src/transcript/locale.ts'
import { analyzeSource } from './locale-scan.ts'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src')
const CATALOG_FILE = /(?:^|\/)(?:[^/]*-)?locale\.ts$/u

const CATALOGS: Readonly<Record<string, { readonly en: Readonly<Record<string, string>>; readonly zh: Readonly<Record<string, string>> }>> = {
  common: COMMON_LOCALE,
  interaction: INTERACTION_LOCALE,
  'core-context-hints': CORE_CONTEXT_HINT_LOCALE,
  transcript: TRANSCRIPT_LOCALE,
  'transcript.banner': BANNER_LOCALE,
  'transcript.activity': ACTIVITY_LOCALE,
}

function sourceFiles(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(full))
    else if (entry.name.endsWith('.ts')) found.push(full)
  }
  return found
}

function placeholders(message: string): string[] {
  return [...message.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu)].map(match => match[1]).sort()
}

const files = sourceFiles(SRC)
const program = ts.createProgram({
  rootNames: files,
  options: {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    allowImportingTsExtensions: true,
    noEmit: true,
    noResolve: true,
    skipLibCheck: true,
  },
})
const scans = files.map(file => {
  const rel = relative(SRC, file)
  return { file, rel, analysis: analyzeSource(program, file, readFileSync(file, 'utf8')) }
})
const sourceLiterals = new Set(scans
  .filter(entry => !CATALOG_FILE.test(entry.rel))
  .flatMap(entry => [...entry.analysis.literals]))

describe('locale catalogs', () => {
  it('keeps every catalog symmetric with consistent placeholders', () => {
    for (const [namespace, catalog] of Object.entries(CATALOGS)) {
      expect(Object.keys(catalog.en).sort(), `${namespace} en/zh keys`).toEqual(Object.keys(catalog.zh).sort())
      for (const key of Object.keys(catalog.zh)) {
        const value = catalog.zh[key] ?? ''
        expect(value.length, `${namespace} zh value for ${JSON.stringify(key)}`).toBeGreaterThan(0)
        expect(placeholders(value), `${namespace} placeholders for ${JSON.stringify(key)}`).toEqual(placeholders(key))
      }
    }
  })

  it('requires every translator key to exist in a catalog', () => {
    const known = new Set(Object.values(CATALOGS).flatMap(catalog => Object.keys(catalog.en)))
    const missing = scans
      .filter(entry => entry.analysis.translatorFile && !CATALOG_FILE.test(entry.rel))
      .flatMap(entry => entry.analysis.translatorKeys
        .filter(literal => !known.has(literal.value))
        .map(literal => `${entry.rel}:${literal.line} ${JSON.stringify(literal.value)}`))
    expect([...new Set(missing)].sort()).toEqual([])
  })

  it('has no dead catalog keys', () => {
    const dead = Object.entries(CATALOGS).flatMap(([namespace, catalog]) => Object.keys(catalog.zh)
      .filter(key => !sourceLiterals.has(key))
      .map(key => `${namespace} ${JSON.stringify(key)}`))
    expect(dead.sort()).toEqual([])
  })

  it('keeps the zh glossary consistent', () => {
    const banned = ['子 Agent', '思考强度', '思考级别', '提供方']
    const offenders = Object.entries(CATALOGS).flatMap(([namespace, catalog]) => Object.entries(catalog.zh)
      .flatMap(([key, value]) => banned
        .filter(term => value.includes(term))
        .map(term => `${namespace} ${JSON.stringify(key)} contains ${term}`)))
    expect(offenders.sort()).toEqual([])
  })
})
