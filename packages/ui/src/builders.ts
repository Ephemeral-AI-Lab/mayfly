/** Pure builders for Mayfly's renderer-independent public UI wire format.
 * @module @ephemeral-ai/mayfly-ui/builders
 */
import type {
  MayflyListBodyNode,
  MayflyListBodyStackNode,
  MayflyActionsNode,
  MayflyChartNode,
  MayflyDividerNode,
  MayflyImageNode,
  MayflyDiagramNode,
  MayflyEmptyNode,
  MayflyFormNode,
  MayflyInlineSpan,
  MayflyListNode,
  MayflyLoaderNode,
  MayflyProgressNode,
  MayflyRichTextNode,
  MayflyScrollNode,
  MayflySection,
  MayflySpacerNode,
  MayflyStackNode,
  MayflySurfaceNode,
  MayflyTabsNode,
  MayflyUiChild,
  MayflyUiNode,
  MayflyMarkdownNode,
  MayflyTextNode,
  MayflyFieldsNode,
  MayflyCodeNode,
  MayflyDiffNode,
  MayflySectionsNode,
} from './contracts.ts'

type TextOptions = Omit<MayflyTextNode, 'kind' | 'content'>
type RichTextOptions = Omit<MayflyRichTextNode, 'kind' | 'spans'>
type CodeOptions = Omit<MayflyCodeNode, 'kind' | 'code'>
type DiffOptions = Omit<MayflyDiffNode, 'kind' | 'before' | 'after'>
type ChildOptions = Omit<MayflyUiChild, 'node'>
type StackOptions = Omit<MayflyStackNode, 'kind' | 'direction' | 'children'>
type ScrollOptions = Omit<MayflyScrollNode, 'kind' | 'child'>
type ChartOptions = MayflyChartNode extends infer Node
  ? Node extends MayflyChartNode ? Omit<Node, 'kind'> : never
  : never
const COMPONENT_ID_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
// Only snapshots created here are trusted; other module copies clone safely.
const wireSnapshots = new WeakSet<object>()

/** Deeply freeze a value in place while tolerating object cycles. */
export function deepFreeze<Value>(value: Value): Value {
  const seen = new WeakSet<object>()
  const visit = (current: unknown): void => {
    if (current === null || typeof current !== 'object' || seen.has(current)) return
    seen.add(current)
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(current))) {
      if ('value' in descriptor) visit(descriptor.value)
    }
    Object.freeze(current)
  }
  visit(value)
  return value
}

export function freezeWire<Value>(value: Value): Value {
  const clones = new WeakMap<object, object>()
  const active = new WeakSet<object>()
  const clone = (current: unknown): unknown => {
    if (current === null || typeof current !== 'object') return current
    if (wireSnapshots.has(current)) return current
    if (active.has(current)) throw new TypeError('Mayfly UI wire data must not contain cycles')
    const existing = clones.get(current)
    if (existing !== undefined) return existing
    const copy: unknown[] | Record<string, unknown> = Array.isArray(current) ? [] : {}
    clones.set(current, copy)
    active.add(current)
    for (const key of Object.keys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)!
      if (!('value' in descriptor)) throw new TypeError('Mayfly UI wire data must not contain accessors')
      Object.defineProperty(copy, key, {
        value: clone(descriptor.value), enumerable: true, writable: true, configurable: true,
      })
    }
    active.delete(current)
    Object.freeze(copy)
    wireSnapshots.add(copy)
    return copy
  }
  return clone(value) as Value
}

/**
 * Whether `value` is a snapshot made by {@link freezeWire} in this module copy. Every object a snapshot contains is one
 * too, so a true answer means the whole subtree is deeply immutable and its identity can key a cache.
 */
export function isWireSnapshot(value: unknown): boolean {
  return typeof value === 'object' && value !== null && wireSnapshots.has(value)
}

const frozen = freezeWire

function text(content: string, options: TextOptions = {}): MayflyTextNode {
  return frozen({ ...frozen(options), kind: 'text', content })
}

function markdown(source: string): MayflyMarkdownNode {
  return frozen({ kind: 'markdown', source })
}

function fields(rows: MayflyFieldsNode['rows']): MayflyFieldsNode {
  return frozen({ kind: 'fields', rows })
}

function code(value: string, options: CodeOptions = {}): MayflyCodeNode {
  return frozen({ ...frozen(options), kind: 'code', code: value })
}

function diff(before: string, after: string, options: DiffOptions = {}): MayflyDiffNode {
  return frozen({ ...frozen(options), kind: 'diff', before, after })
}

function sections(value: readonly MayflySection[]): MayflySectionsNode {
  return frozen({ kind: 'sections', sections: value })
}

function richText(spans: readonly MayflyInlineSpan[], options: RichTextOptions = {}): MayflyRichTextNode {
  return frozen({ ...frozen(options), kind: 'rich-text', spans })
}

function child(node: MayflyUiNode, options: ChildOptions = {}): MayflyUiChild {
  return frozen({ ...frozen(options), node })
}

type MayflyStackBareNode = MayflyUiNode & {
  readonly basis?: never
  readonly grow?: never
  readonly shrink?: never
  readonly minSize?: never
  readonly maxSize?: never
  readonly when?: never
  readonly tab?: never
  readonly priority?: never
  readonly band?: never
}
export type MayflyStackItem = MayflyStackBareNode | (MayflyUiChild & { readonly kind?: never })

