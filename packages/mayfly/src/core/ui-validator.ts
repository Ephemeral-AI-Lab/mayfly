/**
 * Canonical admission for renderer-neutral Mayfly UI wire trees. The validator
 * copies only known fields, strips terminal controls, enforces quotas, and
 * recursively freezes its output before the renderer sees it.
 *
 * @module @ephemeral-ai/mayfly/core/ui-validator
 */

import type {
  MayflyActionItem,
  MayflyBarChartSeries,
  MayflyChartLevel,
  MayflyChartPoint,
  MayflyChartSeries,
  MayflyField,
  MayflyFormField,
  MayflyInlineSpan,
  MayflyListItem,
  MayflySection,
  MayflySectionContentNode,
  MayflyStatusChild,
  MayflyStatusNode,
  MayflyTabItem,
  MayflyUiChild,
  MayflyUiNode,
  MayflyViewportCondition,
  MayflyPagePath,
  MayflyPageSegment,
  MayflyFieldValue,
} from '@ephemeral-ai/mayfly-ui'
import type { MayflyEditorChild, MayflyEditorShellNode, MayflyValidationResult } from './ui-contracts.ts'

/** Maximum aggregate UTF-16 source units accepted in one tree. */
export const MAYFLY_UI_MAX_TEXT = 20_000
/** Maximum recursive node depth, with the root at depth zero. */
export const MAYFLY_UI_MAX_DEPTH = 8
/** Maximum number of UI nodes in one tree. */
export const MAYFLY_UI_MAX_NODES = 256
/** Maximum entries in any wire collection. */
export const MAYFLY_UI_MAX_COLLECTION = 200

const TERMINAL_SEQUENCE = /(?:(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c)|(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x07|\x1b\\|\x9c)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b.)/gu
const UNSAFE_CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f\uf8ff\ufdd0-\ufdef]/gu

type ValidationMode = 'ui' | 'status' | 'editor'

class ValidationFault extends Error {
  constructor(
    readonly code: 'MAYFLY_INVALID_CONTRIBUTION' | 'MAYFLY_LIMIT_EXCEEDED',
    message: string,
  ) {
    super(message)
  }
}

interface ValidationState {
  readonly active: WeakSet<object>
  pagePath: MayflyPagePath
  scrollDepth: number
  editorControls: number
  readonly budget: ValidationBudget
}

interface ValidationBudget {
  nodes: number
  text: number
  chartCells: number
  readonly controlIds: Set<string>
  readonly tabs: Map<string, ReadonlySet<string>>
  readonly pages: { readonly path: MayflyPagePath, readonly tab: MayflyPageSegment }[]
}

function invalid(message: string): never {
  throw new ValidationFault('MAYFLY_INVALID_CONTRIBUTION', message)
}

function limit(message: string): never {
  throw new ValidationFault('MAYFLY_LIMIT_EXCEEDED', message)
}

function intrinsicPrototypeShape(prototype: object): string {
  return JSON.stringify(Reflect.ownKeys(prototype).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key)!
    return [
      typeof key === 'symbol' ? `@@${String(key)}` : key,
      descriptor.configurable,
      descriptor.enumerable,
      'value' in descriptor
        ? ['data', descriptor.writable, typeof descriptor.value]
        : ['accessor', typeof descriptor.get, typeof descriptor.set],
    ]
  }))
}

function hasRealmConstructor(prototype: object, name: 'Object' | 'Array'): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'constructor')
  if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'function') return false
  const constructor = descriptor.value
  return constructor.name === name
    && constructor.prototype === prototype
    && Function.prototype.toString.call(constructor) === `function ${name}() { [native code] }`
    && intrinsicPrototypeShape(prototype) === intrinsicPrototypeShape(name === 'Object' ? Object.prototype : Array.prototype)
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${path} must be an object`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null && !hasRealmConstructor(prototype, 'Object')) {
    invalid(`${path} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function own(object: Record<string, unknown>, key: string, path: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  if (descriptor === undefined) return undefined
  if (!('value' in descriptor)) invalid(`${path}.${key} must be data`)
  return descriptor.value
}

function required(object: Record<string, unknown>, key: string, path: string): unknown {
  const value = own(object, key, path)
  if (value === undefined) invalid(`${path}.${key} is required`)
  return value
}

function text(value: unknown, path: string, state: ValidationState): string {
  if (typeof value !== 'string') invalid(`${path} must be a string`)
  state.budget.text += value.length
  if (state.budget.text > MAYFLY_UI_MAX_TEXT) limit(`Mayfly UI text exceeds ${String(MAYFLY_UI_MAX_TEXT)} characters`)
  return value.replace(TERMINAL_SEQUENCE, '').replace(UNSAFE_CONTROLS, '')
}

function optionalText(object: Record<string, unknown>, key: string, path: string, state: ValidationState): string | undefined {
  const value = own(object, key, path)
  return value === undefined ? undefined : text(value, `${path}.${key}`, state)
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid(`${path} must be a boolean`)
  return value
}

