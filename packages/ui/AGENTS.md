# `@ephemeral-ai/mayfly-ui`

Owns renderer-neutral wire contracts, pure builders, and four direct UI
contribution services. The root has no Cordis runtime import; `./provider` is
its sole Cordis entry. Do not depend on Harness, Mayfly runtime, pi-tui, terminal
objects, or mutable product state.

## Builders

- Clone caller-owned wire data before freezing; reject cycles and enumerable
  accessors without invoking getters, including before spreading options.
  Only this module's `freezeWire` snapshots may retain object identity, and
  `isWireSnapshot` is the only way to ask. Keep trust weakly held and private;
  arbitrary frozen data must still be cloned.
- Preserve handwritten wire shapes. Stacks normalize nodes to `{ node }`;
  sizing/viewport options require `ui.child`. `tab` gives a child stable page
  identity under a `tabs` control and is unavailable in status/editor
  decorations. No hidden layout metadata or
  renderer callbacks. Rich document builders expose data, not renderer libraries,
  and stay outside the narrower status/editor-extension/section unions.
- `defineMayflyComponent` validates the id/render function and freezes output;
  core owns node schema admission, quotas, and compilation. Do not add a registry.
  `memo: true` returns the previous node for shallowly equal props, so render
  must stay pure; it hits only when every prop is stable by reference (a
  translator or an inline object rebuilt per call never hits), so owners hoist
  them. `MayflyTranslate` is the type-only translator a component takes.
- Identity is the cache key. A node that reaches core is a frozen snapshot, and
  core reuses admission, compilation, and painted rows by that identity, so a
  builder keeps an unchanged sub-node identical (`freezeWire` of a snapshot
  returns it) and never rebuilds it to "refresh" it. A field that an old
  caller never wrote stays optional with a default (`selectedIds` is `[]`).
- The [UI design](../../docs/design/component-library.md) is the target for a planned
  refresh, not shipped behavior; its
  [implementation reference](../../docs/design/component-library-reference.md) holds the
  builder and event tables. A genuinely new node kind lands as contract + builder + core
  validator/painter/grammar + width-scan coverage, never as an ad-hoc renderer.

## Provider lifecycle

- Admit definitions and initial snapshots before effects; publish and clean up
  by the admitted id even if callers mutate their definition. Async providers
  belong on definitions, never nodes. Publish the initial entry before loading.
- Automatic loads contain failures; explicit pane loads reject current failures
  and settle on cancellation. Snapshot replacement fences pending loads,
  failures, and cursors; visibility/focus changes preserve content loads.
- `set()` is data refresh or replacement, not caller-created acknowledgement.
  Scope changes require replacement; retain source/scope metadata when omitted.
  Replacement/disposal revokes endpoints, pending handlers, publishers, and
  progress callbacks. Ordinary refresh and visibility changes preserve actions.
- Observations cannot publish, navigate, or dismiss. Handled actions return
  structured settlements; core admits replies before the single-use publisher
  updates the original registration. Drafts, busy state, and wizard completion
  belong to the frontend model, not provider endpoints.
- Read and submit boundaries are exclusive; fence read results after input edits.
  Partial acknowledgements identify submitted fields. Navigation uses semantic
  paths. Unsuccessful replies cannot dismiss feedback; ordinary dirty dismissal
  uses confirmation, while explicit `discard` supports native decision outcomes.
  `presentation: 'editor'` uses the same overlay lifecycle and activation order.
- Contract fields stay additive and renderer-neutral: action `key` is a key id
  that core validates (no shared navigation keys, no repeats per page, no
  printable keys beside filterable lists, modifiers only in editor
  decorations); confirmations, row availability, numbering mode, and button
  labels are plain data.

## Verification

The surface froze with Phase 1 (roadmap D16): a change to `src/` is an
exception, additive and optional-field only, and takes the root full gate
(`pnpm run verify:full`, `check:lib`, `check:examples`, and `check:pack` for
distribution), a type fixture, and both Website reference pages with
`script/shots/manifest.mjs`. Type fixtures in `tests/ui.compile.ts` cover every
contract field, component inference with `memo`, explicit child boundaries, and
rejection of custom kinds; `tests/types.spec.ts` compiles them against the built
declarations, so build first.
Provider tests cover replay, set/replacement, duplicate IDs, cancellation, late
results, Fiber cleanup, and action admission/publication. Built root/provider
checks must prove trusted builder snapshots retain identity through publication.
