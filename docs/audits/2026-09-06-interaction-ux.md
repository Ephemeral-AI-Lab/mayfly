# Mayfly interaction review: confirmation, forms, and selection

Date: 2026-09-06. Scope: Mayfly's official interaction layer and the core
controls it uses; third-party plugins and model-generated questionnaire copy
are not evaluated.

The shared cause of this round's problems is that user decisions were
compressed into text input or implicit keyboard gestures. A confirmation
should be a choice, input should collect real data, and moving focus should be
distinct from submitting. Existing tests can prove the implementation matches
the specified behavior, but the specified behavior itself can still violate
user expectations.

## Fixed in this round

| Previous behavior | Impact | Adjustment |
| --- | --- | --- |
| Full access, stopping a child Agent, deleting a Provider, and updating Mayfly all required typing a fixed `y` | Turned a binary choice into text editing — typing `yes` was actually invalid — and mixed confirmation into form-editing state | Shared explicit Yes / No action panel; default focus is No; Yes executes, No / Esc cancels |
| Cancelling the Provider deletion confirmation ended the entire edit flow | Accidentally lost the unsaved draft; the cost of cancelling exceeded the current step | The confirmation stacks over the original edit form; cancelling restores the same form and draft |
| The full-access prompt said "every tool call runs unchecked" | Incorrectly described dsh's `never` approval policy as blanket approval | Explicitly states the file sandbox is off; requests that still need approval are denied without asking |
| Stopping a child Agent only asked for `y`, with no explanation of how that differs from interrupting the current turn | A user could mistake releasing the entire live Agent for pausing it | The confirmation body explains that it ends the Agent and releases resources while keeping the saved session |

