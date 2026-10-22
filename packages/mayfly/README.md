# `@ephemeral-ai/mayfly`

English | [中文](README.zh.md)

The installable Mayfly terminal UI bundle for dsh. Its flat
`cordis.patch.yml` composition adds 34 sibling rows over `dsh-base`: six
dsh support rows and 28 Mayfly product rows.

Plugins inherit native dsh services directly and opt into terminal UI with
`mayflyPanes`, `mayflyStatus`, `mayflyOverlays`, and
`mayflyEditorExtensions`. The current Agent is available through
`mayflyCurrentAgent`. Official Mayfly features use those same services.

The `mayfly-cordis` preset includes skills for temporary prototyping, durable
ordinary Cordis plugin authoring, and composition editing. No special Mayfly
manifest, capability host, adapter, or plugin-author CLI is required.