function finiteInteger(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    invalid(`${path} must be a finite integer within the safe range and >= ${String(minimum)}`)
  }
  return value
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${path} must be a finite number`)
  return value
}

function nullableNumber(value: unknown, path: string): number | null {
  return value === null ? null : finiteNumber(value, path)
}

function identifier(value: unknown, path: string, state: ValidationState, reserve = false): string {
  const result = text(value, path, state)
  if (result.trim().length === 0) invalid(`${path} must not be empty`)
  if (reserve) {
    reserveControl(result, state)
  }
  return result
}

function pageControl(path: MayflyPagePath, id: string): string {
  return JSON.stringify([path.map(segment => [segment.controlId, segment.itemId]), id])
}

function reserveControl(id: string, state: ValidationState): void {
  const key = pageControl(state.pagePath, id)
  if (state.budget.controlIds.has(key)) invalid(`control id "${id}" is duplicated`)
  state.budget.controlIds.add(key)
}

function pageSegment(value: unknown, path: string, state: ValidationState): MayflyPageSegment {
  return enter(value, path, state, object => ({
    controlId: identifier(required(object, 'controlId', path), `${path}.controlId`, state),
    itemId: identifier(required(object, 'itemId', path), `${path}.itemId`, state),
  }))
}

function validatePages(budget: ValidationBudget): void {
  for (const page of budget.pages) {
    if (!budget.tabs.get(pageControl(page.path, page.tab.controlId))?.has(page.tab.itemId)) invalid('page association references an unknown tab')
  }
}

function enumeration<Value extends string | number>(value: unknown, values: readonly Value[], path: string): Value {
  if (!values.includes(value as Value)) invalid(`${path} is invalid`)
  return value as Value
}

function collection(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid(`${path} must be an array`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype === null || !hasRealmConstructor(prototype, 'Array')) {
    invalid(`${path} must be a plain array`)
  }
  const length = Object.getOwnPropertyDescriptor(value, 'length')!.value as number
  if (length > MAYFLY_UI_MAX_COLLECTION) limit(`${path} exceeds ${String(MAYFLY_UI_MAX_COLLECTION)} entries`)
  const copy: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor === undefined) invalid(`${path} must be a dense array`)
    if (!('value' in descriptor)) invalid(`${path}[${String(index)}] must be data`)
    copy.push(descriptor.value)
  }
  return copy
}

function optional<Value>(value: Value | undefined, key: string): { readonly [name: string]: Value } | {} {
  return value === undefined ? {} : { [key]: value }
}

function enter<Value>(value: unknown, path: string, state: ValidationState, visit: (object: Record<string, unknown>) => Value): Value {
  const object = record(value, path)
  if (state.active.has(object)) invalid(`${path} contains a cycle`)
  state.active.add(object)
  try {
    return visit(object)
  } finally {
    state.active.delete(object)
  }
}

function span(value: unknown, path: string, state: ValidationState): MayflyInlineSpan {
  return enter(value, path, state, object => {
    const toneValue = own(object, 'tone', path)
    const stylesValue = own(object, 'styles', path)
    const tone = toneValue === undefined ? undefined : enumeration(toneValue, ['default', 'muted', 'primary', 'accent', 'user', 'success', 'warning', 'danger'], `${path}.tone`)
    const styles = stylesValue === undefined
      ? undefined
      : collection(stylesValue, `${path}.styles`).map((style, index) => enumeration(style, ['strong', 'italic', 'strike'], `${path}.styles[${String(index)}]`))
    if (styles !== undefined && new Set(styles).size !== styles.length) invalid(`${path}.styles contains duplicates`)
    return { text: text(required(object, 'text', path), `${path}.text`, state), ...optional(tone, 'tone'), ...optional(styles, 'styles') }
  })
}

function spans(value: unknown, path: string, state: ValidationState): readonly MayflyInlineSpan[] {
  return collection(value, path).map((entry, index) => span(entry, `${path}[${String(index)}]`, state))
}

function field(value: unknown, path: string, state: ValidationState): MayflyField {
  return enter(value, path, state, object => ({
    label: text(required(object, 'label', path), `${path}.label`, state),
    value: spans(required(object, 'value', path), `${path}.value`, state),
  }))
}

function listItem(value: unknown, path: string, state: ValidationState): MayflyListItem {
  return enter(value, path, state, object => {
    const disabledValue = own(object, 'disabled', path)
    const detailSpansValue = own(object, 'detailSpans', path)
    return {
      id: text(required(object, 'id', path), `${path}.id`, state),
      label: text(required(object, 'label', path), `${path}.label`, state),
      ...optional(optionalText(object, 'detail', path, state), 'detail'),
      ...optional(detailSpansValue === undefined ? undefined : spans(detailSpansValue, `${path}.detailSpans`, state), 'detailSpans'),
      ...optional(optionalText(object, 'badge', path, state), 'badge'),
      ...optional(optionalText(object, 'group', path, state), 'group'),
      ...optional(optionalText(object, 'disabledReason', path, state), 'disabledReason'),
      ...optional(optionalText(object, 'parentId', path, state), 'parentId'),
      ...optional(optionalText(object, 'searchText', path, state), 'searchText'),
      ...optional(disabledValue === undefined ? undefined : boolean(disabledValue, `${path}.disabled`), 'disabled'),
    }
  })
}

const LAZY_LIST_CACHE_LIMIT = 256
const LAZY_LIST_ID_CACHE_LIMIT = 512
const LAZY_LIST_INVALID_ID = '__mayfly-invalid-list-item-'

interface LazyListAdmission {
  readonly length: number
  item(index: number): MayflyListItem
  indexOf(id: string): number
}

const lazyLists = new WeakMap<readonly MayflyListItem[], LazyListAdmission>()

function validationState(budget: ValidationBudget = {
  nodes: 0,
  text: 0,
  chartCells: 0,
  controlIds: new Set(),
  tabs: new Map(),
  pages: [],
}): ValidationState {
  return {
    active: new WeakSet(),
    pagePath: [],
    scrollDepth: 0,
    editorControls: 0,
    budget,
  }
}

interface DeferredUiAdmission {
  readonly source: unknown
  readonly path: string
  readonly depth: number
  readonly scrollDepth: number
  readonly budget: ValidationBudget
  readonly mayHaveControls: boolean
  readonly pagePath: MayflyPagePath
  result?: MayflyValidationResult<MayflyUiNode>
}

const deferredUiNodes = new WeakMap<MayflyUiNode, DeferredUiAdmission>()
const PASSIVE_UI_KINDS = new Set([
  'text', 'fields', 'code', 'diff', 'sections', 'rich-text', 'progress',
  'spacer', 'divider', 'document', 'chart',
])

function deferredMayHaveControls(source: unknown): boolean {
  try {
    if (typeof source !== 'object' || source === null) return true
    const descriptor = Object.getOwnPropertyDescriptor(source, 'kind')
    return descriptor === undefined
      || !('value' in descriptor)
      || typeof descriptor.value !== 'string'
      || !PASSIVE_UI_KINDS.has(descriptor.value)
  } catch {
    return true
  }
}

function deferredUiNode(source: unknown, path: string, depth: number, scrollDepth: number, budget: ValidationBudget, pagePath: MayflyPagePath): MayflyUiNode {
  const placeholder = Object.freeze({ kind: 'spacer' as const, size: 1 as const })
  deferredUiNodes.set(placeholder, { source, path, depth, scrollDepth, budget, pagePath, mayHaveControls: deferredMayHaveControls(source) })
  return placeholder
}

/** Identify a renderer-private responsive placeholder without exposing it on the wire format. */
export function isDeferredUiNode(value: MayflyUiNode): boolean {
  return deferredUiNodes.has(value)
}

/** Conservatively identify an unadmitted branch that may later add controls. */
export function deferredUiNodeMayHaveControls(value: MayflyUiNode): boolean {
  return deferredUiNodes.get(value)?.mayHaveControls === true
}

/** Read an already materialized responsive subtree without activating a hidden branch. */
export function materializedDeferredUiNode(value: MayflyUiNode): MayflyValidationResult<MayflyUiNode> | undefined {
  return deferredUiNodes.get(value)?.result
}

/** Core can inspect declaration identities without admitting a hidden branch's content. */
export function deferredUiNodeSource(value: MayflyUiNode): unknown {
  return deferredUiNodes.get(value)?.source
}

/** Materialize one responsive subtree the first time its viewport condition becomes active. */
export function materializeDeferredUiNode(value: MayflyUiNode): MayflyValidationResult<MayflyUiNode> | undefined {
  const deferred = deferredUiNodes.get(value)
  if (deferred === undefined) return undefined
  if (deferred.result !== undefined) return deferred.result
  const checkpoint = {
    nodes: deferred.budget.nodes,
    text: deferred.budget.text,
    chartCells: deferred.budget.chartCells,
    controlIds: new Set(deferred.budget.controlIds),
    tabs: new Map(deferred.budget.tabs),
    pages: deferred.budget.pages.length,
  }
  const state = validationState(deferred.budget)
  state.scrollDepth = deferred.scrollDepth
  state.pagePath = deferred.pagePath
  try {
    deferred.result = { ok: true, value: freeze(node(deferred.source, deferred.path, state, deferred.depth, 'ui')) }
    validatePages(deferred.budget)
  } catch (error) {
    deferred.budget.nodes = checkpoint.nodes
    deferred.budget.text = checkpoint.text
    deferred.budget.chartCells = checkpoint.chartCells
    deferred.budget.controlIds.clear()
    for (const id of checkpoint.controlIds) deferred.budget.controlIds.add(id)
    deferred.budget.tabs.clear()
    for (const [id, items] of checkpoint.tabs) deferred.budget.tabs.set(id, items)
    deferred.budget.pages.splice(checkpoint.pages)
    deferred.result = error instanceof ValidationFault
      ? { ok: false, code: error.code, message: error.message }
      : { ok: false, code: 'MAYFLY_INVALID_CONTRIBUTION', message: 'Mayfly UI validation failed safely' }
  }
  return deferred.result
}

function lazyListItems(value: unknown, path: string): readonly MayflyListItem[] {
  const prototype = Object.getPrototypeOf(value)
  if (prototype === null || !hasRealmConstructor(prototype, 'Array')) invalid(`${path} must be a plain array`)
  const length = Object.getOwnPropertyDescriptor(value, 'length')!.value as number
  const source = value as readonly unknown[]
  const cache = new Map<number, MayflyListItem>()
  const ids = new Map<number, string | undefined>()
  const owners = new Map<string, number>()
  const raw = (index: number): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(source, String(index))
    if (descriptor === undefined) throw new ValidationFault('MAYFLY_INVALID_CONTRIBUTION', `${path} must be a dense array`)
    if (!('value' in descriptor)) throw new ValidationFault('MAYFLY_INVALID_CONTRIBUTION', `${path}[${String(index)}] must be data`)
    return descriptor.value
  }
  const peekId = (index: number): string | undefined => {
    if (ids.has(index)) return ids.get(index)
    try {
      const object = record(raw(index), `${path}[${String(index)}]`)
      const id = text(required(object, 'id', `${path}[${String(index)}]`), `${path}[${String(index)}].id`, validationState())
      ids.set(index, id)
      if (ids.size > LAZY_LIST_ID_CACHE_LIMIT) ids.delete(ids.keys().next().value!)
      return id
    } catch {
      ids.set(index, undefined)
      if (ids.size > LAZY_LIST_ID_CACHE_LIMIT) ids.delete(ids.keys().next().value!)
      return undefined
    }
  }
  const admission: LazyListAdmission = {
    length,
    item(index) {
      const cached = cache.get(index)
      if (cached !== undefined) {
        cache.delete(index)
        cache.set(index, cached)
        return cached
      }
      let admitted: MayflyListItem
      try {
        admitted = listItem(raw(index), `${path}[${String(index)}]`, validationState())
        const owner = owners.get(admitted.id)
        if (owner !== undefined && owner !== index) invalid(`${path} contains duplicate ids`)
        owners.set(admitted.id, index)
        if (owners.size > LAZY_LIST_ID_CACHE_LIMIT) owners.delete(owners.keys().next().value!)
      } catch (error) {
        const message = error instanceof ValidationFault ? error.message : `${path}[${String(index)}] is invalid`
        admitted = {
          id: `${LAZY_LIST_INVALID_ID}${String(index)}`,
          label: `Mayfly UI rejected: ${message}`,
          disabled: true,
        }
      }
      admitted = freeze(admitted)
      cache.set(index, admitted)
      if (cache.size > LAZY_LIST_CACHE_LIMIT) cache.delete(cache.keys().next().value!)
      return admitted
    },
    indexOf(id) {
      for (let index = 0; index < length; index += 1) if (peekId(index) === id) return index
      return -1
    },
  }
  const target: MayflyListItem[] = []
  target.length = length
  const proxy = new Proxy(target, {
    get(array, property, receiver) {
      if (typeof property === 'string') {
        const index = Number(property)
        if (Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === property) return admission.item(index)
      }
      return Reflect.get(array, property, receiver)
    },
    has(array, property) {
      if (typeof property === 'string') {
        const index = Number(property)
        if (Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === property) return true
      }
      return Reflect.has(array, property)
    },
  }) as readonly MayflyListItem[]
  lazyLists.set(proxy, admission)
  return proxy
}

/** Core-private indexed access for an admitted list without forcing the full collection. */
export function admittedListItem(items: readonly MayflyListItem[], index: number): MayflyListItem | undefined {
  if (!Number.isSafeInteger(index) || index < 0 || index >= items.length) return undefined
  return lazyLists.get(items)?.item(index) ?? items[index]
}

/** Core-private ID lookup that reads only IDs for a lazy admitted list. */
export function admittedListIndex(items: readonly MayflyListItem[], id: string): number {
  return lazyLists.get(items)?.indexOf(id) ?? items.findIndex(item => item.id === id)
}

function actionItem(value: unknown, path: string, state: ValidationState): MayflyActionItem {
  return enter(value, path, state, object => {
    const intentValue = own(object, 'intent', path)
    const disabledValue = own(object, 'disabled', path)
    const busyValue = own(object, 'busy', path)
    const defaultFocus = own(object, 'defaultFocus', path)
    const dismiss = own(object, 'dismiss', path)
    const submitValue = own(object, 'submit', path)
    const submit = submitValue === undefined ? undefined : collection(submitValue, `${path}.submit`).map((entry, index) => enter(entry, `${path}.submit[${index}]`, state, target => ({
      formId: identifier(required(target, 'formId', path), `${path}.submit[${index}].formId`, state),
      pagePath: collection(required(target, 'pagePath', path), `${path}.submit[${index}].pagePath`).map((segment, segmentIndex) => pageSegment(segment, `${path}.submit[${index}].pagePath[${segmentIndex}]`, state)),
    })))
    if (submit !== undefined && (submit.length === 0 || new Set(submit.map(target => pageControl(target.pagePath, target.formId))).size !== submit.length)) invalid(`${path}.submit requires unique form addresses`)
    const readValue = own(object, 'read', path)
    const navigateValue = own(object, 'navigate', path)
    const navigate = navigateValue === undefined ? undefined : collection(navigateValue, `${path}.navigate`).map((segment, index) => pageSegment(segment, `${path}.navigate[${index}]`, state))
    if (navigate !== undefined && (navigate.length === 0 || submit !== undefined || dismiss === true)) invalid(`${path}.navigate requires a destination and cannot submit or dismiss`)
    const read = readValue === undefined ? undefined : collection(readValue, `${path}.read`).map((entry, index) => enter(entry, `${path}.read[${index}]`, state, target => ({
      formId: identifier(required(target, 'formId', path), `${path}.read[${index}].formId`, state),
      pagePath: collection(required(target, 'pagePath', path), `${path}.read[${index}].pagePath`).map((segment, segmentIndex) => pageSegment(segment, `${path}.read[${index}].pagePath[${segmentIndex}]`, state)),
    })))
    if (read !== undefined && submit !== undefined) invalid(`${path} cannot both read and submit forms`)
    const selectionsValue = own(object, 'selections', path)
    const selections = selectionsValue === undefined ? undefined : collection(selectionsValue, `${path}.selections`).map((entry, index) => enter(entry, `${path}.selections[${index}]`, state, target => ({
      controlId: identifier(required(target, 'controlId', path), `${path}.selections[${index}].controlId`, state),
      pagePath: collection(required(target, 'pagePath', path), `${path}.selections[${index}].pagePath`).map((segment, segmentIndex) => pageSegment(segment, `${path}.selections[${index}].pagePath[${segmentIndex}]`, state)),
    })))
    return {
      id: text(required(object, 'id', path), `${path}.id`, state),
      label: text(required(object, 'label', path), `${path}.label`, state),
      ...optional(intentValue === undefined ? undefined : enumeration(intentValue, ['primary', 'secondary', 'danger'], `${path}.intent`), 'intent'),
      ...optional(disabledValue === undefined ? undefined : boolean(disabledValue, `${path}.disabled`), 'disabled'),
      ...optional(optionalText(object, 'disabledReason', path, state), 'disabledReason'),
      ...optional(busyValue === undefined ? undefined : boolean(busyValue, `${path}.busy`), 'busy'),
      ...optional(optionalText(object, 'confirm', path, state), 'confirm'),
      ...optional(defaultFocus === undefined ? undefined : boolean(defaultFocus, `${path}.defaultFocus`), 'defaultFocus'),
      ...optional(dismiss === undefined ? undefined : boolean(dismiss, `${path}.dismiss`), 'dismiss'),
      ...optional(submit, 'submit'),
      ...optional(read, 'read'),
      ...optional(selections, 'selections'),
      ...optional(navigate, 'navigate'),
    }
  })
}

function uniqueIds(items: readonly { readonly id: string }[], path: string): void {
  if (new Set(items.map(item => item.id)).size !== items.length) invalid(`${path} contains duplicate ids`)
}

function viewportCondition(value: unknown, path: string): MayflyViewportCondition {
  return enter(value, path, validationState(), object => {
    const result: { minWidth?: number, maxWidth?: number, minHeight?: number, maxHeight?: number } = {}
    for (const key of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'] as const) {
      const item = own(object, key, path)
      if (item !== undefined) result[key] = finiteInteger(item, `${path}.${key}`)
    }
    if (result.minWidth !== undefined && result.maxWidth !== undefined && result.minWidth > result.maxWidth) invalid(`${path} width range is inverted`)
    if (result.minHeight !== undefined && result.maxHeight !== undefined && result.minHeight > result.maxHeight) invalid(`${path} height range is inverted`)
    return result
  })
}

const CHART_TONES = ['default', 'muted', 'primary', 'accent', 'user', 'success', 'warning', 'danger'] as const

function chartTone(object: Record<string, unknown>, path: string): MayflyInlineSpan['tone'] | undefined {
  const value = own(object, 'tone', path)
  return value === undefined ? undefined : enumeration(value, CHART_TONES, `${path}.tone`)
}

function addChartCells(state: ValidationState, count: number): void {
  state.budget.chartCells += count
  if (state.budget.chartCells > 4_000) limit('Mayfly chart data exceeds 4000 cells')
}

function chartPoint(value: unknown, path: string, state: ValidationState): MayflyChartPoint {
  return enter(value, path, state, object => ({
    x: finiteNumber(required(object, 'x', path), `${path}.x`),
    y: nullableNumber(required(object, 'y', path), `${path}.y`),
  }))
}

function chartSeries(value: unknown, path: string, state: ValidationState): MayflyChartSeries {
  return enter(value, path, state, object => {
    const points = collection(required(object, 'points', path), `${path}.points`)
      .map((item, index) => chartPoint(item, `${path}.points[${String(index)}]`, state))
    addChartCells(state, points.length)
    return {
      id: identifier(required(object, 'id', path), `${path}.id`, state),
      ...optional(optionalText(object, 'label', path, state), 'label'),
      ...optional(chartTone(object, path), 'tone'),
      points,
    }
  })
}

function barSeries(value: unknown, path: string, state: ValidationState): MayflyBarChartSeries {
  return enter(value, path, state, object => {
    const values = collection(required(object, 'values', path), `${path}.values`)
      .map((item, index) => nullableNumber(item, `${path}.values[${String(index)}]`))
    addChartCells(state, values.length)
    return {
      id: identifier(required(object, 'id', path), `${path}.id`, state),
      ...optional(optionalText(object, 'label', path, state), 'label'),
      ...optional(chartTone(object, path), 'tone'),
      values,
    }
  })
}

function chartLevel(value: unknown, path: string, state: ValidationState): MayflyChartLevel {
  return enter(value, path, state, object => {
    const raw = required(object, 'value', path)
    if (typeof raw !== 'string' && (typeof raw !== 'number' || !Number.isFinite(raw))) invalid(`${path}.value must be a string or finite number`)
    return {
      value: typeof raw === 'string' ? text(raw, `${path}.value`, state) : raw,
      label: text(required(object, 'label', path), `${path}.label`, state),
      ...optional(chartTone(object, path), 'tone'),
    }
  })
}

function chartHeight(object: Record<string, unknown>, path: string): number | undefined {
  const value = own(object, 'height', path)
  if (value === undefined) return undefined
  const height = finiteInteger(value, `${path}.height`, 4)
  return height
}

function uiChild<Node>(
  value: unknown,
  path: string,
  state: ValidationState,
  depth: number,
  parseNode: (value: unknown, path: string, state: ValidationState, depth: number) => Node,
  deferWhen?: (value: unknown, path: string, depth: number, scrollDepth: number, budget: ValidationBudget, pagePath: MayflyPagePath) => Node,
): Omit<MayflyUiChild, 'node'> & { readonly node: Node } {
  return enter(value, path, state, object => {
    const basisValue = own(object, 'basis', path)
    const idValue = own(object, 'id', path)
    const basis = basisValue === undefined ? undefined : basisValue === 'auto' ? 'auto' : finiteInteger(basisValue, `${path}.basis`)
    const growValue = own(object, 'grow', path)
    const shrinkValue = own(object, 'shrink', path)
    const minValue = own(object, 'minSize', path)
    const maxValue = own(object, 'maxSize', path)
    const whenValue = own(object, 'when', path)
    const when = whenValue === undefined ? undefined : viewportCondition(whenValue, `${path}.when`)
    const tabValue = own(object, 'tab', path)
    if (tabValue !== undefined && deferWhen === undefined) invalid(`${path}.tab is only supported in UI content`)
    const tab = tabValue === undefined ? undefined : pageSegment(tabValue, `${path}.tab`, state)
    const minSize = minValue === undefined ? undefined : finiteInteger(minValue, `${path}.minSize`)
    const maxSize = maxValue === undefined ? undefined : finiteInteger(maxValue, `${path}.maxSize`)
    if (minSize !== undefined && maxSize !== undefined && minSize > maxSize) invalid(`${path} size range is inverted`)
    const childValue = required(object, 'node', path)
    const parentPath = state.pagePath
    if (tab !== undefined) {
      state.budget.pages.push({ path: parentPath, tab })
      state.pagePath = [...parentPath, tab]
    }
    let child: Node
    try {
      child = when === undefined || deferWhen === undefined
        ? parseNode(childValue, `${path}.node`, state, depth)
        : deferWhen(childValue, `${path}.node`, depth, state.scrollDepth, state.budget, state.pagePath)
    } finally { state.pagePath = parentPath }
    return {
      node: child,
      ...optional(idValue === undefined ? undefined : identifier(idValue, `${path}.id`, state), 'id'),
      ...optional(tab, 'tab'),
      ...optional(basis, 'basis'),
      ...optional(growValue === undefined ? undefined : finiteInteger(growValue, `${path}.grow`), 'grow'),
      ...optional(shrinkValue === undefined ? undefined : finiteInteger(shrinkValue, `${path}.shrink`), 'shrink'),
      ...optional(minSize, 'minSize'),
      ...optional(maxSize, 'maxSize'),
      ...optional(when, 'when'),
    }
  })
}

function view(value: unknown, path: string, state: ValidationState, depth: number): MayflySectionContentNode {
  return node(value, path, state, depth, 'ui', true)
}

function section(value: unknown, path: string, state: ValidationState, depth: number): MayflySection {
  return enter(value, path, state, object => {
    const collapsedValue = own(object, 'collapsed', path)
    return {
      ...optional(optionalText(object, 'title', path, state), 'title'),
      body: view(required(object, 'body', path), `${path}.body`, state, depth),
      ...optional(collapsedValue === undefined ? undefined : boolean(collapsedValue, `${path}.collapsed`), 'collapsed'),
    }
  })
}

function formField(value: unknown, path: string, state: ValidationState): MayflyFormField {
  return enter(value, path, state, object => {
    const kind = enumeration(required(object, 'kind', path), ['input', 'textarea', 'secret', 'select', 'toggle', 'number', 'multiselect'], `${path}.kind`)
    const id = text(required(object, 'id', path), `${path}.id`, state)
    const label = text(required(object, 'label', path), `${path}.label`, state)
    const error = optionalText(object, 'error', path, state)
    const disabledValue = own(object, 'disabled', path)
    const disabled = disabledValue === undefined ? undefined : boolean(disabledValue, `${path}.disabled`)
    const requiredValue = own(object, 'required', path)
    const originValue = own(object, 'origin', path)
    const reset = own(object, 'resetValue', path)
    const parseValue = (value: unknown, valuePath: string): MayflyFieldValue => {
      if (kind === 'number') return nullableNumber(value, valuePath)
      if (kind === 'toggle') return boolean(value, valuePath)
      if (kind === 'select' && value === null) return null
      if (kind === 'multiselect') {
        const values = collection(value, valuePath).map((item, index) => identifier(item, `${valuePath}[${index}]`, state))
        if (new Set(values).size !== values.length) invalid(`${valuePath} contains duplicate values`)
        return values
      }
      return text(value, valuePath, state)
    }
    const common = {
      id, label, ...optional(error, 'error'), ...optional(disabled, 'disabled'),
      ...optional(optionalText(object, 'disabledReason', path, state), 'disabledReason'),
      ...optional(requiredValue === undefined ? undefined : boolean(requiredValue, `${path}.required`), 'required'),
      ...optional(originValue === undefined ? undefined : enumeration(originValue, ['inherited', 'explicit'], `${path}.origin`), 'origin'),
      ...optional(reset === undefined ? undefined : parseValue(reset, `${path}.resetValue`), 'resetValue'),
    }
    if (kind === 'toggle') return { kind, ...common, value: boolean(required(object, 'value', path), `${path}.value`) }
    if (kind === 'number') {
      const minValue = own(object, 'min', path)
      const maxValue = own(object, 'max', path)
      const stepValue = own(object, 'step', path)
      const min = minValue === undefined ? undefined : finiteNumber(minValue, `${path}.min`)
      const max = maxValue === undefined ? undefined : finiteNumber(maxValue, `${path}.max`)
      const step = stepValue === undefined ? undefined : finiteNumber(stepValue, `${path}.step`)
      if (min !== undefined && max !== undefined && min > max) invalid(`${path} numeric range is inverted`)
      if (step !== undefined && step <= 0) invalid(`${path}.step must be positive`)
      return { kind, ...common, value: nullableNumber(required(object, 'value', path), `${path}.value`), ...optional(min, 'min'), ...optional(max, 'max'), ...optional(step, 'step'), ...optional(optionalText(object, 'unit', path, state), 'unit') }
    }
    if (kind === 'select' || kind === 'multiselect') {
      const raw = required(object, 'value', path)
      const options = collection(required(object, 'options', path), `${path}.options`).map((item, index) => listItem(item, `${path}.options[${String(index)}]`, state))
      uniqueIds(options, `${path}.options`)
      if (kind === 'multiselect') return { kind, ...common, value: parseValue(raw, `${path}.value`) as readonly string[], options, ...selectionBounds(object, path) }
      if (raw !== null && typeof raw !== 'string') invalid(`${path}.value must be a string or null`)
      return { kind, ...common, value: raw, options }
    }
    const minLengthValue = own(object, 'minLength', path)
    const maxLengthValue = own(object, 'maxLength', path)
    const minLength = minLengthValue === undefined ? undefined : finiteInteger(minLengthValue, `${path}.minLength`)
    const maxLength = maxLengthValue === undefined ? undefined : finiteInteger(maxLengthValue, `${path}.maxLength`)
    if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) invalid(`${path} length range is inverted`)
    return {
      kind, ...common,
      value: text(required(object, 'value', path), `${path}.value`, state),
      ...optional(optionalText(object, 'placeholder', path, state), 'placeholder'),
      ...optional(minLength, 'minLength'), ...optional(maxLength, 'maxLength'),
    }
  })
}

function selectionBounds(object: Record<string, unknown>, path: string): { readonly minSelected?: number, readonly maxSelected?: number } {
  const minValue = own(object, 'minSelected', path)
  const maxValue = own(object, 'maxSelected', path)
  const minSelected = minValue === undefined ? undefined : finiteInteger(minValue, `${path}.minSelected`)
  const maxSelected = maxValue === undefined ? undefined : finiteInteger(maxValue, `${path}.maxSelected`)
  if (minSelected !== undefined && maxSelected !== undefined && minSelected > maxSelected) invalid(`${path} selection range is inverted`)
  return { ...optional(minSelected, 'minSelected'), ...optional(maxSelected, 'maxSelected') }
}

function node(value: unknown, path: string, state: ValidationState, depth: number, mode: 'ui', viewOnly?: false): MayflyUiNode
function node(value: unknown, path: string, state: ValidationState, depth: number, mode: 'ui', viewOnly: true): MayflySectionContentNode
function node(value: unknown, path: string, state: ValidationState, depth: number, mode: 'status', viewOnly?: false): MayflyStatusNode
function node(value: unknown, path: string, state: ValidationState, depth: number, mode: 'editor', viewOnly?: false, editorSlotAllowed?: boolean): MayflyEditorShellNode
function node(value: unknown, path: string, state: ValidationState, depth: number, mode: ValidationMode, viewOnly = false, editorSlotAllowed = false): MayflyUiNode | MayflyStatusNode | MayflyEditorShellNode {
  if (depth > MAYFLY_UI_MAX_DEPTH) limit(`Mayfly UI depth exceeds ${String(MAYFLY_UI_MAX_DEPTH)}`)
  state.budget.nodes += 1
  if (state.budget.nodes > MAYFLY_UI_MAX_NODES) limit(`Mayfly UI tree exceeds ${String(MAYFLY_UI_MAX_NODES)} nodes`)
  return enter(value, path, state, object => {
    const kind = own(object, 'kind', path)
    if (typeof kind !== 'string') invalid(`${path}.kind must be a string`)
    if (kind === 'editor-control') {
      if (mode !== 'editor' || !editorSlotAllowed) invalid('editor-control is only valid in an editor shell slot')
      state.editorControls += 1
      return { kind }
    }
    if (mode === 'status' && !['text', 'rich-text', 'fields', 'progress', 'stack'].includes(kind)) invalid(`status node kind "${kind}" is interactive or unsupported`)
    if (mode === 'editor' && (kind === 'diagram' || kind === 'chart')) invalid(`editor node kind "${kind}" is unsupported`)
    if (viewOnly && !['text', 'fields', 'code', 'diff', 'sections'].includes(kind)) invalid(`${path} must be section content`)
    switch (kind) {
      case 'text': {
        const toneValue = own(object, 'tone', path)
        return { kind, content: text(required(object, 'content', path), `${path}.content`, state), ...optional(toneValue === undefined ? undefined : enumeration(toneValue, ['default', 'muted', 'primary', 'accent', 'user', 'success', 'warning', 'danger'], `${path}.tone`), 'tone') }
      }
      case 'markdown': return { kind, source: text(required(object, 'source', path), `${path}.source`, state) }
      case 'fields': return { kind, rows: collection(required(object, 'rows', path), `${path}.rows`).map((item, index) => field(item, `${path}.rows[${String(index)}]`, state)) }
      case 'code': return { kind, code: text(required(object, 'code', path), `${path}.code`, state), ...optional(optionalText(object, 'language', path, state), 'language') }
      case 'diff': return { kind, before: text(required(object, 'before', path), `${path}.before`, state), after: text(required(object, 'after', path), `${path}.after`, state) }
      case 'sections': return { kind, sections: collection(required(object, 'sections', path), `${path}.sections`).map((item, index) => section(item, `${path}.sections[${String(index)}]`, state, depth + 1)) }
      case 'rich-text': return { kind, spans: spans(required(object, 'spans', path), `${path}.spans`, state) }
      case 'stack': {
        const gapValue = own(object, 'gap', path)
        const alignValue = own(object, 'align', path)
        const stack = {
          kind,
          direction: enumeration(required(object, 'direction', path), ['row', 'column'], `${path}.direction`),
          ...optional(gapValue === undefined ? undefined : enumeration(gapValue, [0, 1, 2] as const, `${path}.gap`), 'gap'),
          ...optional(alignValue === undefined ? undefined : enumeration(alignValue, ['stretch', 'start', 'center', 'end'], `${path}.align`), 'align'),
        } as const
        const entries = collection(required(object, 'children', path), `${path}.children`)
        const childIds = entries.map((entry, index) => own(record(entry, `${path}.children[${index}]`), 'id', `${path}.children[${index}]`)).filter(id => id !== undefined)
        if (new Set(childIds).size !== childIds.length) invalid(`${path}.children contains duplicate content ids`)
        if (mode === 'status') {
          const children: readonly MayflyStatusChild[] = entries.map((item, index) => uiChild(item, `${path}.children[${String(index)}]`, state, depth + 1, (child, childPath, childState, childDepth) => node(child, childPath, childState, childDepth, 'status')))
          return { ...stack, children }
        }
        if (mode === 'editor') {
          const children: readonly MayflyEditorChild[] = entries.map((item, index) => uiChild(item, `${path}.children[${String(index)}]`, state, depth + 1, (child, childPath, childState, childDepth) => node(child, childPath, childState, childDepth, 'editor', false, true)))
          return { ...stack, children }
        }
        const children: readonly MayflyUiChild[] = entries.map((item, index) => uiChild(
          item,
          `${path}.children[${String(index)}]`,
          state,
          depth + 1,
          (child, childPath, childState, childDepth) => node(child, childPath, childState, childDepth, 'ui'),
          (child, childPath, childDepth, scrollDepth, budget, pagePath) => deferredUiNode(child, childPath, childDepth, scrollDepth, budget, pagePath),
        ))
        return { ...stack, children }
      }
      case 'surface': {
        const chromeValue = own(object, 'chrome', path)
        const paddingValue = own(object, 'padding', path)
        const badgesValue = own(object, 'badges', path)
        const footerValue = own(object, 'footer', path)
        const surface = { kind, ...optional(optionalText(object, 'title', path, state), 'title'), ...optional(optionalText(object, 'subtitle', path, state), 'subtitle'), ...optional(badgesValue === undefined ? undefined : spans(badgesValue, `${path}.badges`, state), 'badges'), ...optional(chromeValue === undefined ? undefined : enumeration(chromeValue, ['none', 'lane', 'surface', 'overlay'], `${path}.chrome`), 'chrome'), ...optional(paddingValue === undefined ? undefined : enumeration(paddingValue, [0, 1, 2] as const, `${path}.padding`), 'padding') } as const
        if (mode === 'editor') {
          const child = node(required(object, 'child', path), `${path}.child`, state, depth + 1, 'editor', false, true)
          const footer = footerValue === undefined ? undefined : node(footerValue, `${path}.footer`, state, depth + 1, 'editor', false, true)
          return { ...surface, child, ...optional(footer, 'footer') }
        }
        const child = node(required(object, 'child', path), `${path}.child`, state, depth + 1, 'ui')
        const footer = footerValue === undefined ? undefined : node(footerValue, `${path}.footer`, state, depth + 1, 'ui')
        return { ...surface, child, ...optional(footer, 'footer') }
      }
      case 'scroll': {
        if (state.scrollDepth > 0) invalid('nested scroll nodes are not supported')
        const idValue = own(object, 'id', path)
        const id = idValue === undefined ? undefined : identifier(idValue, `${path}.id`, state)
        if (id !== undefined) reserveControl(id, state)
        const followValue = own(object, 'follow', path)
        const scrollbarValue = own(object, 'scrollbar', path)
        state.scrollDepth += 1
        try {
          return { kind, ...optional(id, 'id'), child: node(required(object, 'child', path), `${path}.child`, state, depth + 1, 'ui'), ...optional(followValue === undefined ? undefined : enumeration(followValue, ['none', 'start', 'end'], `${path}.follow`), 'follow'), ...optional(scrollbarValue === undefined ? undefined : boolean(scrollbarValue, `${path}.scrollbar`), 'scrollbar') }
        } finally {
          state.scrollDepth -= 1
        }
      }
      case 'tabs': {
        const modeValue = own(object, 'mode', path)
        const items = collection(required(object, 'items', path), `${path}.items`).map((item, index): MayflyTabItem => enter(item, `${path}.items[${String(index)}]`, state, entry => {
          const disabledValue = own(entry, 'disabled', `${path}.items[${String(index)}]`)
          const countValue = own(entry, 'count', `${path}.items[${String(index)}]`)
          return { id: text(required(entry, 'id', path), `${path}.items[${String(index)}].id`, state), label: text(required(entry, 'label', path), `${path}.items[${String(index)}].label`, state), ...optional(disabledValue === undefined ? undefined : boolean(disabledValue, `${path}.items[${String(index)}].disabled`), 'disabled'), ...optional(countValue === undefined ? undefined : finiteInteger(countValue, `${path}.items[${String(index)}].count`), 'count'), ...optional(optionalText(entry, 'backId', `${path}.items[${String(index)}]`, state), 'backId') }
        }))
        uniqueIds(items, `${path}.items`)
        const activeId = identifier(required(object, 'activeId', path), `${path}.activeId`, state)
        if (!items.some(item => item.id === activeId)) invalid(`${path}.activeId is not present in items`)
        for (const item of items) if (item.backId !== undefined && (item.backId === item.id || !items.some(target => target.id === item.backId))) invalid(`${path}.backId requires a different page in the same tabs`)
        for (const item of items) {
          const visited = new Set<string>()
          let current: MayflyTabItem | undefined = item
          while (current !== undefined) {
            if (visited.has(current.id)) invalid(`${path}.backId cannot form a cycle`)
            visited.add(current.id)
            current = items.find(target => target.id === current!.backId)
          }
        }
        const id = identifier(required(object, 'id', path), `${path}.id`, state, true)
        state.budget.tabs.set(pageControl(state.pagePath, id), new Set(items.map(item => item.id)))
        return { kind, id, activeId, items, ...optional(modeValue === undefined ? undefined : enumeration(modeValue, ['tabs', 'wizard'], `${path}.mode`), 'mode') }
      }
      case 'list': {
        const role = enumeration(required(object, 'role', path), ['browse', 'choose'], `${path}.role`)
        const modeValue = own(object, 'mode', path)
        const emptyValue = own(object, 'empty', path)
        const itemsValue = required(object, 'items', path)
        const itemCount = Array.isArray(itemsValue)
          ? Object.getOwnPropertyDescriptor(itemsValue, 'length')!.value as number
          : 0
        const items = itemCount > MAYFLY_UI_MAX_COLLECTION
          ? lazyListItems(itemsValue, `${path}.items`)
          : collection(itemsValue, `${path}.items`).map((item, index) => listItem(item, `${path}.items[${String(index)}]`, state))
        if (itemCount <= MAYFLY_UI_MAX_COLLECTION) uniqueIds(items, `${path}.items`)
        const selectedIds = collection(required(object, 'selectedIds', path), `${path}.selectedIds`).map((item, index) => text(item, `${path}.selectedIds[${String(index)}]`, state))
        if (new Set(selectedIds).size !== selectedIds.length) invalid(`${path}.selectedIds contains duplicate ids`)
        if ((modeValue ?? 'single') === 'single' && selectedIds.length > 1) invalid(`${path}.selectedIds has more than one id in single mode`)
        const filterable = own(object, 'filterable', path)
        const tree = own(object, 'tree', path)
        if (tree === true && itemCount <= MAYFLY_UI_MAX_COLLECTION) {
          const byId = new Map(items.map(item => [item.id, item]))
          for (const item of items) {
            if (item.parentId === item.id) invalid(`${path}.items tree cannot parent an item to itself`)
            const seen = new Set<string>([item.id])
            let parent = item.parentId
            while (parent !== undefined && byId.has(parent)) {
              if (seen.has(parent)) invalid(`${path}.items tree cannot contain a cycle`)
              seen.add(parent)
              parent = byId.get(parent)!.parentId
            }
          }
        }
        return { kind, role, id: identifier(required(object, 'id', path), `${path}.id`, state, true), ...optional(modeValue === undefined ? undefined : enumeration(modeValue, ['single', 'multiple'], `${path}.mode`), 'mode'), selectedIds, items, ...selectionBounds(object, path), ...optional(optionalText(object, 'acceptActionId', path, state), 'acceptActionId'), ...optional(filterable === undefined ? undefined : boolean(filterable, `${path}.filterable`), 'filterable'), ...optional(tree === undefined ? undefined : boolean(tree, `${path}.tree`), 'tree'), ...optional(optionalText(object, 'filter', path, state), 'filter'), ...optional(emptyValue === undefined ? undefined : node(emptyValue, `${path}.empty`, state, depth + 1, 'ui'), 'empty') }
      }
      case 'form': {
        const fields = collection(required(object, 'fields', path), `${path}.fields`).map((item, index) => formField(item, `${path}.fields[${String(index)}]`, state))
        uniqueIds(fields, `${path}.fields`)
        const id = identifier(required(object, 'id', path), `${path}.id`, state, true)
        for (const field of fields) {
          if (field.id.trim().length === 0) invalid(`${path}.fields id must not be empty`)
          reserveControl(field.id, state)
        }
        const submitActionId = optionalText(object, 'submitActionId', path, state)
        const cancelActionId = optionalText(object, 'cancelActionId', path, state)
        if (submitActionId !== undefined && submitActionId === cancelActionId) invalid(`${path} submit and cancel action ids are duplicated`)
        for (const actionId of [submitActionId, cancelActionId]) if (actionId !== undefined) {
          if (actionId.trim().length === 0) invalid(`${path} action id must not be empty`)
        }
        return { kind, id, fields, ...optional(submitActionId, 'submitActionId'), ...optional(cancelActionId, 'cancelActionId') }
      }
      case 'actions': {
        const items = collection(required(object, 'items', path), `${path}.items`).map((item, index) => actionItem(item, `${path}.items[${String(index)}]`, state))
        uniqueIds(items, `${path}.items`)
        for (const item of items) {
          if (item.id.trim().length === 0) invalid(`${path}.items id must not be empty`)
          reserveControl(item.id, state)
        }
        return { kind, id: text(required(object, 'id', path), `${path}.id`, state), items }
      }
      case 'loader': {
        const variantValue = own(object, 'variant', path)
        const elapsedValue = own(object, 'elapsedMs', path)
        const cancelActionId = optionalText(object, 'cancelActionId', path, state)
        if (cancelActionId !== undefined) {
          if (cancelActionId.trim().length === 0) invalid(`${path}.cancelActionId must not be empty`)
          reserveControl(cancelActionId, state)
        }
        return { kind, message: text(required(object, 'message', path), `${path}.message`, state), ...optional(variantValue === undefined ? undefined : enumeration(variantValue, ['braille', 'tide'], `${path}.variant`), 'variant'), ...optional(elapsedValue === undefined ? undefined : finiteInteger(elapsedValue, `${path}.elapsedMs`), 'elapsedMs'), ...optional(cancelActionId, 'cancelActionId') }
      }
      case 'empty': {
        const actionsValue = own(object, 'actions', path)
        const actions = actionsValue === undefined ? undefined : node(actionsValue, `${path}.actions`, state, depth + 1, 'ui')
        if (actions !== undefined && actions.kind !== 'actions') invalid(`${path}.actions must be an actions node`)
        return { kind, title: text(required(object, 'title', path), `${path}.title`, state), ...optional(optionalText(object, 'description', path, state), 'description'), ...optional(actions, 'actions') }
      }
      case 'progress': {
        const maximum = finiteInteger(required(object, 'max', path), `${path}.max`, 1)
        const current = finiteInteger(required(object, 'value', path), `${path}.value`)
        return { kind, ...optional(optionalText(object, 'label', path, state), 'label'), value: Math.min(current, maximum), max: maximum }
      }
      case 'spacer': {
        const sizeValue = own(object, 'size', path)
        return { kind, ...optional(sizeValue === undefined ? undefined : enumeration(sizeValue, [1, 2] as const, `${path}.size`), 'size') }
      }
      case 'divider': return { kind, ...optional(optionalText(object, 'label', path, state), 'label') }
      case 'diagram': return { kind, diagram: enumeration(required(object, 'diagram', path), ['mermaid'], `${path}.diagram`), source: text(required(object, 'source', path), `${path}.source`, state) }
      case 'chart': {
        const chart = enumeration(required(object, 'chart', path), ['line', 'point', 'bar', 'sparkline', 'heatmap'], `${path}.chart`)
        if (chart === 'line' || chart === 'point') {
          const series = collection(required(object, 'series', path), `${path}.series`)
            .map((item, index) => chartSeries(item, `${path}.series[${String(index)}]`, state))
          uniqueIds(series, `${path}.series`)
          return {
            kind, chart, series,
            ...optional(optionalText(object, 'title', path, state), 'title'),
            ...optional(optionalText(object, 'xLabel', path, state), 'xLabel'),
            ...optional(optionalText(object, 'yLabel', path, state), 'yLabel'),
            ...optional(chartHeight(object, path), 'height'),
          }
        }
        if (chart === 'bar') {
          const layoutValue = own(object, 'layout', path)
          const categories = collection(required(object, 'categories', path), `${path}.categories`)
            .map((item, index) => text(item, `${path}.categories[${String(index)}]`, state))
          const series = collection(required(object, 'series', path), `${path}.series`)
            .map((item, index) => barSeries(item, `${path}.series[${String(index)}]`, state))
          uniqueIds(series, `${path}.series`)
          if (series.some(item => item.values.length !== categories.length)) invalid(`${path}.series values must match categories`)
          const layout = layoutValue === undefined ? undefined : enumeration(layoutValue, ['grouped', 'stacked', 'normalized'], `${path}.layout`)
          if (layout === 'normalized') {
            if (series.some(item => item.values.some(value => value !== null && value < 0))) invalid(`${path}.series normalized values must be non-negative`)
            for (let index = 0; index < categories.length; index += 1) {
              if (series.reduce((sum, item) => sum + (item.values[index] ?? 0), 0) <= 0) invalid(`${path}.series normalized category totals must be positive`)
            }
          }
          return {
            kind, chart,
            ...optional(layout, 'layout'),
            categories, series,
            ...optional(optionalText(object, 'title', path, state), 'title'),
            ...optional(optionalText(object, 'yLabel', path, state), 'yLabel'),
            ...optional(chartHeight(object, path), 'height'),
          }
        }
        if (chart === 'sparkline') {
          const values = collection(required(object, 'values', path), `${path}.values`)
            .map((item, index) => nullableNumber(item, `${path}.values[${String(index)}]`))
          addChartCells(state, values.length)
          return {
            kind, chart, values,
            ...optional(optionalText(object, 'label', path, state), 'label'),
            ...optional(chartTone(object, path), 'tone'),
          }
        }
        const columns = collection(required(object, 'columns', path), `${path}.columns`)
          .map((item, index) => text(item, `${path}.columns[${String(index)}]`, state))
        const rows = collection(required(object, 'rows', path), `${path}.rows`)
          .map((item, index) => text(item, `${path}.rows[${String(index)}]`, state))
        const values = collection(required(object, 'values', path), `${path}.values`).map((row, rowIndex) =>
          collection(row, `${path}.values[${String(rowIndex)}]`).map((item, columnIndex) => {
            if (item === null) return null
            if (typeof item === 'number') return finiteNumber(item, `${path}.values[${String(rowIndex)}][${String(columnIndex)}]`)
            return text(item, `${path}.values[${String(rowIndex)}][${String(columnIndex)}]`, state)
          }))
        addChartCells(state, values.reduce((sum, row) => sum + row.length, 0))
        if (values.length !== rows.length || values.some(row => row.length !== columns.length)) invalid(`${path}.values dimensions must match rows and columns`)
        const levels = collection(required(object, 'levels', path), `${path}.levels`)
          .map((item, index) => chartLevel(item, `${path}.levels[${String(index)}]`, state))
        const levelKeys = levels.map(level => `${typeof level.value}:${String(level.value)}`)
        if (new Set(levelKeys).size !== levelKeys.length) invalid(`${path}.levels contains duplicate values`)
        const known = new Set(levelKeys)
        if (values.some(row => row.some(value => value !== null && !known.has(`${typeof value}:${String(value)}`)))) invalid(`${path}.values contains a value without a level`)
        return { kind, chart, columns, rows, values, levels, ...optional(optionalText(object, 'title', path, state), 'title') }
      }
      default: invalid(`unknown Mayfly UI kind "${kind}"`)
    }
  })
}

function freeze<Value>(value: Value): Value {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) freeze(child)
  return Object.freeze(value)
}

function containsEditorControl(node: MayflyEditorShellNode): boolean {
  if (node.kind === 'editor-control') return true
  if (node.kind === 'stack') return node.children.some(child => containsEditorControl(child.node))
  if (node.kind === 'surface') return containsEditorControl(node.child) || (node.footer !== undefined && containsEditorControl(node.footer))
  return false
}

function assertEditorControlVisible(node: MayflyEditorShellNode, path = '$'): void {
  if (node.kind === 'stack') {
    for (const [index, child] of node.children.entries()) {
      const childPath = `${path}.children[${String(index)}]`
      if (containsEditorControl(child.node)) {
        if (child.when !== undefined) invalid(`${childPath}.when cannot hide editor-control`)
        if (child.maxSize === 0) invalid(`${childPath}.maxSize cannot hide editor-control`)
        if (child.basis === 0 && (child.grow ?? 0) === 0 && (child.minSize ?? 0) === 0) {
          invalid(`${childPath} cannot allocate zero size to editor-control`)
        }
      }
      assertEditorControlVisible(child.node, `${childPath}.node`)
    }
    return
  }
  if (node.kind === 'surface') {
    assertEditorControlVisible(node.child, `${path}.child`)
    if (node.footer !== undefined) assertEditorControlVisible(node.footer, `${path}.footer`)
  }
}

function validate<Value>(value: unknown, mode: ValidationMode): MayflyValidationResult<Value> {
  const state = validationState()
  try {
    const result = mode === 'ui'
      ? node(value, '$', state, 0, 'ui')
      : mode === 'status'
        ? node(value, '$', state, 0, 'status')
        : node(value, '$', state, 0, 'editor', false, true)
    if (mode === 'editor') {
      if (state.editorControls !== 1) invalid(`editor shell must contain exactly one editor-control; received ${String(state.editorControls)}`)
      assertEditorControlVisible(result as MayflyEditorShellNode)
    }
    validatePages(state.budget)
    return { ok: true, value: freeze(result) as Value }
  } catch (error) {
    if (error instanceof ValidationFault) return { ok: false, code: error.code, message: error.message }
    return { ok: false, code: 'MAYFLY_INVALID_CONTRIBUTION', message: 'Mayfly UI validation failed safely' }
  }
}

/** Validate, sanitize, canonicalize, and freeze an ordinary public UI tree. */
export function validateMayflyUiNode(value: unknown): MayflyValidationResult<MayflyUiNode> {
  return validate(value, 'ui')
}

/** Validate the recursively narrowed, non-interactive status tree. */
export function validateMayflyStatusNode(value: unknown): MayflyValidationResult<MayflyStatusNode> {
  return validate(value, 'status')
}

/** Validate an editor shell and require exactly one host-owned control slot. */
export function validateMayflyEditorShellNode(value: unknown): MayflyValidationResult<MayflyEditorShellNode> {
  return validate(value, 'editor')
}
