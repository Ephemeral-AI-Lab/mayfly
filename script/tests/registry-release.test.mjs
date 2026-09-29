/** Registry publication transitions without npm side effects. @module script/tests/registry-release */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isStagedRelease, readNpmView, releaseRegistry } from '../registry-release.mjs'

const version = '0.1.1-rc.1'
const packages = ['mayfly-ui', 'mayfly', 'mayfly-cli'].map(name => ({
  name: `@ephemeral-ai/${name}`, version, filename: `${name}.tgz`,
}))

test('only npm 404 signifies an unpublished package', () => {
  assert.equal(readNpmView({ status: 1, stderr: 'npm error code E404' }, 'pkg', 'field'), undefined)
  assert.throws(() => readNpmView({ status: 1, stderr: 'npm error code ENETWORK' }, 'pkg', 'field'), /failed with status 1/u)
  assert.equal(readNpmView({ status: 0, stdout: '\"1.2.3\"' }, 'pkg', 'field'), '1.2.3')
  assert.equal(readNpmView({ status: 0, stdout: '' }, 'pkg', 'field'), undefined)
})

function fixture() {
  const visible = new Map()
  const tags = new Map()
  const calls = []
  const registry = {
    view(spec, field) {
      calls.push(['view', spec, field])
      if (field === 'dist.integrity') return visible.get(spec)
      if (field === 'dist.attestations') return { provenance: true }
      return tags.get(`${spec}:${field}`)
    },
    publish(pkg) {
      calls.push(['publish', pkg.name])
      visible.set(`${pkg.name}@${pkg.version}`, `sha512-${pkg.filename}`)
    },
    addTag(pkg, tag) {
      calls.push(['tag', pkg.name, tag])
      tags.set(`${pkg.name}:dist-tags.${tag}`, pkg.version)
    },
    removeTag(pkg, tag) {
      calls.push(['remove', pkg.name, tag])
      tags.delete(`${pkg.name}:dist-tags.${tag}`)
    },
  }
  return { visible, tags, calls, registry, integrity: pkg => `sha512-${pkg.filename}`, sleep: async () => {} }
}

test('publishes in dependency order and waits beyond the old five-minute visibility window', async () => {
  const world = fixture()
  let delayedReads = 0
  const view = world.registry.view
  world.registry.view = (spec, field) => {
    if (spec === `${packages[2].name}@${version}` && field === 'dist.integrity' && world.visible.has(spec) && delayedReads++ < 21) return undefined
    return view(spec, field)
  }
  await releaseRegistry('publish', packages, { ...world, registry: world.registry, log() {}, warn() {} })
  assert.deepEqual(world.calls.filter(([action]) => action === 'publish').map(([, name]) => name), packages.map(pkg => pkg.name))
  assert.ok(delayedReads > 20)
  const firstPublishCount = world.calls.filter(([action]) => action === 'publish').length
  await releaseRegistry('publish', packages, { ...world, registry: world.registry, log() {}, warn() {} })
  assert.equal(world.calls.filter(([action]) => action === 'publish').length, firstPublishCount)
})

test('a failed second publish resumes without republishing the first immutable package', async () => {
  const world = fixture()
  const publish = world.registry.publish
  let failed = false
  world.registry.publish = (pkg, tag) => {
    if (pkg.name === packages[1].name && !failed) {
      failed = true
      throw new Error('interrupted upload')
    }
    publish(pkg, tag)
  }
  await assert.rejects(releaseRegistry('publish', packages, { ...world, log() {}, warn() {} }), /interrupted upload/u)
  await releaseRegistry('publish', packages, { ...world, log() {}, warn() {} })
  assert.deepEqual(world.calls.filter(([action]) => action === 'publish').map(([, name]) => name), packages.map(pkg => pkg.name))
})

test('lookup failures and immutable integrity conflicts fail before publication or promotion', async () => {
  const world = fixture()
  world.registry.view = () => { throw new Error('registry unavailable') }
  await assert.rejects(releaseRegistry('publish', packages, { ...world, log() {}, warn() {} }), /registry unavailable/u)
  assert.equal(world.calls.length, 0)
  const conflict = fixture()
  conflict.visible.set(`${packages[0].name}@${version}`, 'sha512-different')
  await assert.rejects(releaseRegistry('publish', packages, { ...conflict, log() {}, warn() {} }), /different integrity/u)
  assert.equal(conflict.calls.some(([action]) => action === 'publish'), false)
  await assert.rejects(releaseRegistry('promote', packages, { ...conflict, log() {}, warn() {} }), /integrity differs/u)
  assert.equal(conflict.calls.some(([action]) => action === 'tag'), false)
})

test('promotes only registry artifacts with matching integrity and removes their candidate tags', async () => {
  const world = fixture()
  for (const pkg of packages) {
    world.visible.set(`${pkg.name}@${version}`, `sha512-${pkg.filename}`)
    world.tags.set(`${pkg.name}:dist-tags.candidate`, version)
  }
  await releaseRegistry('promote', packages, { ...world, log() {}, warn() {} })
  assert.equal(world.calls.filter(([action]) => action === 'tag').length, packages.length * 2)
  assert.equal(world.calls.filter(([action]) => action === 'remove').length, packages.length)
  await releaseRegistry('promote', packages, { ...world, log() {}, warn() {} })
  assert.equal(world.calls.filter(([action]) => action === 'tag').length, packages.length * 2)
})

test('recognizes npm staged-publish conflicts and reports approval guidance', async () => {
  assert.equal(isStagedRelease(new Error(`Cannot publish over previously staged version "${version}".`)), true)
  assert.equal(isStagedRelease(new Error('interrupted upload')), false)
  const world = fixture()
  const publish = world.registry.publish
  world.registry.publish = pkg => {
    if (pkg.name === packages[2].name) throw new Error(`npm error 409 Conflict - Cannot publish over previously staged version "${version}".`)
    publish(pkg)
  }
  await assert.rejects(
    releaseRegistry('publish', packages, { ...world, log() {}, warn() {} }),
    /staged on npm, awaiting maintainer approval: .*mayfly-cli@0\.1\.1-rc\.1/u,
  )
  assert.deepEqual(world.calls.filter(([action]) => action === 'publish').map(([, name]) => name), packages.slice(0, 2).map(pkg => pkg.name))
})

test('an approved staged release resumes without republishing immutable versions', async () => {
  const world = fixture()
  const publish = world.registry.publish
  let staged = false
  world.registry.publish = pkg => {
    if (pkg.name === packages[2].name && !staged) {
      staged = true
      throw new Error(`Cannot publish over previously staged version "${version}".`)
    }
    publish(pkg)
  }
  await assert.rejects(releaseRegistry('publish', packages, { ...world, log() {}, warn() {} }), /staged on npm/u)
  const publishCalls = world.calls.filter(([action]) => action === 'publish').length
  world.visible.set(`${packages[2].name}@${version}`, `sha512-${packages[2].filename}`)
  await releaseRegistry('publish', packages, { ...world, log() {}, warn() {} })
  assert.equal(world.calls.filter(([action]) => action === 'publish').length, publishCalls)
})

test('a publish that never becomes visible points at the staged-approval path', async () => {
  const world = fixture()
  world.registry.publish = () => {}
  await assert.rejects(releaseRegistry('publish', packages, { ...world, log() {}, warn() {} }), /a staged release needs maintainer approval/u)
})
