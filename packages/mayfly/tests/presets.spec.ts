/**
 * Mayfly's agent-preset declarations: upstream's shipped roster is vendored as
 * patch files while this package contributes exactly one uniquely named
 * creative preset.
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

/** A preset patch's rows, ignoring its leading comment header. */
function rows(source: string): string {
  return source.split('\n').filter(line => !line.startsWith('#') && line.trim() !== '').join('\n')
}

describe('Mayfly preset roster', () => {
  it('declares the upstream roster plus one bundle-local preset named mayfly-cordis', () => {
    const mayflyRoot = new URL('../presets/', import.meta.url)
    const files = readdirSync(mayflyRoot, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.patch.yml'))
      .map(entry => entry.name)
      .sort()
    expect(files).toEqual(['cordis.patch.yml', 'mayfly-cordis.patch.yml', 'minimal.patch.yml', 'ptc.patch.yml', 'standard.patch.yml'])
    const declaration = readFileSync(new URL('mayfly-cordis.patch.yml', mayflyRoot), 'utf8')
    expect(declaration).toContain("name: '@deepseek-ai/dsh-agent-preset'")
    expect(declaration).toContain('id: mayfly-cordis')
    expect(declaration).toContain('name: Mayfly Cordis')
    expect(declaration).toContain('order: 5')
  })

  it('lists every preset patch in the bundle manifest after the host patch', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      readonly dsh?: { readonly bundle?: { readonly patch?: unknown } }
    }
    expect(manifest.dsh?.bundle?.patch).toEqual([
      './cordis.patch.yml',
      './presets/standard.patch.yml',
      './presets/ptc.patch.yml',
      './presets/minimal.patch.yml',
      './presets/cordis.patch.yml',
      './presets/mayfly-cordis.patch.yml',
    ])
  })

  it('vendors the shipped presets verbatim and adds mayfly-cordis without aliases', () => {
    const upstreamRoot = join(dirname(require.resolve('@deepseek-ai/dsh-web-app/package.json')), 'presets')
    const mayflyRoot = new URL('../presets/', import.meta.url)
    for (const id of ['standard', 'ptc', 'minimal', 'cordis']) {
      const upstream = readFileSync(join(upstreamRoot, `${id}.patch.yml`), 'utf8')
      const mayfly = readFileSync(new URL(`${id}.patch.yml`, mayflyRoot), 'utf8')
      expect(rows(mayfly), `presets/${id}.patch.yml must match the upstream declaration`).toBe(rows(upstream))
      expect(mayfly).toContain(`id: ${id}\n`)
    }

    const mayfly = readFileSync(new URL('mayfly-cordis.patch.yml', mayflyRoot), 'utf8')
    const upstreamCordis = readFileSync(join(upstreamRoot, 'cordis.patch.yml'), 'utf8')
    for (const alphaRow of ['- id: command-goal', 'modelSelectionSettings: true', 'fetch: true']) {
      expect(upstreamCordis).toContain(alphaRow)
      expect(mayfly).toContain(alphaRow)
    }
    expect(mayfly).toContain('agent preset id `mayfly-cordis`')
    // The creative preset shares the shipped row set; only the persona, the
    // Cordis toolset, and the skills wiring differ.
    for (const rowId of ['persona', 'agent-instructions', 'tool-cordis', 'skill-filesystem', 'tool-skill', 'tool-plugin-manager']) {
      expect(mayfly).toContain(`- id: ${rowId}`)
    }
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
    const composition = readFileSync(new URL('../mayfly-cordis.patch.yml', presetRoot), 'utf8')
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
