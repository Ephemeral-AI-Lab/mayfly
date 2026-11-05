# Example catalog

The repository contains one shared UI kit and five runnable ordinary Cordis
plugins:

| Package | Direct dependency | Demonstrates |
| --- | --- | --- |
| `mayfly-user-kit` | `mayfly-ui` library | reusable `defineMayflyComponent` |
| `header` | `mayflyPanes` | header lane |
| `right-inspector` | `mayflyPanes` | right lane and narrow bottom fallback |
| `bottom-log` | `mayflyPanes` | passive bottom lane |
| `overlay` | `mayflyEditorExtensions`, `mayflyOverlays` | editor action opening a capturing settings overlay |
| `ui-gallery` | `mayflyPanes` | public node builders |

The examples are publish-shaped package and renderer fixtures. Each plugin is
an ordinary Cordis module a TUI composition passes to
`run(argv, { plugins })`; `mayfly-ecosystem` composes all five into a
`mayfly-ecosystem` command. None ships a dsh bundle: the TUI's tree has the
four UI services and no native dsh services, so the `overlay` example keeps its
settings in its own Fiber.

The examples prove package entries, direct `inject`, renderer-neutral output,
Fiber unload, publish-shaped pack/install, and narrow-width rendering. They
are not part of Mayfly's default composition.
