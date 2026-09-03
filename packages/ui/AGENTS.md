# `@ephemeral-ai/mayfly-ui`

This package owns the renderer-neutral `MayflyUiNode` wire contracts, pure
builders, and the four direct Mayfly UI contribution services. The root entry
has no Cordis runtime import; `./provider` is the sole Cordis entry and mounts
`mayflyPanes`, `mayflyStatus`, `mayflyOverlays`, and
`mayflyEditorExtensions`. It must not depend on Harness, the Mayfly runtime,
pi-tui, terminal objects, or mutable product state.

Builders must remain side-effect free and preserve the handwritten wire shape.
They recursively clone caller-owned wire data before freezing the result and
reject cycles. Stacks normalize plain nodes to `{ node }`; flex sizing and
viewport conditions still require explicit `ui.child(node, options)` wrappers.
List `detailSpans`, like all inline semantic content, pass through unchanged
and are cloned/frozen with their list item. Do not add hidden layout metadata
or renderer callbacks to nodes.

Markdown, diagram, and chart builders preserve only the public wire data. They must not
import, configure, or expose Mermaid/chart renderer libraries, and they remain
outside the narrower status, editor-extension, and section-content unions.

`defineMayflyComponent` is a package-level composition factory. It validates
the component id and render function, then freezes render output.
It must not validate node schemas, register component kinds, capture a Fiber,
or create a runtime registry. Core owns schema admission, quotas, and compile.

Keep runtime source fully covered. Type fixtures must prove component prop
inference, the explicit child boundary, and rejection of custom node kinds.
Provider tests must prove registration ownership, delta replay, snapshot set, duplicate
id rejection, and Fiber cleanup.
