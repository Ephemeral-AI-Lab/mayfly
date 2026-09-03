# Example catalog

The repository contains one shared UI kit and five runnable ordinary Cordis
plugins:

| Package | Direct dependency | Demonstrates |
| --- | --- | --- |
| `mayfly-user-kit` | `mayfly-ui` library | reusable `defineMayflyComponent` |
| `header` | `mayflyPanes` | header lane |
| `right-inspector` | `mayflyPanes` | right lane and narrow bottom fallback |
| `bottom-log` | `mayflyPanes` | passive bottom lane |
| `overlay` | `commands`, `mayflyOverlays` | native command opening a capturing overlay |
| `ui-gallery` | `mayflyPanes` | public node builders |

`@mayfly-example/ecosystem` activates all five runtime examples
through five ordinary Cordis rows:

```sh
dsh plugin --profile mayfly-examples add @ephemeral-ai/mayfly
dsh plugin --profile mayfly-examples add @mayfly-example/ecosystem
dsh --profile mayfly-examples
```

The examples prove package entries, direct `inject`, renderer-neutral output,
Fiber unload, publish-shaped pack/install, and narrow-width rendering. They
are not part of Mayfly's default bundle.
