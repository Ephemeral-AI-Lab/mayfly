/**
 * The repository's static dependency graph: which file a change can reach. Every TypeScript and ESM file under
 * `packages/`, `examples/`, `script/`, and `docs/` is parsed with the TypeScript parser (no type checking) for its imports,
 * re-exports, literal dynamic imports, mocked module paths, and literal data reads (`new URL('<path>', import.meta.url)`,
 * `toMatchFileSnapshot('<path>')`). A workspace package name resolves through its manifest's exports to the
 * `src/<entry>.ts` the built `lib/<entry>.js` comes from, and so does a literal path to a built entry, so a source edit
 * reaches the specs and scripts that load the build. A `cordis.patch.yml` reaches the plugin entries its rows name. The
 * graph is cached under `.artifacts/verify/graph.json` by file size and mtime. @module script/verify/graph
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import ts from 'typescript'
import { parseManifestText } from '../package-contract.mjs'

/** Files the parser reads: TypeScript and ESM sources of the workspace packages, the examples, the scripts, and the design sketch. */
export const CODE_FILE = /^(?:(?:packages|examples)\/[^/]+\/(?!lib\/|node_modules\/).+\.(?:[cm]?ts|tsx|mjs)|(?:script|docs)\/.+\.mjs)$/u
/** A spec vitest runs. */
export const SPEC_FILE = /^(?:packages|examples)\/[^/]+\/tests\/.+\.spec\.ts$/u
/** A repository-workflow test node:test runs. */
export const NODE_TEST_FILE = /^script\/tests\/.+\.test\.mjs$/u

const CACHE_VERSION = 2

/**
 * @typedef {object} Edge
 * @property {string} to - repository-relative target; a directory target ends with `/` and covers every file under it.
 * @property {'value' | 'type' | 'data'} kind - a runtime import, an import only the typecheck reads, or a file read.
 */

/**
 * @typedef {object} FileNode
 * @property {Edge[]} edges - resolved edges.
 * @property {string[]} missing - repository paths an import or read names that do not exist (a deleted file's importers).
 */