function stack(direction: MayflyStackNode['direction'], children: readonly MayflyStackItem[], options: StackOptions = {}): MayflyStackNode {
  const normalized: MayflyUiChild[] = frozen(children).map(item => 'kind' in item ? { node: item as MayflyUiNode } : item)
  return frozen({ ...frozen(options), kind: 'stack', direction, children: normalized })
}

/** A list row's body: a column of content nodes, which a row can open under itself and which never takes focus. */
function listBody(children: readonly MayflyListBodyNode[], options: StackOptions = {}): MayflyListBodyStackNode {
  return frozen({ ...frozen(options), kind: 'stack', direction: 'column', children: frozen(children).map(node => ({ node })) })
}

function surface(options: Omit<MayflySurfaceNode, 'kind'>): MayflySurfaceNode {
  return frozen({ ...frozen(options), kind: 'surface' })
}

function scroll(node: MayflyUiNode, options: ScrollOptions = {}): MayflyScrollNode {
  return frozen({ ...frozen(options), kind: 'scroll', child: node })
}

function tabs(options: Omit<MayflyTabsNode, 'kind'>): MayflyTabsNode {
  return frozen({ ...frozen(options), kind: 'tabs' })
}

function list(options: Omit<MayflyListNode, 'kind'>): MayflyListNode {
  return frozen({ ...frozen(options), kind: 'list' })
}

function form(options: Omit<MayflyFormNode, 'kind'>): MayflyFormNode {
  return frozen({ ...frozen(options), kind: 'form' })
}

function actions(options: Omit<MayflyActionsNode, 'kind'>): MayflyActionsNode {
  return frozen({ ...frozen(options), kind: 'actions' })
}

function loader(options: Omit<MayflyLoaderNode, 'kind'>): MayflyLoaderNode {
  return frozen({ ...frozen(options), kind: 'loader' })
}

function empty(options: Omit<MayflyEmptyNode, 'kind'>): MayflyEmptyNode {
  return frozen({ ...frozen(options), kind: 'empty' })
}

function progress(options: Omit<MayflyProgressNode, 'kind'>): MayflyProgressNode {
  return frozen({ ...frozen(options), kind: 'progress' })
}

function spacer(options: Omit<MayflySpacerNode, 'kind'> = {}): MayflySpacerNode {
  return frozen({ ...frozen(options), kind: 'spacer' })
}

function divider(options: Omit<MayflyDividerNode, 'kind'> = {}): MayflyDividerNode {
  return frozen({ ...frozen(options), kind: 'divider' })
}

function image(options: Omit<MayflyImageNode, 'kind'>): MayflyImageNode {
  return frozen({ ...frozen(options), kind: 'image' })
}

function diagram(source: string): MayflyDiagramNode {
  return frozen({ kind: 'diagram', diagram: 'mermaid', source })
}

function chart(options: ChartOptions): MayflyChartNode {
  return frozen({ ...frozen(options), kind: 'chart' } as MayflyChartNode)
}

/** Pure builder namespace. Every result is recursively frozen. */
export const ui = Object.freeze({
  text,
  markdown,
  fields,
  code,
  diff,
  sections,
  richText,
  child,
  listBody,
  stack: Object.freeze({
    row: (children: readonly MayflyStackItem[], options?: StackOptions) => stack('row', children, options),
    column: (children: readonly MayflyStackItem[], options?: StackOptions) => stack('column', children, options),
  }),
  surface,
  scroll,
  tabs,
  list,
  form,
  actions,
  loader,
  empty,
  progress,
  spacer,
  divider,
  image,
  diagram,
  chart,
})

/** User-kit component definition before runtime hardening. */
export interface MayflyComponentDefinition<Props> {
  readonly id: string
  readonly render: (props: Props) => MayflyUiNode
  /**
   * With `true`, a call whose props are shallowly equal to the previous call's returns the node that call returned, so
   * an unchanged component keeps its identity and core's identity caches hit. `render` must be pure for this to hold.
   */
  readonly memo?: boolean
}

/** Pure component factory returned to official packages and third-party kits. */
export interface MayflyComponentFactory<Props> {
  readonly id: string
  readonly render: (props: Props) => MayflyUiNode
}

function shallowEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null || Array.isArray(left) !== Array.isArray(right)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.hasOwn(right, key) && Object.is((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
}

/** A copy of the props one level deep, so a caller that mutates the object it passed cannot make a stale call look equal. */
function propsSnapshot(props: unknown): unknown {
  if (typeof props !== 'object' || props === null) return props
  return Array.isArray(props) ? [...props] : { ...props }
}

/** Define a pure component factory; core remains responsible for node validation. */
export function defineMayflyComponent<Props>(definition: MayflyComponentDefinition<Props>): MayflyComponentFactory<Props> {
  if (definition === null || typeof definition !== 'object') throw new TypeError('Mayfly component definition must be an object')
  if (typeof definition.id !== 'string' || !COMPONENT_ID_PATTERN.test(definition.id)) throw new TypeError('Mayfly component id must be a namespaced lowercase identifier')
  if (typeof definition.render !== 'function') throw new TypeError('Mayfly component render must be a function')
  if (definition.memo !== true) {
    return Object.freeze({
      id: definition.id,
      render: (props: Props): MayflyUiNode => frozen(definition.render(props)),
    })
  }
  let previous: { readonly props: unknown, readonly node: MayflyUiNode } | undefined
  return Object.freeze({
    id: definition.id,
    render: (props: Props): MayflyUiNode => {
      if (previous !== undefined && shallowEqual(previous.props, props)) return previous.node
      const node = frozen(definition.render(props))
      previous = { props: propsSnapshot(props), node }
      return node
    },
  })
}
