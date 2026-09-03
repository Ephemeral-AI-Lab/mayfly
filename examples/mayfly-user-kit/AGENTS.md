# `@mayfly-example/user-kit`

Pure renderer-neutral component kit shared by header and right-inspector. It
uses only `@ephemeral-ai/mayfly-ui` builders and `defineMayflyComponent`; it has no
Cordis entry, Mayfly service registration, runtime state, timer, subscription,
or renderer dependency.

Callers own input data and receive deeply frozen wire nodes. Keep the package
outside Mayfly's release set while retaining build, coverage, pack, and
independent-install validation.
