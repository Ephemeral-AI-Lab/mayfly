# `@ephemeral-ai/mayfly`

English | [中文](README.zh.md)

The installable Mayfly terminal UI bundle for dsh. Its flat
`cordis.patch.yml` composition adds ordinary sibling rows over `dsh-base`:
a set of dsh support rows and the Mayfly product rows.

Plugins inherit native dsh services directly and opt into terminal UI with
`mayflyPanes`, `mayflyStatus`, `mayflyOverlays`, and
`mayflyEditorExtensions`. The current Agent is available through
`mayflyCurrentAgent`. Official Mayfly features use those same services.

The `mayfly-cordis` preset includes skills for temporary prototyping, durable
ordinary Cordis plugin authoring, and composition editing. No special Mayfly
manifest, capability host, adapter, or plugin-author CLI is required.

Agent Team is an optional marketplace plugin that adds a separate `team`
preset based on `standard`. Existing presets keep ordinary delegation. Team navigation,
reminders, delivered files, and MCP resources are documented in
[Harness features](../../docs/native-harness-adaptation.md).
`mayfly.transcriptView` replaces the old per-family transcript settings.