/** Tracked and untracked (not ignored) repository files. */
export function repositoryFiles(root) {
  const run = args => execFileSync('git', [...args, '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean)
  return [...new Set([...run(['ls-files']), ...run(['ls-files', '--others', '--exclude-standard'])])]
    .filter(file => existsSync(join(root, file)))
    .sort()
}

/** The workspace packages by name: their directory and manifest exports. */
function workspacePackages(root, files) {
  const packages = new Map()
  for (const file of files) {
    if (!/^(?:packages|examples)\/[^/]+\/package\.json$/u.test(file)) continue
    const manifest = parseManifestText(readFileSync(join(root, file), 'utf8'), file)
    if (typeof manifest.name === 'string') packages.set(manifest.name, { dir: posix.dirname(file), exports: manifest.exports ?? {} })
  }
  return packages
}

const exportTarget = value => typeof value === 'string' ? value : value !== null && typeof value === 'object' && typeof value.default === 'string' ? value.default : undefined

/** The resolver a graph build shares: repository paths, built entries mapped to their sources, workspace package names. */
function createResolver(root, files) {
  const present = new Set(files)
  const packages = workspacePackages(root, files)
  /** A built entry `<pkg>/lib/<name>.js` is the bundle of `<pkg>/src/<name>.ts`. */
  const fromBuild = path => {
    const match = /^((?:packages|examples)\/[^/]+)\/lib\/([^/]+)\.js$/u.exec(path)
    return match === null ? undefined : `${match[1]}/src/${match[2]}.ts`
  }
  /** The existing file a repository path names, trying the extensions an ESM TypeScript import may leave out or swap. */
  const existing = path => {
    const candidates = [path]
    if (/\.js$/u.test(path)) candidates.push(path.replace(/\.js$/u, '.ts'), path.replace(/\.js$/u, '.tsx'))
    else if (/\.mjs$/u.test(path)) candidates.push(path.replace(/\.mjs$/u, '.mts'))
    else if (!/\.[a-z]+$/u.test(path)) candidates.push(`${path}.ts`, `${path}.tsx`, `${path}.mjs`, `${path}.js`, `${path}/index.ts`)
    const built = fromBuild(path)
    if (built !== undefined) candidates.push(built)
    return candidates.find(candidate => present.has(candidate))
  }
  /** A workspace package specifier through its manifest exports. */
  const packageTarget = specifier => {
    for (const [name, pkg] of packages) {
      if (specifier !== name && !specifier.startsWith(`${name}/`)) continue
      const subpath = specifier === name ? '.' : `./${specifier.slice(name.length + 1)}`
      const target = exportTarget(pkg.exports[subpath])
      return target === undefined ? undefined : posix.normalize(`${pkg.dir}/${target}`)
    }
    return undefined
  }
  /** Whether a repository path is a directory that holds files. */
  const directories = new Set(files.flatMap(file => file.split('/').slice(0, -1).map((_, index, parts) => `${parts.slice(0, index + 1).join('/')}/`)))
  return {
    present,
    /**
     * Resolve a specifier from a file.
     * @returns {{ to?: string, missing?: string }} the target, the repository path that does not exist, or neither for an
     *   external package.
     */
    resolve(from, specifier) {
      let path
      if (specifier.startsWith('.')) path = posix.normalize(posix.join(posix.dirname(from), specifier))
      else path = packageTarget(specifier)
      if (path === undefined || path === '.' || path.startsWith('../') || path.split('/').includes('node_modules')) return {}
      if (path.endsWith('/') || directories.has(`${path}/`)) return { to: path.endsWith('/') ? path : `${path}/` }
      const to = existing(path)
      return to === undefined ? { missing: path } : { to }
    },
  }
}

const literalText = node => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined
/** The fixed directory a template literal starts with (`assets/${file}` → `assets/`), if any. */
const templatePrefix = node => {
  if (!ts.isTemplateExpression(node)) return undefined
  const head = node.head.text
  const slash = head.lastIndexOf('/')
  return slash < 0 ? undefined : head.slice(0, slash + 1)
}
const isImportMetaUrl = node => ts.isPropertyAccessExpression(node) && node.name.text === 'url' && ts.isMetaProperty(node.expression)
const MOCKS = new Set(['mock', 'doMock', 'unmock', 'importActual', 'importMock'])

/** The raw references of one source file: specifiers by kind, and literal data paths. */
function scanSource(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, /\.mjs$/u.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS)
  const refs = []
  const add = (specifier, kind) => {
    if (specifier === undefined || (kind === 'data' && /^[a-z][a-z0-9+.-]*:/iu.test(specifier))) return
    // A URL or snapshot path is relative to the file even without `./`; a module specifier without it is a package.
    refs.push({ specifier: kind === 'data' && !specifier.startsWith('.') && !specifier.startsWith('/') ? `./${specifier}` : specifier, kind })
  }
  const visit = node => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      const typeOnly = clause !== undefined && (clause.isTypeOnly || (clause.name === undefined && clause.namedBindings !== undefined
        && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.every(element => element.isTypeOnly)))
      add(literalText(node.moduleSpecifier), typeOnly ? 'type' : 'value')
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      add(literalText(node.moduleSpecifier), node.isTypeOnly ? 'type' : 'value')
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(literalText(node.moduleReference.expression), node.isTypeOnly ? 'type' : 'value')
    } else if (ts.isCallExpression(node)) {
      const [first] = node.arguments
      const callee = node.expression
      if (first !== undefined && (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require'))) add(literalText(first), 'value')
      else if (first !== undefined && ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'vi' && MOCKS.has(callee.name.text)) add(literalText(first), 'value')
      else if (first !== undefined && ts.isPropertyAccessExpression(callee) && callee.name.text === 'toMatchFileSnapshot') add(literalText(first) ?? templatePrefix(first), 'data')
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && node.arguments?.length === 2 && isImportMetaUrl(node.arguments[1])) {
      add(literalText(node.arguments[0]) ?? templatePrefix(node.arguments[0]), 'data')
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return refs
}

/** The plugin entries the rows of a Cordis patch name (`name: <specifier>`). */
function scanPatch(text) {
  return [...text.matchAll(/^\s*-?\s*name:\s*['"]?([^'"\s#]+)['"]?\s*$/gmu)].map(match => ({ specifier: match[1], kind: 'value' }))
}

/** The edges of one file from its raw references. */
function resolveEdges(resolver, file, refs) {
  const edges = []
  const missing = []
  for (const { specifier, kind } of refs) {
    const resolved = resolver.resolve(file, specifier)
    if (resolved.missing !== undefined) {
      // A deleted `x.ts` is imported as `./x.js` or `./x`.
      missing.push(resolved.missing, ...(/\.js$/u.test(resolved.missing) ? [resolved.missing.replace(/\.js$/u, '.ts')] : /\.[a-z]+$/u.test(resolved.missing) ? [] : [`${resolved.missing}.ts`]))
      continue
    }
    const to = resolved.to
    if (to === undefined || to === file) continue
    // A read of the file's own directory or an ancestor is a base for computed paths, not a dependency on all of it.
    if (to.endsWith('/') && file.startsWith(to)) continue
    // A built entry read as data is loaded code: the source edit reaches the reader like an import.
    const builtCode = kind === 'data' && CODE_FILE.test(to) && !to.endsWith('/')
    edges.push({ to, kind: builtCode ? 'value' : kind })
  }
  return { edges, missing }
}

/**
 * Build the graph of a repository.
 * @param {string} root - the repository root.
 * @param {object} [options]
 * @param {string[]} [options.files] - the repository files (default: tracked and untracked).
 * @param {string | null} [options.cache] - the cache file (default: `.artifacts/verify/graph.json`; null for none).
 * @returns {{ files: string[], nodes: Map<string, FileNode> }}
 */
export function buildGraph(root, { files = repositoryFiles(root), cache = join(root, '.artifacts/verify/graph.json') } = {}) {
  const resolver = createResolver(root, files)
  let cached = {}
  if (cache !== null && existsSync(cache)) {
    try {
      const data = JSON.parse(readFileSync(cache, 'utf8'))
      if (data.version === CACHE_VERSION) cached = data.files
    } catch { cached = {} }
  }
  const scanned = {}
  const nodes = new Map()
  for (const file of files) {
    const patch = file.endsWith('cordis.patch.yml') || /\/presets\/[^/]+\/[^/]+\.patch\.yml$/u.test(file)
    if (!CODE_FILE.test(file) && !patch) continue
    const stat = statSync(join(root, file))
    const key = `${String(stat.size)}:${String(stat.mtimeMs)}`
    const refs = cached[file]?.key === key ? cached[file].refs : patch ? scanPatch(readFileSync(join(root, file), 'utf8')) : scanSource(file, readFileSync(join(root, file), 'utf8'))
    scanned[file] = { key, refs }
    nodes.set(file, resolveEdges(resolver, file, refs))
  }
  if (cache !== null) {
    mkdirSync(dirname(cache), { recursive: true })
    writeFileSync(cache, JSON.stringify({ version: CACHE_VERSION, files: scanned }))
  }
  return { files, nodes }
}

/** Whether an edge target covers a path: the same file, or a directory the path is under. */
export const covers = (target, path) => target === path || (target.endsWith('/') && path.startsWith(target))

/**
 * The files that depend on each changed path, breadth first over value and data edges reversed, with the chain that
 * reached each one. Type-only edges are left out: only the typecheck reads them.
 * @param {{ nodes: Map<string, FileNode> }} graph
 * @param {readonly string[]} changed - repository paths, existing or deleted.
 * @returns {Map<string, string[]>} every reached file (a changed path included) with its chain from a changed path.
 */
export function dependents(graph, changed) {
  const reverse = new Map()
  const prefixes = []
  const link = (path, file) => { const list = reverse.get(path); if (list === undefined) reverse.set(path, [file]); else list.push(file) }
  for (const [file, node] of graph.nodes) {
    for (const edge of node.edges) {
      if (edge.kind === 'type') continue
      if (edge.to.endsWith('/')) prefixes.push([edge.to, file])
      else link(edge.to, file)
    }
    for (const path of node.missing) link(path, file)
  }
  const importers = path => [...reverse.get(path) ?? [], ...prefixes.filter(([dir]) => covers(dir, path)).map(([, file]) => file)]
  const reached = new Map()
  const queue = []
  for (const path of changed) if (!reached.has(path)) { reached.set(path, [path]); queue.push(path) }
  while (queue.length > 0) {
    const path = queue.shift()
    for (const importer of importers(path)) {
      if (reached.has(importer)) continue
      reached.set(importer, [...reached.get(path), importer])
      queue.push(importer)
    }
  }
  return reached
}
