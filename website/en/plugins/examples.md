# Example catalog

The repository contains one shared UI kit and five runnable ordinary Cordis
plugins:

| Package | Direct dependency | Demonstrates |
| --- | --- | --- |
| `mayfly-user-kit` | `mayfly-ui` library | reusable `defineMayflyComponent` |
| `header` | `mayflyPanes` | header lane |
| `right-inspector` | `mayflyPanes` | right lane and narrow bottom fallback |
| `bottom-log` | `mayflyPanes` | passive bottom lane |
| `overlay` | `commands`, `settings`, `mayflyOverlays` | native command opening a capturing overlay |
| `ui-gallery` | `mayflyPanes` | public node builders |

The examples are publish-shaped package and renderer fixtures. The UI-only
entries can be source-integrated into a dedicated Remote composition. The
`overlay` example deliberately combines native commands/settings with UI and
belongs to the private in-process fixture; a split implementation separates its
Host reads/writes from its frontend overlay using official Client/Remote DTOs.
The `ecosystem` patch does not install terminal UI into the current Host.

The examples prove package entries, direct `inject`, renderer-neutral output,
Fiber unload, publish-shaped pack/install, and narrow-width rendering. They
are not part of Mayfly's default bundle.
