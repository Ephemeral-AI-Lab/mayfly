/** Stable surface drafts and action execution, independent of a terminal renderer.
 * @module @ephemeral-ai/mayfly/core/ui-interaction-surface
 */
import { freezeWire } from '@ephemeral-ai/mayfly-ui'
import type {
  MayflyActionItem, MayflyFeedback, MayflyFeedbackRecord, MayflyFieldAddress, MayflyFieldValue, MayflyFormAddress,
  MayflyFormNode, MayflyPagePath, MayflySnapshotChange, MayflySourceStamp, MayflySubmission,
  MayflyScrollNode, MayflyTabsNode, MayflyUiActionReply, MayflyUiEvent, MayflyUiEventEndpoint, MayflyUiNode, MayflyUiScope,
} from '@ephemeral-ai/mayfly-ui'
import { createFormState, formAddressKey, formDirty, inspectForm, reconcileForm, reduceForm, submitForm, validateForm, type UiFormIntent, type UiFormState } from './ui-interaction-form.ts'
import { acknowledgeChoice, choiceError, createChoiceState, reconcileChoice, reduceChoice, type UiChoiceIntent, type UiChoiceState } from './ui-interaction-choice.ts'
import { prepareUiForms, uiControlKey, uiDeclarations, visitUiControls, type UiControlAddress } from './ui-interaction-tree.ts'
import { admittedListIndex, admittedListItem, validateMayflyUiNode } from './ui-validator.ts'
import { moveDocument, reconcileDocument, type UiDocumentAnchor, type UiDocumentState } from './ui-interaction-document.ts'
import { admitNotificationMessage, UiNotificationStore } from './ui-interaction-notifications.ts'

export interface UiSurfaceSnapshot {
  readonly id: string
  readonly node: MayflyUiNode | null
  readonly revision: number
  readonly source: readonly MayflySourceStamp[]
  readonly scope: MayflyUiScope
  readonly update: MayflySnapshotChange
  readonly events: MayflyUiEventEndpoint<MayflyUiNode | null>
  readonly definition: { readonly onEvent?: unknown, readonly dismissal?: 'confirm-dirty' | 'discard' }
}

interface UiAction {
  readonly item: MayflyActionItem
  readonly pagePath: MayflyPagePath
  readonly close?: boolean
}

export interface UiAvailableAction {
  readonly actionId: string
  readonly pagePath: MayflyPagePath
  readonly verb: 'activate' | 'read' | 'submit' | 'navigate' | 'dismiss'
  readonly enabled: boolean
  readonly pending: boolean
  readonly targetRevision: number
  readonly disabledReason?: string
}

interface UiOperation {
  readonly id: string
  readonly key: string
  readonly actionId: string
  readonly phase: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'
}

interface UiTask {
  readonly id: string
  readonly key: string
  readonly controller: AbortController
  readonly event: MayflyUiEvent
  readonly source: readonly MayflySourceStamp[]
  readonly sourceNode: MayflyUiNode | null
  readonly submission?: MayflySubmission
  readonly formKeys: ReadonlySet<string>
}

interface UiDecision {
  readonly question: string
  readonly event: Extract<MayflyUiEvent, { readonly kind: 'activate' }> | undefined
  readonly source: readonly MayflySourceStamp[]
  readonly focus?: UiControlAddress
}

export interface UiSurfaceBindings {
  readonly close?: () => void
  readonly onObserverError?: (error: unknown) => void
}

const DECISION_NO = 'mayfly.decision.no'
const DECISION_YES = 'mayfly.decision.yes'
const DISPOSED_EVENTS: MayflyUiEventEndpoint<MayflyUiNode | null> = Object.freeze({
  prepare: async () => Object.freeze({ reply: undefined, publish: () => false }),
})

export function sameUiSource(left: readonly MayflySourceStamp[], right: readonly MayflySourceStamp[]): boolean {
  return left.length === right.length && left.every(stamp => right.some(other => other.resourceId === stamp.resourceId && other.revision === stamp.revision))
}

function baselineData(node: MayflyUiNode | null): string {
  const controls: [string, unknown][] = []
  if (node !== null) visitUiControls(node, (current, pagePath) => {
    if (current.kind === 'form') controls.push([uiControlKey({ pagePath, controlId: current.id }), current.fields.map(field => [field.id, field.kind, Array.isArray(field.value) ? field.value.toSorted() : field.value, field.origin ?? 'explicit']).toSorted((left, right) => String(left[0]).localeCompare(String(right[0])))])
    else if (current.kind === 'list') controls.push([uiControlKey({ pagePath, controlId: current.id }), current.selectedIds.toSorted()])
  })
  return JSON.stringify(controls.toSorted((left, right) => left[0].localeCompare(right[0])))
}