The implementation is concentrated in
[confirmation-panel.ts](https://github.com/Ephemeral-AI-Lab/mayfly/blob/bd171aa/packages/mayfly/src/interaction/confirmation-panel.ts).
The existing canonical actions handle painting and focus; no renderer or public
UI types were added. The four consumers still use the original native write
paths.

Verification covers default No, explicit Yes, Escape, repeated activation,
Chinese text, draft restoration, the permission selector, late results and
descendant checks for child Agents, update-failure rollback, and the width
scans. The Provider OAuth path gained mock-interaction tests; its product
behavior was not changed in this round.

## Remaining issues

The following problems still exist, prioritized by misoperation risk and data
impact. Except where existing automated tests explicitly cover a behavior, the
evidence is the current code path — static inference is not passed off as
hands-on testing.

### P1: Tab on the last field submits the entire form

Location: [form-panel.ts](https://github.com/Ephemeral-AI-Lab/mayfly/blob/bd171aa/packages/mayfly/src/interaction/form-panel.ts),
`handleInput` and `onTextSubmit`;
[ui-compiler.ts](../../packages/mayfly/src/core/ui-compiler.ts), the Tab branch
in edit mode.

Trigger: edit a Provider's last API-key field, type content, then press Tab.
Core hands Tab to `onSubmit`; the form controller has no further field, so it
calls the whole-form `submit()`, triggering a save. There is no separate Save /
Cancel action.

Impact: a user who only meant to move focus or check another field has already
executed a write. Enter means enter-edit in navigation mode, confirm-field in
edit mode, and submit-form on the last item — the cost of an operation depends
on invisible state.

Recommendation: Tab / Shift+Tab should only move focus and preserve the draft;
add explicit Save / Cancel for the whole form. Enter's behavior should be
decided by the focused control, with field confirmation and whole-form
submission separated. The change touches every official form and needs an
independent migration covering credentials, settings, and the Provider wizard.

### P1: "cycle to next value" on a settings enum is a persistent write

Location:
[settings-command.ts](../../packages/mayfly/src/interaction/settings-command.ts),
`CanonicalSettingsController.activate()`, the dynamic permission row, and
`commitRow()`.

Trigger: press Enter / Space on an enum setting in `/settings`. The UI cycles
directly to the next value and calls the write — including
`permission.defaultPreset`, which affects all later sessions.

Impact: the user never sees the complete option set and cannot compare before
confirming. For a sensitive enum like the default permission, an Enter meant to
"open the options" changes the default behavior. Instant toggling is usually
fine for booleans, but multiple mutually exclusive options should not share the
same cycling gesture.

Recommendation: keep booleans as toggles; open a radio list for enums that
clearly marks the current value and candidates, and write only after
confirmation. Permission changes should also show the actual sandbox and
approval consequences.

### P2: OAuth select questions degrade into free text

Location:
[provider-add.ts](../../packages/mayfly/src/interaction/provider-add.ts), the
OAuth `interaction.prompt()`.

Trigger: the authorization provider returns `kind: 'select'` with options. The
current implementation concatenates `id: label` into a field label, still
creates an ordinary input box, and only validates non-empty.

Impact: the user must recognize and hand-type an internal option id instead of
choosing directly; a typo is still sent back to the provider. When options are
missing it even renders an input box with an empty label. Adjacent steps — the
Provider source and protocol steps — already have a reusable radio control.

Recommendation: map `text`, `secret`, and `select` to text, secret, and radio
controls respectively; when there are no candidates, show a clear error or a
protocol-defined fallback.

### P2: "zero selected" in multi-select implicitly picks the cursor item

Location: [select.ts](https://github.com/Ephemeral-AI-Lab/mayfly/blob/bd171aa/packages/mayfly/src/interaction/select.ts),
`CanonicalMultiSelectController.confirm()`;
[select.spec.ts](https://github.com/Ephemeral-AI-Lab/mayfly/blob/bd171aa/packages/mayfly/tests/interaction/select.spec.ts)
explicitly asserts this fallback.

Trigger: in the model multi-select list, check nothing — or uncheck everything
— then press Enter. If the list is non-empty, the submitted result is the
current cursor item instead of an empty array.

Impact: the checked state and the submitted result disagree; the user can
unintentionally adopt a model. The cursor expresses the navigation position
and the checked set expresses the decision; the two should not be interchanged.

Recommendation: callers that allow an empty set should submit an empty set;
callers that require at least one item should disable confirm or show local
validation. If a single-select quick flow is needed, define it separately
instead of borrowing multi-select's empty state.

### P2: re-selecting already-enabled full access still asks for confirmation

Location:
[permission-panel.ts](../../packages/mayfly/src/interaction/permission-panel.ts),
the list `onSelect`.

Trigger: full access is already active; open `/permission` and press Enter on
the row marked current. The confirmation panel still opens, even though the
upstream setter is a no-op for the same value.

Impact: a confirmation is demanded when nothing changes — extra keystrokes that
weaken attention for genuine permission-change prompts.

Recommendation: selecting the current value should close directly; only
confirm when the target configuration actually changes the permission.

### P2: generic action confirmation is still a second Enter

Location: [ui-patterns.ts](../../packages/mayfly/src/core/ui-patterns.ts),
`actionToken()`;
[ui-compiler.ts](../../packages/mayfly/src/core/ui-compiler.ts),
`pendingConfirmation`.

Trigger: after the first activation of a public UI action carrying `confirm`, a
question is appended to the original button text; a second Enter executes and
Escape cancels.

Impact: this is a separate confirmation language with no explicit No, unlike
the new behavior of the official panels in this round. The mechanism is part of
the public UI contract and plugins also use it; changing only the official
consumers does not make all confirmations unified.

Recommendation: give generic actions a consistent confirmation presentation
later, while preserving the existing `confirm` field's behavioral contract,
one-shot execution, focus generation, and Escape semantics; renderer,
screenshot, and external-consumer regressions are required.

### P3: collections and numbers still borrow string forms everywhere

Location:
[provider-add.ts](../../packages/mayfly/src/interaction/provider-add.ts),
`fillModelDefaults()`;
[form-panel.ts](https://github.com/Ephemeral-AI-Lab/mayfly/blob/bd171aa/packages/mayfly/src/interaction/form-panel.ts),
`FormField`.

Trigger: when completing model information, the context window is a plain
numeric text field and reasoning efforts is a comma-separated string enum. The
official `FormField` only expresses plain input and secret — no dedicated
semantics for these values.

Impact: the user has to remember the format and legal values, and only sees an
error at submit time. Several different purposes look identical; the input box
is forced to do the work of a selector, a numeric input, and a confirmation all
at once.

Recommendation: use multi-select for collections and an input with units and
bounds for numbers; fields that genuinely need free text keep the text box.
Before extending, define each control's navigation and submission rules so the
implicit-submit problems of forms are not copied over.

## Suggested implementation order

1. Separate form navigation from submission first, and add explicit Save /
   Cancel.
2. Then fix the settings enum and OAuth select so options are visible and
   choosing is separate from submitting.
3. Fix the multi-select empty state and the permission no-op confirmation.
4. Finally unify confirmation presentation for public actions and the
   numeric/collection controls, completing the full acceptance expected of a
   public UI change.

This round keeps the conventions from the previous one: Shift+Tab only toggles
normal / plan, YOLO is controlled by its own permission command, and the status
bar can show plan and yolo at the same time.
