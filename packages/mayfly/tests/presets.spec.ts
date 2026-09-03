/**
 * Mayfly's bundle-local preset root: upstream owns its shipped roster while
 * this package contributes exactly one uniquely named creative preset.
 *
 * @module @ephemeral-ai/mayfly/tests/presets
 */

import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

interface SkillFrontmatter {
  readonly name?: unknown
  readonly description?: unknown
}

interface AuthorSkillEvals {
  readonly skill?: unknown
  readonly preset?: unknown
  readonly cases?: readonly { readonly id?: unknown }[]
}

const require = createRequire(import.meta.url)
const skillFilesystemRoot = dirname(require.resolve('@deepseek-ai/dsh-skill-filesystem/package.json'))
const { parse } = createRequire(join(skillFilesystemRoot, 'package.json'))('yaml') as {
  parse(source: string): unknown
}

function skillFrontmatter(source: string): SkillFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source)
  expect(match, 'skill must start with YAML frontmatter').not.toBeNull()
  return parse(match![1]!) as SkillFrontmatter
}

describe('Mayfly preset roster', () => {
  it('ships exactly one bundle-local preset named mayfly-cordis', () => {
    const mayflyRoot = new URL('../presets/', import.meta.url)
    const ids = readdirSync(mayflyRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
    expect(ids).toEqual(['mayfly-cordis'])
    const metadata = readFileSync(new URL('mayfly-cordis/preset.yml', mayflyRoot), 'utf8')
    expect(metadata).toContain('name: Mayfly Cordis')
    expect(metadata).toContain('order: 5')
  })

  it('uses alpha.2 shipped presets and adds mayfly-cordis without aliases', () => {
    const harnessRoot = join(dirname(require.resolve('@deepseek-ai/dsh-agent-presets/package.json')), 'presets')
    const mayflyRoot = new URL('../presets/', import.meta.url)
    const shipped = readdirSync(harnessRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
    expect(shipped).toEqual(['cordis', 'minimal', 'ptc', 'standard'])
    expect([...shipped, 'mayfly-cordis'].sort()).toEqual(['cordis', 'mayfly-cordis', 'minimal', 'ptc', 'standard'])
    expect(shipped).not.toContain('code')

    const upstream = readFileSync(join(harnessRoot, 'cordis', 'agent.cordis.yml'), 'utf8')
    const mayfly = readFileSync(new URL('mayfly-cordis/agent.cordis.yml', mayflyRoot), 'utf8')
    for (const alphaRow of ['- id: command-goal', 'modelSelectionSettings: true', 'fetch: true']) {
      expect(upstream).toContain(alphaRow)
      expect(mayfly).toContain(alphaRow)
    }
    expect(mayfly).toContain('agent preset id `mayfly-cordis`')
  })

  it('ships discoverable creative skills with valid frontmatter', () => {
    const skillsRoot = new URL('../presets/mayfly-cordis/skills/', import.meta.url)
    const directories = readdirSync(skillsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()

    expect(directories).toEqual([
      'cordis-plugin-development',
      'editing-cordis-compositions',
      'mayfly-plugin-development',
    ])
    for (const directory of directories) {
      const frontmatter = skillFrontmatter(readFileSync(new URL(`${directory}/SKILL.md`, skillsRoot), 'utf8'))
      expect(frontmatter.name).toBe(directory)
      expect(typeof frontmatter.description).toBe('string')
      expect((frontmatter.description as string).trim().length).toBeGreaterThan(0)
    }
  })

  it('ships the direct-service author skill and its five authority evals', () => {
    const skillRoot = new URL('../presets/mayfly-cordis/skills/mayfly-plugin-development/', import.meta.url)
    const source = readFileSync(new URL('SKILL.md', skillRoot), 'utf8')
    const evals = JSON.parse(readFileSync(new URL('evals.json', skillRoot), 'utf8')) as AuthorSkillEvals

    for (const service of ['commands', 'sessionProjections', 'tools', 'mayflyPanes', 'mayflyStatus', 'mayflyOverlays', 'mayflyEditorExtensions', 'mayflyCurrentAgent']) {
      expect(source).toContain(`${service}`)
    }
    expect(source).toContain('ordinary Cordis plugin')
    expect(source).toContain('npm pack --dry-run')
    expect(evals.skill).toBe('mayfly-plugin-development')
    expect(evals.preset).toBe('mayfly-cordis')
    expect(evals.cases?.map(value => value.id)).toEqual([
      'accepted-new-local-plugin',
      'existing-harness-plugin-entry',
      'native-service',
      'unsupported-renderer',
      'accepted-does-not-authorize-publish',
    ])
    expect(source).toContain('Audit an existing package')
  })

  it('routes preset skills by task and excludes Mayfly repository maintenance', () => {
    const presetRoot = new URL('../presets/mayfly-cordis/', import.meta.url)
    const composition = readFileSync(new URL('agent.cordis.yml', presetRoot), 'utf8')
    const editing = readFileSync(new URL('skills/editing-cordis-compositions/SKILL.md', presetRoot), 'utf8')

    expect(composition).toContain('only after the user requests a durable external package')
    expect(composition).toContain('Do not load either plugin-development skill')
    expect(composition).not.toMatch(/mayfly-plugin-development[^\n]*changing Mayfly code/u)
    expect(editing).toContain('outside every preset author skill')
  })

  it('carries only runtime composition dependencies', () => {
    const bundle = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      readonly dependencies?: Readonly<Record<string, string>>
    }
    expect(Object.keys(bundle.dependencies ?? {}).filter(name => name.startsWith('@ephemeral-ai/')).sort()).toEqual([
      '@ephemeral-ai/mayfly-ui',
    ])
  })
})
