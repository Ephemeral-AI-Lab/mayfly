/** Semantic control addresses and bounded declaration traversal for UI instances.
 * @module @ephemeral-ai/mayfly/core/ui-interaction-tree
 */
import type { MayflyFormAddress, MayflyFormNode, MayflyPagePath, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { deferredUiNodeSource, isDeferredUiNode, materializeDeferredUiNode, materializedDeferredUiNode, MAYFLY_UI_MAX_COLLECTION, MAYFLY_UI_MAX_DEPTH, MAYFLY_UI_MAX_NODES } from './ui-validator.ts'

export interface UiControlAddress { readonly pagePath: MayflyPagePath, readonly controlId: string, readonly itemId?: string }

export function uiControlKey(address: UiControlAddress): string {
  return JSON.stringify([address.pagePath.map(segment => [segment.controlId, segment.itemId]), address.controlId])
}

/** Visit admitted controls without materializing responsive branches or list items. */
export function visitUiControls(node: MayflyUiNode, visit: (node: MayflyUiNode, pagePath: MayflyPagePath) => void, pagePath: MayflyPagePath = [], required?: (node: MayflyUiNode, pagePath: MayflyPagePath) => boolean): void {
  if (isDeferredUiNode(node)) {
    const needsAdmission = required?.(node, pagePath) === true
    const materialized = needsAdmission ? materializeDeferredUiNode(node) : materializedDeferredUiNode(node)
    if (needsAdmission && materialized?.ok === false) throw new Error(materialized.message)
    if (materialized?.ok === true) visitUiControls(materialized.value, visit, pagePath, required)
    return
  }
  visit(node, pagePath)
  switch (node.kind) {
    case 'stack':
      for (const child of node.children) visitUiControls(child.node, visit, child.tab === undefined ? pagePath : [...pagePath, child.tab], required)
      break
    case 'surface':
      visitUiControls(node.child, visit, pagePath, required)
      if (node.footer !== undefined) visitUiControls(node.footer, visit, pagePath, required)
      break
    case 'scroll': visitUiControls(node.child, visit, pagePath, required); break
    case 'list': if (node.empty !== undefined) visitUiControls(node.empty, visit, pagePath, required); break
    case 'empty': if (node.actions !== undefined) visitUiControls(node.actions, visit, pagePath, required); break
    default: break
  }
}

interface UiDeclaration {
  readonly kind: string
  readonly address: UiControlAddress
  readonly fields?: ReadonlyMap<string, string>
}

function data(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
}

/** Read identity metadata only, so deleting a hidden field releases its old draft. */
export function uiDeclarations(source: unknown): { readonly complete: boolean, readonly controls: ReadonlyMap<string, UiDeclaration> } {
  const controls = new Map<string, UiDeclaration>()
  const active = new WeakSet<object>()
  let count = 0
  let complete = true
  const visit = (value: unknown, path: MayflyPagePath, depth: number): void => {
    if (value === null || typeof value !== 'object' || active.has(value) || depth > MAYFLY_UI_MAX_DEPTH || ++count > MAYFLY_UI_MAX_NODES) { complete = false; return }
    active.add(value)
    const kind = data(value, 'kind')
    const id = data(value, 'id')
    if (typeof kind === 'string' && typeof id === 'string') {
      const fields = data(value, 'fields')
      const fieldKinds = new Map<string, string>()
      let knownFields = kind === 'form' && Array.isArray(fields) && fields.length <= MAYFLY_UI_MAX_COLLECTION
      if (knownFields) for (let index = 0; index < (fields as unknown[]).length; index += 1) {
        const field = data(fields, String(index))
        const fieldId = data(field, 'id')
        const fieldKind = data(field, 'kind')
        if (typeof fieldId === 'string' && typeof fieldKind === 'string') fieldKinds.set(fieldId, fieldKind)
        else knownFields = false
      }
      const address = { pagePath: path, controlId: id }
      controls.set(uiControlKey(address), { kind, address, ...(knownFields ? { fields: fieldKinds } : {}) })
    }
    if (kind === 'stack') {
      const children = data(value, 'children')
      if (!Array.isArray(children) || children.length > MAYFLY_UI_MAX_COLLECTION) complete = false
      else for (let index = 0; index < children.length; index += 1) {
        const child = data(children, String(index))
        const tab = data(child, 'tab')
        const controlId = data(tab, 'controlId')
        const itemId = data(tab, 'itemId')
        if (tab !== undefined && (typeof controlId !== 'string' || typeof itemId !== 'string')) { complete = false; continue }
        visit(data(child, 'node'), typeof controlId === 'string' && typeof itemId === 'string' ? [...path, { controlId, itemId }] : path, depth + 1)
      }
    } else if (kind === 'surface' || kind === 'scroll') {
      visit(data(value, 'child'), path, depth + 1)
      const footer = data(value, 'footer')
      if (footer !== undefined) visit(footer, path, depth + 1)
    } else if (kind === 'list' || kind === 'empty') {
      const nested = data(value, kind === 'list' ? 'empty' : 'actions')
      if (nested !== undefined) visit(nested, path, depth + 1)
    }
    active.delete(value)
  }
  visit(source, [], 0)
  return { complete, controls }
}

/** Explicit submission admits only the responsive branches containing its target forms. */
export function prepareUiForms(node: MayflyUiNode, targets: readonly MayflyFormAddress[]): ReadonlyMap<string, MayflyFormNode> {
  const keys = new Set(targets.map(target => uiControlKey({ pagePath: target.pagePath, controlId: target.formId })))
  const forms = new Map<string, MayflyFormNode>()
  visitUiControls(node, (current, pagePath) => {
    if (current.kind !== 'form') return
    const key = uiControlKey({ pagePath, controlId: current.id })
    if (keys.has(key)) forms.set(key, current)
  }, [], (deferred, pagePath) => [...uiDeclarations(deferredUiNodeSource(deferred)).controls.values()].some(declaration =>
    declaration.kind === 'form' && keys.has(uiControlKey({ pagePath: [...pagePath, ...declaration.address.pagePath], controlId: declaration.address.controlId }))))
  if (forms.size !== keys.size) throw new Error('A submitted form is no longer available')
  return forms
}
