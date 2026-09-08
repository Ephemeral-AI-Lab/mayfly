# `@mayfly-example/user-kit`

Pure component kit shared by header and right-inspector. Use only
`@ephemeral-ai/mayfly-ui` builders and `defineMayflyComponent`; no Cordis entry,
service registration, mutable runtime state, timer, or renderer dependency.
Caller data becomes deeply frozen wire nodes. Preserve component type inference
and the kit's width scan.