/** One registration instance owns every draft and continuation for its surface. */
export class UiSurfaceModel {
  private live = true
  private rawNode: MayflyUiNode | null = null
  private admittedNode: MayflyUiNode | null = null
  private admissionError: MayflyUiNode | undefined
  private input: UiSurfaceSnapshot
  private readonly forms = new Map<string, UiFormState>()
  private readonly formDefinitions = new Map<string, MayflyFormNode>()
  private readonly choices = new Map<string, UiChoiceState>()
  private readonly tabs = new Map<string, { readonly definition: MayflyTabsNode, readonly activeId: string, readonly completed: ReadonlyMap<string, string> }>()
  private readonly documents = new Map<string, UiDocumentState>()
  private readonly actions = new Map<string, UiAction>()
  private readonly listeners = new Set<() => void>()
  private readonly tasks = new Map<string, UiTask>()
  private readonly activeKeys = new Map<string, string>()
  private readonly operations = new Map<string, UiOperation>()
  private readonly notifications: UiNotificationStore
  private decision: UiDecision | undefined
  private selectedControl: UiControlAddress | undefined
  private revisionValue = 0
  private nextOperation = 0
  private publication: { readonly source: MayflyUiNode, readonly admitted: MayflyUiNode } | undefined

  constructor(readonly instanceId: string, snapshot: UiSurfaceSnapshot, private bindings: UiSurfaceBindings = {}) {
    this.input = snapshot
    this.notifications = new UiNotificationStore(() => this.changed())
    this.receive(snapshot)
  }

  get disposed(): boolean { return !this.live }
  get revision(): number { return this.revisionValue }
  get id(): string { return this.input.id }
  get scope(): MayflyUiScope { return this.input.scope }
  get source(): readonly MayflySourceStamp[] { return this.input.source }
  get endpoint(): UiSurfaceSnapshot['events'] { return this.input.events }
  get registration(): UiSurfaceSnapshot { return this.input }
  get node(): MayflyUiNode | null { return this.admittedNode ?? this.admissionError ?? null }
  get focus(): UiControlAddress | undefined { return this.decision === undefined ? this.selectedControl : this.decision.focus }
  get dirty(): boolean { return [...this.forms.values()].some(formDirty) || [...this.choices.values()].some(choice => choice.dirty) }
  get decisionNode(): MayflyUiNode | undefined {
    if (this.decision === undefined) return undefined
    return freezeWire({ kind: 'surface', chrome: 'overlay', title: this.decision.question, child: {
      kind: 'actions', id: 'mayfly.decision', items: [
        { id: DECISION_NO, label: 'No', defaultFocus: true }, { id: DECISION_YES, label: 'Yes' },
      ],
    } })
  }

