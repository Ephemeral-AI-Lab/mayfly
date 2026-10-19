# `@ephemeral-ai/mayfly-ui`

Owns renderer-neutral wire contracts, pure `ui.*` builders, the `compose.*`
namespace, and the four direct UI contribution services. The root has no Cordis
runtime import; `./provider` is its sole Cordis entry. Do not depend on Harness,
the Mayfly runtime, pi-tui, terminal objects, or mutable product state.

## Builders and contracts

- Clone caller-owned wire data before freezing; reject cycles and enumerable
  accessors without invoking getters, including before spreading options. Only
  this module's `freezeWire` snapshots may retain object identity, and
  `isWireSnapshot` is the only way to ask. Keep trust weakly held and private;
  arbitrary frozen data must still be cloned.
- Preserve handwritten wire shapes. Stacks normalize children to `{ node }`;
  sizing/viewport options require `ui.child`. `tab` gives a child stable page
  identity under a `tabs` control and is unavailable in status/editor
  decorations. Nodes carry no hidden layout metadata or renderer callbacks.
- `defineMayflyComponent` validates the id/render function and freezes output;
  core owns schema admission, quotas, and compilation. Do not add a registry.
  `memo: true` returns the previous node for shallowly equal props, so render
  must stay pure; it hits only when every prop is stable by reference (a
  translator or an inline object rebuilt per call never hits), so owners hoist
  them. `MayflyTranslate` is the type-only translator a component takes.
- Identity is the cache key: a builder keeps an unchanged sub-node identical
  (`freezeWire` of a snapshot returns it) and never rebuilds it to "refresh" it.
- `compose` is the one surface namespace: panel, decision lane/strip, wizard,
  tabs, rail, browser, completion palette, and status page, plus `wizardNext`
  and `decisionArmMs`. A composition is pure, owns no renderer, and returns a
  frozen `ui.*` tree. The [UI reference](../../docs/design/component-library.md)
  is the readable map.

## Provider lifecycle

- Admit definitions and initial snapshots before effects; publish and clean up
  by the admitted id even if callers mutate their definition. Async providers
  belong on definitions, never nodes. Publish the initial entry before loading;
  automatic loads contain failures, explicit pane loads reject current failures
  and settle on cancellation. Replacement fences pending loads and cursors.
- `set()` is data refresh or replacement, not caller-created acknowledgement.
  Scope changes require replacement; retain source/scope metadata when omitted.
  Replacement/disposal revokes endpoints, pending handlers, publishers, and
  progress callbacks. Ordinary refresh and visibility changes preserve actions.
- Observations cannot publish, navigate, or dismiss. Handled actions return
  structured settlements; core admits replies before the single-use publisher
  updates the original registration.
- Read and submit boundaries are exclusive; fence read results after input edits.
  Unsuccessful replies cannot dismiss feedback; ordinary dirty dismissal uses
  confirmation, while explicit `discard` supports native decisions.

## Verification

The surface has no compatibility layer: a field, builder, or event changes or
goes when the component being finalized needs it, and the change updates every
caller (Mayfly, `examples/`, the gallery, the shipped skills) with no alias or
deprecated path.

A change to `src/` takes a type fixture, both Website reference pages when their
text changes, `pnpm run check`, and the distribution checks `check:lib`,
`check:examples`, and `check:pack`. `tests/ui.compile.ts` covers contract fields,
component inference with `memo`, child boundaries, and custom-kind rejection;
`tests/types.spec.ts` compiles it against built declarations. Provider tests
cover replay, replacement, duplicate IDs, cancellation, late results, Fiber
cleanup, and action admission. Built checks must prove trusted snapshots retain
identity through publication.
