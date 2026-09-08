# `@ephemeral-ai/mayfly-ui`

Owns renderer-neutral wire contracts, pure builders, and four direct UI
contribution services. The root has no Cordis runtime import; `./provider` is
its sole Cordis entry. Do not depend on Harness, Mayfly runtime, pi-tui, terminal
objects, or mutable product state.

## Builders

- Clone caller-owned wire data before freezing; reject cycles and enumerable
  accessors without invoking getters, including before spreading options.
  Only this module's `freezeWire` snapshots may retain object identity. Keep
  trust weakly held and private; arbitrary frozen data must still be cloned.
- Preserve handwritten wire shapes. Stacks normalize nodes to `{ node }`;
  sizing/viewport options require `ui.child`. No hidden layout metadata or
  renderer callbacks. Rich document builders expose data, not renderer libraries,
  and stay outside the narrower status/editor-extension/section unions.
- `defineMayflyComponent` validates the id/render function and freezes output;
  core owns node schema admission, quotas, and compilation. Do not add a registry.

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

## Verification

Public source changes require the root full gate. Preserve type fixtures for
component inference, explicit child boundaries, and rejection of custom kinds.
Provider tests cover replay, set/replacement, duplicate IDs, cancellation, late
results, Fiber cleanup, and action admission/publication. Built root/provider
checks must prove trusted builder snapshots retain identity through publication.