  subscribe(listener: () => void): () => void {
    if (!this.live) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  form(address: MayflyFormAddress): UiFormState | undefined { return this.forms.get(formAddressKey(address)) }
  choice(address: UiControlAddress): UiChoiceState | undefined { return this.choices.get(uiControlKey(address)) }
  activeTab(address: UiControlAddress): string | undefined { return this.tabs.get(uiControlKey(address))?.activeId }
  completedSteps(address: UiControlAddress): readonly string[] {
    const tabs = this.tabs.get(uiControlKey(address))
    if (tabs?.definition.mode !== 'wizard') return []
    return tabs.definition.items.filter(item => tabs.completed.get(item.id) === this.stepRevision([...address.pagePath, { controlId: address.controlId, itemId: item.id }])).map(item => item.id)
  }
  document(address: UiControlAddress): UiDocumentState | undefined { return this.documents.get(uiControlKey(address)) }
  moveDocument(address: UiControlAddress, anchor: UiDocumentAnchor): void {
    const key = uiControlKey(address)
    const current = this.documents.get(key)
    if (current !== undefined) this.documents.set(key, moveDocument(current, anchor))
  }

  private stepRevision(pagePath: MayflyPagePath): string {
    const path = JSON.stringify(pagePath)
    return JSON.stringify([...this.forms].filter(([, form]) => JSON.stringify(form.address.pagePath.slice(0, pagePath.length)) === path)
      .map(([key, form]) => [key, form.draftRevision, form.schemaRevision, Object.values(form.fields).map(field => [field.definition.id, field.revision, field.conflict, field.error !== undefined]).toSorted((left, right) => String(left[0]).localeCompare(String(right[0])))]).toSorted((left, right) => String(left[0]).localeCompare(String(right[0]))))
  }
  feedbackSnapshot(): readonly MayflyFeedbackRecord[] { return this.notifications.snapshot() }
  setVisible(visible: boolean): void { if (this.live) this.notifications.setVisible(visible) }
  operationSnapshot(): readonly UiOperation[] { return freezeWire([...this.operations.values()]) }
  availableActions(): readonly UiAvailableAction[] {
    return freezeWire([...this.actions.values()].map(action => {
      const key = uiControlKey({ pagePath: action.pagePath, controlId: action.item.id })
      const pending = this.activeKeys.has(key) || action.item.busy === true
      const verb = action.close || action.item.dismiss === true ? 'dismiss'
        : action.item.submit !== undefined ? 'submit'
          : action.item.read !== undefined ? 'read'
            : action.item.navigate !== undefined ? 'navigate' : 'activate'
      return {
        actionId: action.item.id,
        pagePath: action.pagePath,
        verb,
        enabled: action.item.disabled !== true && !pending,
        pending,
        targetRevision: this.revision,
        ...(action.item.disabledReason === undefined ? {} : { disabledReason: action.item.disabledReason }),
      }
    }))
  }
  inspect() { return freezeWire({ id: this.id, instanceId: this.instanceId, scope: this.scope, revision: this.revision, forms: [...this.forms.values()].map(inspectForm), operations: this.operationSnapshot() }) }

  focusControl(address: UiControlAddress): void {
    const previous = this.focus
    if (!this.live || (previous !== undefined && uiControlKey(previous) === uiControlKey(address) && previous.itemId === address.itemId)) return
    if (this.decision === undefined) this.selectedControl = freezeWire(address)
    else this.decision = { ...this.decision, focus: freezeWire(address) }
    this.changed()
  }

  receive(snapshot: UiSurfaceSnapshot): void {
    if (!this.live) return
    if (snapshot.events !== this.input.events) throw new Error('replacement requires a new surface instance')
    if (snapshot.node === this.rawNode && snapshot.revision === this.input.revision) {
      this.input = snapshot
      this.changed()
      return
    }
    if (snapshot.node === null) {
      this.admissionError = undefined
      this.notifications.clear('snapshot', false)
      this.cancelTasks()
      this.forms.clear(); this.formDefinitions.clear(); this.choices.clear(); this.tabs.clear(); this.documents.clear(); this.actions.clear()
      this.rawNode = null; this.admittedNode = null; this.input = snapshot
      this.changed()
      return
    }
    const admitted = this.publication?.source === snapshot.node ? { ok: true as const, value: this.publication.admitted }
      : snapshot.node === this.rawNode && this.admittedNode !== null ? { ok: true as const, value: this.admittedNode } : validateMayflyUiNode(snapshot.node)
    if (!admitted.ok) {
      this.admissionError = freezeWire({ kind: 'text', tone: 'danger', content: admitted.message })
      this.report('snapshot', { severity: 'error', message: admitted.message })
      return
    }
    this.admissionError = undefined
    this.notifications.clear('snapshot', false)
    const sourceChanged = !sameUiSource(this.input.source, snapshot.source)
    this.rawNode = snapshot.node
    this.admittedNode = admitted.value
    this.input = snapshot
    if (this.decision !== undefined && sourceChanged) this.decision = undefined
    this.reconcileControls(snapshot.update)
    this.changed()
  }

  /** Admit a newly visible responsive branch after the renderer validates it. */
  admitVisibleControls(): void {
    if (!this.live || this.admittedNode === null) return
    if (this.reconcileControls({ reason: 'data' })) this.changed()
  }

  private reconcileControls(update: MayflySnapshotChange): boolean {
    const node = this.admittedNode!
    const declarations = uiDeclarations(this.rawNode)
    let changed = false
    for (const [key, state] of this.forms) {
      const declared = declarations.controls.get(key)
      if (declarations.complete && (declared === undefined || declared.kind !== 'form')) { this.forms.delete(key); this.formDefinitions.delete(key); changed = true; continue }
      if (declared?.fields !== undefined) {
        const fields = state.definition.fields.filter(field => declared.fields!.get(field.id) === field.kind)
        if (fields.length !== state.definition.fields.length) {
          this.forms.set(key, reconcileForm(state, { ...state.definition, fields }))
          changed = true
        }
      }
    }
    for (const [key] of this.choices) if (declarations.complete && declarations.controls.get(key)?.kind !== 'list') { this.choices.delete(key); changed = true }
    for (const [key] of this.tabs) if (declarations.complete && declarations.controls.get(key)?.kind !== 'tabs') { this.tabs.delete(key); changed = true }
    for (const [key] of this.documents) if (declarations.complete && declarations.controls.get(key)?.kind !== 'scroll') { this.documents.delete(key); changed = true }
    this.actions.clear()
    visitUiControls(node, (current, pagePath) => {
      if (current.kind === 'form') {
        const address = { pagePath, formId: current.id }
        const key = formAddressKey(address)
        const previous = this.forms.get(key)
        let next = previous === undefined ? createFormState(address, current) : this.formDefinitions.get(key) === current ? previous : reconcileForm(previous, current)
        if (update.reason === 'ack' && previous !== undefined) {
          const task = this.tasks.get(update.operationId)
          const submitted = task?.submission?.forms.find(form => formAddressKey(form) === key)
          if (submitted !== undefined && task?.submission?.draftRevision === update.draftRevision) {
            next = update.acceptedFields === undefined
              ? reduceForm(previous, { kind: 'ack', operationId: update.operationId, draftRevision: submitted.draftRevision, definition: current })
              : reduceForm(previous, { kind: 'ack-fields', operationId: update.operationId, draftRevision: submitted.draftRevision, definition: current, fieldIds: update.acceptedFields.filter(field => formAddressKey(field) === key).map(field => field.fieldId) })
          }
        }
        this.forms.set(key, next)
        this.formDefinitions.set(key, current)
        changed ||= next !== previous
        if (current.submitActionId !== undefined) {
          const actionKey = uiControlKey({ pagePath, controlId: current.submitActionId })
          const previousAction = this.actions.get(actionKey)
          this.actions.set(actionKey, { pagePath, item: { id: current.submitActionId, label: 'Save', ...previousAction?.item, submit: previousAction?.item.submit ?? [address] } })
        }
        if (current.cancelActionId !== undefined) this.actions.set(uiControlKey({ pagePath, controlId: current.cancelActionId }), { pagePath, item: { id: current.cancelActionId, label: 'Cancel' }, close: true })
      } else if (current.kind === 'list') {
        const key = uiControlKey({ pagePath, controlId: current.id })
        const previous = this.choices.get(key)
        const task = update.reason === 'ack' ? this.tasks.get(update.operationId) : undefined
        const accepted = update.reason === 'ack' && update.acceptedFields === undefined && (task?.submission?.selections?.some(selection => uiControlKey(selection) === key) === true || (task?.event.kind === 'selection-accept' && uiControlKey(task.event) === key))
        const submittedSelection = accepted ? task?.submission?.selections?.find(selection => uiControlKey(selection) === key)?.selectedIds : undefined
        const next = previous === undefined ? createChoiceState(current) : accepted ? acknowledgeChoice(previous, current, submittedSelection) : reconcileChoice(previous, current)
        this.choices.set(key, next)
        changed ||= next !== previous
      } else if (current.kind === 'tabs') {
        const key = uiControlKey({ pagePath, controlId: current.id })
        const previous = this.tabs.get(key)
        const activeId = previous !== undefined && current.items.some(item => item.id === previous.activeId && item.disabled !== true) ? previous.activeId : current.activeId
        if (previous?.definition !== current || previous.activeId !== activeId) {
          this.tabs.set(key, { definition: current, activeId, completed: new Map([...(current.mode === previous?.definition.mode ? previous?.completed : undefined) ?? []].filter(([id]) => current.items.some(item => item.id === id))) }); changed = true
        }
      } else if (current.kind === 'scroll' && current.id !== undefined) {
        const key = uiControlKey({ pagePath, controlId: current.id })
        const previous = this.documents.get(key)
        const next = reconcileDocument(previous, current as MayflyScrollNode)
        this.documents.set(key, next)
        changed ||= next !== previous
      } else if (current.kind === 'actions') {
        for (const item of current.items) {
          const key = uiControlKey({ pagePath, controlId: item.id })
          const previous = this.actions.get(key)
          this.actions.set(key, { pagePath, item: { ...previous?.item, ...item }, close: previous?.close === true })
        }
      } else if (current.kind === 'loader' && current.cancelActionId !== undefined) {
        this.actions.set(uiControlKey({ pagePath, controlId: current.cancelActionId }), { pagePath, item: { id: current.cancelActionId, label: 'Cancel' } })
      }
    })
    for (const task of this.tasks.values()) {
      if (update.reason === 'ack' && update.operationId === task.id) continue
      if ([...task.formKeys].some(key => {
        const state = this.forms.get(key)
        return state === undefined || (state.pending?.operationId === task.id && state.pending.schemaRevision !== state.schemaRevision)
      })) task.controller.abort()
    }
    return changed
  }

  edit(address: MayflyFieldAddress, value: MayflyFieldValue): void {
    const state = this.form(address)
    if (!this.live || state === undefined || this.decision !== undefined) return
    const next = reduceForm(state, { kind: 'edit', fieldId: address.fieldId, value })
    if (next === state) return
    this.forms.set(formAddressKey(address), next)
    this.changed()
    this.observe({ kind: 'value-change', pagePath: address.pagePath, controlId: address.fieldId, formId: address.formId, value, draftRevision: next.fields[address.fieldId]!.revision })
  }

  updateForm(address: MayflyFormAddress, intent: UiFormIntent): void {
    const state = this.form(address)
    if (!this.live || state === undefined) return
    const next = reduceForm(state, intent)
    if (next !== state) {
      this.forms.set(formAddressKey(address), next)
      this.changed()
      if (intent.kind === 'edit' || intent.kind === 'reset' || intent.kind === 'resolve-conflict' || (intent.kind === 'finish-picker' && !intent.cancel)) {
        const field = next.fields[intent.fieldId]!
        this.observe({ kind: 'value-change', pagePath: address.pagePath, formId: address.formId, controlId: intent.fieldId, value: field.value, draftRevision: field.revision })
      }
    }
  }

  updateChoice(address: UiControlAddress, intent: UiChoiceIntent): void {
    const state = this.choice(address)
    if (!this.live || state === undefined || this.decision !== undefined) return
    const next = reduceChoice(state, intent)
    if (next === state) return
    this.choices.set(uiControlKey(address), next)
    this.changed()
  }

  activateTab(address: UiControlAddress, tabId: string): void {
    const key = uiControlKey(address)
    const current = this.tabs.get(key)
    if (!this.live || this.decision !== undefined || current === undefined || current.activeId === tabId || !current.definition.items.some(item => item.id === tabId && item.disabled !== true)) return
    this.tabs.set(key, { ...current, activeId: tabId })
    this.changed()
    this.observe({ kind: 'tab-change', ...address, tabId })
  }

  /** Explicit page links share validation and focus restoration across all consumers. */
  private canNavigate(pagePath: MayflyPagePath): boolean {
    return pagePath.length > 0 && pagePath.every((segment, index) => this.tabs.get(uiControlKey({ pagePath: pagePath.slice(0, index), controlId: segment.controlId }))?.definition.items.some(item => item.id === segment.itemId && item.disabled !== true))
  }

  private navigate(pagePath: MayflyPagePath): boolean {
    if (!this.canNavigate(pagePath)) return false
    for (const [index, segment] of pagePath.entries()) this.activateTab({ pagePath: pagePath.slice(0, index), controlId: segment.controlId }, segment.itemId)
    const preferred = [...this.actions.values()].find(action => action.item.defaultFocus === true && JSON.stringify(action.pagePath) === JSON.stringify(pagePath))
    const field = [...this.forms.values()].find(form => JSON.stringify(form.address.pagePath) === JSON.stringify(pagePath))?.definition.fields.find(field => field.disabled !== true)
    this.focusControl(preferred !== undefined ? { pagePath, controlId: preferred.item.id } : field !== undefined ? { pagePath, controlId: field.id } : { pagePath: pagePath.slice(0, -1), controlId: pagePath.at(-1)!.controlId, itemId: pagePath.at(-1)!.itemId })
    return true
  }

  back(): boolean {
    const target = this.backTarget()
    return target !== undefined && this.navigate(target)
  }

  backTarget(): MayflyPagePath | undefined {
    if (!this.live || this.decision !== undefined || this.admittedNode === null) return undefined
    let target: MayflyPagePath | undefined
    visitUiControls(this.admittedNode, (node, pagePath) => {
      if (node.kind !== 'tabs' || !pagePath.every((segment, index) => this.activeTab({ pagePath: pagePath.slice(0, index), controlId: segment.controlId }) === segment.itemId)) return
      const item = node.items.find(item => item.id === this.activeTab({ pagePath, controlId: node.id }))
      if (item?.backId !== undefined && (target === undefined || target.length <= pagePath.length + 1)) target = [...pagePath, { controlId: node.id, itemId: item.backId }]
    })
    return target
  }

  emit(event: MayflyUiEvent): void {
    if (!this.live) return
    if (this.decision !== undefined) {
      if (event.kind === 'dismiss') this.answerDecision(false)
      else if (event.kind === 'activate' && (event.actionId === DECISION_YES || event.actionId === DECISION_NO)) this.answerDecision(event.actionId === DECISION_YES)
      return
    }
    switch (event.kind) {
      case 'value-change': this.edit({ pagePath: event.pagePath, formId: event.formId, fieldId: event.controlId }, event.value); break
      case 'tab-change': this.activateTab(event, event.tabId); break
      case 'dismiss': this.requestClose(); break
      case 'selection-toggle':
        this.updateChoice(event, { kind: 'select', ids: event.selectedIds })
        this.observe(event)
        break
      case 'selection-accept': this.acceptSelection(event); break
      case 'submit': this.invoke(event.submission.actionId, event.pagePath); break
      case 'activate': this.invoke(event.actionId, event.pagePath, false, event); break
    }
  }

  invoke(actionId: string, pagePath: MayflyPagePath = [], confirmed = false, supplied?: Extract<MayflyUiEvent, { readonly kind: 'activate' }>): void {
    if (!this.live || this.decision !== undefined) return
    const key = uiControlKey({ pagePath, controlId: actionId })
    const action = this.actions.get(key)
    if (action === undefined || action.item.disabled === true || action.item.busy === true || this.activeKeys.has(key)) return
    if (action.close || action.item.dismiss === true) { this.requestClose(); return }
    const event = supplied ?? { kind: 'activate' as const, pagePath, controlId: actionId, actionId }
    if (!confirmed && action.item.confirm !== undefined) { this.decision = { question: action.item.confirm, event, source: this.source }; this.changed(); return }
    const targets = action.item.submit ?? action.item.read
    if (targets !== undefined) {
      try {
        prepareUiForms(this.admittedNode!, targets)
        this.admitVisibleControls()
      } catch {
        this.report(key, { message: 'A submitted form is unavailable or invalid', severity: 'error' })
        return
      }
      for (const address of targets) for (const field of Object.values(this.form(address)!.fields)) {
        if (field.picker !== undefined) this.updateForm(address, { kind: 'finish-picker', fieldId: field.definition.id, cancel: false })
      }
    }
    const forms = targets?.map(address => this.form(address)) ?? []
    if (forms.some(form => form === undefined || form.pending !== undefined)) return
    const validatedForms = new Set(forms.map(form => formAddressKey(form!.address)))
    for (const task of this.tasks.values()) {
      if (task.event.kind === 'value-change' && validatedForms.has(formAddressKey({ pagePath: task.event.pagePath, formId: task.event.formId }))) task.controller.abort()
    }
    const errors = forms.flatMap(form => validateForm(form!))
    if (errors.length > 0) {
      for (const error of errors) {
        const field = this.form(error)!.fields[error.fieldId]!
        this.updateForm(error, { kind: 'validated', fieldId: error.fieldId, revision: field.revision, error: error.message })
      }
      const first = errors[0]!
      this.selectedControl = { pagePath: first.pagePath, controlId: first.fieldId }
      for (const segment of first.pagePath) {
        const parent = first.pagePath.slice(0, first.pagePath.indexOf(segment))
        this.activateTab({ pagePath: parent, controlId: segment.controlId }, segment.itemId)
      }
      this.report(key, { message: errors[0]!.message, severity: 'error' })
      return
    }
    const selections = (action.item.selections ?? []).map(address => {
      const state = this.choice(address)
      if (state !== undefined && state.definition.role === 'browse' && state.selectedIds.length === 0 && state.focusedId !== undefined) {
        return { address, state: { ...state, selectedIds: [state.focusedId] } }
      }
      return { address, state }
    })
    for (const selection of selections) {
      const message = selection.state === undefined ? 'A selection is no longer available' : choiceError(selection.state)
      if (message !== undefined) { this.focusControl(selection.address); this.report(key, { message, severity: 'error' }); return }
    }
    if (action.item.navigate !== undefined) {
      if (!this.canNavigate(action.item.navigate)) { this.report(key, { message: 'The destination page is unavailable', severity: 'error' }); return }
      if (targets !== undefined) for (const [index, segment] of pagePath.entries()) {
        const address = { pagePath: pagePath.slice(0, index), controlId: segment.controlId }
        const key = uiControlKey(address)
        const tabs = this.tabs.get(key)
        if (tabs?.definition.mode !== 'wizard') continue
        const stepPath = pagePath.slice(0, index + 1)
        const stepForms = [...this.forms.values()].filter(form => JSON.stringify(form.address.pagePath.slice(0, stepPath.length)) === JSON.stringify(stepPath))
        if (stepForms.length === 0 || stepForms.some(form => !targets.some(target => formAddressKey(target) === formAddressKey(form.address)))) continue
        const completed = new Map(tabs.completed)
        completed.set(segment.itemId, this.stepRevision(stepPath))
        this.tabs.set(key, { ...tabs, completed })
      }
      this.clearFeedback(key)
      this.navigate(action.item.navigate)
      return
    }
    const inputs = targets === undefined && selections.length === 0 ? undefined : freezeWire({ actionId, draftRevision: this.revision, source: this.source, forms: forms.map(form => submitForm(form!)), selections: selections.map(selection => ({ ...selection.address, selectedIds: selection.state!.selectedIds })) })
    const submission = action.item.submit === undefined ? undefined : inputs
    this.start(key, submission !== undefined ? { kind: 'submit', pagePath, controlId: forms[0]!.definition.id, submission }
      : inputs !== undefined ? { kind: 'activate', pagePath, controlId: actionId, actionId, inputs } : event, submission)
  }

  private acceptSelection(event: Extract<MayflyUiEvent, { readonly kind: 'selection-toggle' | 'selection-accept' }>): void {
    const key = uiControlKey(event)
    const state = this.choices.get(key)
    if (state === undefined) return
    if (state.definition.role === 'browse') {
      const id = event.selectedIds[0]
      const item = id === undefined ? undefined : admittedListItem(state.definition.items, admittedListIndex(state.definition.items, id))
      if (item === undefined || item.disabled === true) return
    } else {
      const next = reduceChoice(state, { kind: 'select', ids: event.selectedIds })
      const error = choiceError(next)
      this.choices.set(key, next)
      if (error !== undefined) { this.report(key, { message: error, severity: 'error' }); return }
    }
    if (!this.activeKeys.has(key)) this.start(key, { ...event, selectedIds: state.definition.role === 'browse' ? event.selectedIds : this.choices.get(key)!.selectedIds })
  }

  requestClose(): void {
    if (!this.live) return
    if (this.back()) return
    if (this.dirty && this.input.definition.dismissal !== 'discard') { this.decision = { question: 'Discard unsaved changes?', event: undefined, source: this.source }; this.changed() }
    else this.finishClose()
  }

  answerDecision(yes: boolean): void {
    const decision = this.decision
    if (!this.live || decision === undefined) return
    this.decision = undefined
    this.changed()
    if (!yes || !sameUiSource(decision.source, this.source)) return
    if (decision.event === undefined) this.finishClose()
    else this.invoke(decision.event.actionId, decision.event.pagePath, true, decision.event)
  }

  private observe(event: MayflyUiEvent): void {
    if (this.input.definition.onEvent === undefined) return
    const key = `observe:${uiControlKey({ pagePath: event.pagePath, controlId: (event as { readonly controlId: string }).controlId })}`
    const previous = this.activeKeys.get(key)
    if (previous !== undefined) this.tasks.get(previous)?.controller.abort()
    this.start(key, event)
  }

  private finishClose(): void {
    const key = `dismiss:${this.instanceId}`
    if (this.input.definition.onEvent === undefined) this.bindings.close?.()
    else if (!this.activeKeys.has(key)) this.start(key, { kind: 'dismiss', pagePath: [] })
  }

  private start(key: string, event: MayflyUiEvent, submission?: MayflySubmission): void {
    const id = `${this.instanceId}/${++this.nextOperation}`
    const controller = new AbortController()
    const task: UiTask = { id, key, controller, event, source: this.source, sourceNode: this.admittedNode, formKeys: new Set((submission ?? (event.kind === 'activate' ? event.inputs : undefined))?.forms.map(formAddressKey)), ...(submission === undefined ? {} : { submission }) }
    for (const form of submission?.forms ?? []) this.updateForm(form, { kind: 'submit', operationId: id })
    this.notifications.clear(key, false)
    for (const operation of this.operations.values()) if (operation.key === key && operation.phase !== 'running') this.notifications.clear(operation.id, false)
    this.tasks.set(id, task)
    this.activeKeys.set(key, id)
    this.operations.set(id, Object.freeze({ id, key, actionId: submission?.actionId ?? ('actionId' in event ? event.actionId : 'controlId' in event ? event.controlId : 'dismiss'), phase: 'running' }))
    this.changed()
    void this.execute(task)
  }

  private async execute(task: UiTask): Promise<void> {
    let nativeAccepted = false
    try {
      const prepared = await this.endpoint.prepare(task.event, {
        surfaceId: this.id, source: task.source, signal: task.controller.signal, operationId: task.id, revision: this.revision,
        report: feedback => { if (this.live && !task.controller.signal.aborted) this.report(task.id, feedback) },
      })
      if (!this.live || task.controller.signal.aborted) return
      if (!this.readInputsCurrent(task)) return
      const reply = prepared.reply
      if (reply === undefined) {
        this.setPhase(task, 'succeeded')
        if (task.event.kind === 'dismiss') this.bindings.close?.()
        return
      }
      nativeAccepted = reply.kind === 'accepted' || reply.kind === 'completed'
      let publication: typeof this.publication
      if ('node' in reply && reply.node !== undefined && reply.node !== null) {
        const admitted = validateMayflyUiNode(reply.node)
        if (!admitted.ok) throw new Error(admitted.message)
        if (task.submission !== undefined && (reply.kind === 'accepted' || (reply.kind === 'failed' && reply.acceptedFields !== undefined))) prepareUiForms(admitted.value, task.submission.forms)
        publication = { source: reply.node, admitted: admitted.value }
        if (this.admittedNode !== null && task.submission !== undefined) {
          prepareUiForms(this.admittedNode, task.submission.forms)
          this.admitVisibleControls()
        }
        if (task.controller.signal.aborted) return
        const currentData = baselineData(this.admittedNode)
        const dataChanged = currentData !== baselineData(task.sourceNode) || !sameUiSource(this.source, task.source)
        const confirmsCurrent = this.source.length > 0
          ? reply.source !== undefined && sameUiSource(this.source, reply.source)
          : (reply.source?.length ?? 0) === 0 && currentData === baselineData(publication.admitted)
        if (dataChanged && !confirmsCurrent) {
          this.setPhase(task, reply.kind === 'accepted' ? 'succeeded' : 'failed')
          this.report(task.id, { message: reply.kind === 'accepted' ? 'The action completed, but newer data must be reviewed' : reply.message, severity: reply.kind === 'accepted' ? 'warning' : 'error' })
          return
        }
      }
      if (reply.kind === 'accepted' && reply.node === null && task.submission !== undefined) throw new Error('submitted form acknowledgement has no snapshot')
      if (reply.kind === 'invalid') this.applyErrors(task, reply)
      if (reply.kind === 'failed' && reply.acceptedFields !== undefined) {
        if (reply.acceptedFields.some(field => !task.formKeys.has(formAddressKey(field)) || !Object.hasOwn(this.form(field)!.fields, field.fieldId))) throw new TypeError('partial acknowledgement addresses an unknown submitted field')
      }
      else if (reply.kind === 'completed' && task.event.kind === 'value-change') {
        this.updateForm({ pagePath: task.event.pagePath, formId: task.event.formId }, { kind: 'validated', fieldId: task.event.controlId, revision: task.event.draftRevision })
      }
      this.publication = publication
      try {
        if (!prepared.publish()) {
          this.setPhase(task, nativeAccepted ? 'succeeded' : 'unknown')
          return
        }
      }
      finally { this.publication = undefined }
      if (!this.live || task.controller.signal.aborted) return
      this.setPhase(task, reply.kind === 'accepted' || reply.kind === 'completed' ? 'succeeded' : reply.kind === 'cancelled' ? 'cancelled' : 'failed')
      if (reply.feedback !== undefined) this.report(task.id, reply.feedback)
      else if (reply.kind === 'failed' || reply.kind === 'conflict') this.report(task.id, { severity: 'error', message: reply.message })
      if (reply.navigate !== undefined && reply.navigate.length > 0) this.navigate(reply.navigate)
      if ((reply.dismiss === true || task.event.kind === 'dismiss') && (reply.kind === 'accepted' || reply.kind === 'completed' || reply.kind === 'cancelled')) this.bindings.close?.()
    } catch (error) {
      if (this.live && !task.controller.signal.aborted) {
        this.setPhase(task, nativeAccepted ? 'succeeded' : 'failed')
        this.report(task.id, { message: nativeAccepted ? 'The action completed, but its result could not be displayed' : task.submission === undefined && task.event.kind !== 'value-change' && error instanceof Error ? error.message : 'The action could not be completed', severity: 'error' })
      }
    } finally {
      if (this.live) {
        if (task.controller.signal.aborted) this.setPhase(task, task.event.kind === 'value-change' || task.event.kind === 'selection-toggle' || task.event.kind === 'tab-change' || (task.event.kind === 'activate' && task.event.inputs !== undefined) ? 'cancelled' : 'unknown')
        if (this.notifications.get(task.id)?.purpose === 'progress') this.notifications.clear(task.id, false)
        for (const form of task.submission?.forms ?? []) this.updateForm(form, { kind: 'release', operationId: task.id })
        if (this.activeKeys.get(task.key) === task.id) this.activeKeys.delete(task.key)
        this.tasks.delete(task.id)
        this.trimOperations()
        this.changed()
      }
      task.controller.abort()
    }
  }

  private applyErrors(task: UiTask, reply: Extract<MayflyUiActionReply, { readonly kind: 'invalid' }>): void {
    const errors = reply.errors.map(error => ({ ...error, message: admitNotificationMessage(error.message) }))
    if (task.event.kind === 'value-change') {
      const event = task.event
      const address = { pagePath: event.pagePath, formId: event.formId }
      if (errors.some(error => formAddressKey(error) !== formAddressKey(address) || error.fieldId !== event.controlId)) throw new TypeError('validation error addresses another field')
      this.updateForm(address, { kind: 'validated', fieldId: event.controlId, revision: event.draftRevision, error: errors[0]!.message })
      return
    }
    for (const error of errors) {
      const form = this.form(error)
      if (!task.formKeys.has(formAddressKey(error)) || form === undefined || !Object.hasOwn(form.fields, error.fieldId)) throw new TypeError('action error addresses an unknown submitted field')
    }
    if (task.submission === undefined) {
      for (const error of errors) {
        const field = this.form(error)!.fields[error.fieldId]!
        this.updateForm(error, { kind: 'validated', fieldId: error.fieldId, revision: field.revision, error: error.message })
      }
    } else for (const form of task.submission.forms) this.updateForm(form, { kind: 'invalid', operationId: task.id, errors: errors.filter(error => formAddressKey(error) === formAddressKey(form)) })
    const first = errors[0]!
    this.focusControl({ pagePath: first.pagePath, controlId: first.fieldId })
  }

  private setPhase(task: UiTask, phase: UiOperation['phase']): void {
    const operation = this.operations.get(task.id)!
    this.operations.set(task.id, Object.freeze({ ...operation, phase }))
  }

  private readInputsCurrent(task: UiTask): boolean {
    if (task.event.kind !== 'activate' || task.event.inputs === undefined) return true
    const current = task.event.inputs.forms.every(form => this.form(form)?.draftRevision === form.draftRevision)
      && (task.event.inputs.selections ?? []).every(selection => {
        const state = this.choice(selection)
        const ids = state?.definition.role === 'browse' && state.selectedIds.length === 0 && state.focusedId !== undefined
          ? [state.focusedId]
          : state?.selectedIds
        return ids !== undefined && ids.length === selection.selectedIds.length && ids.every(id => selection.selectedIds.includes(id))
      })
    if (!current) task.controller.abort()
    return current
  }

  private report(id: string, feedback: MayflyFeedback): void {
    this.notifications.report(id, { owner: this.instanceId, scope: this.scope, ...(id.includes('/') ? { operationId: id } : {}) }, feedback)
  }
  clearFeedback(id: string): void { this.notifications.clear(id) }
  handleFeedback(id: string): void { this.notifications.handle(id) }
  cancelOperation(id: string): void { this.tasks.get(id)?.controller.abort() }
  private cancelTasks(): void { for (const task of this.tasks.values()) task.controller.abort() }
  private trimOperations(): void {
    for (const [id, operation] of this.operations) {
      if (this.operations.size <= 64) break
      if (operation.phase !== 'running' && this.notifications.get(id) === undefined) this.operations.delete(id)
    }
  }
  private changed(): void {
    if (!this.live) return
    for (const task of this.tasks.values()) this.readInputsCurrent(task)
    this.revisionValue += 1
    for (const listener of this.listeners) {
      try { listener() } catch (error) { this.bindings.onObserverError?.(error) }
    }
  }

  dispose(): void {
    if (!this.live) return
    this.live = false
    this.cancelTasks()
    this.tasks.clear(); this.activeKeys.clear(); this.forms.clear(); this.formDefinitions.clear(); this.choices.clear(); this.tabs.clear(); this.documents.clear(); this.actions.clear()
    this.operations.clear(); this.notifications.dispose(); this.listeners.clear()
    this.rawNode = null; this.admittedNode = null; this.decision = undefined; this.selectedControl = undefined
    this.publication = undefined
    this.input = { id: this.id, revision: this.input.revision, scope: this.scope, source: [], update: { reason: 'replace' }, node: null, definition: {}, events: DISPOSED_EVENTS }
    this.bindings = {}
  }
}
