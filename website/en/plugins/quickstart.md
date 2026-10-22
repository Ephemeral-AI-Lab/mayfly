# Quickstart

## Layout

```text
build-health/
├── package.json
├── tsconfig.json
├── src/index.ts
└── cordis.patch.yml
```

Use your normal TypeScript build tool. Runtime requires Node
`^22.19.0 || >=24.0.0` and Cordis `^4.0.2`. Add only the dsh and Mayfly peer
dependencies the entry actually imports.

`src/index.ts`:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@ephemeral-ai/mayfly-ui'
import { ui } from '@ephemeral-ai/mayfly-ui'

export const name = '@acme/build-health'
export const inject = ['mayflyStatus']

export function apply(ctx: Context): void {
  ctx.mayflyStatus.register({
    id: 'acme.build-health',
    priority: 30,
    band: 'right',
  }, ui.text('healthy', { tone: 'success' }))
}
```

`cordis.patch.yml`:

```yaml
- insert:
    - id: '@acme/build-health'
      name: '@acme/build-health'
```

`package.json` exports the built entry and patch and includes both in
`files`:

```json
{
  "name": "@acme/build-health",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": {
      "types": "./lib/index.d.ts",
      "default": "./lib/index.js"
    },
    "./cordis.patch.yml": "./cordis.patch.yml"
  },
  "files": ["lib/**/*", "cordis.patch.yml"]
}
```

Build, then install the file snapshot in a dedicated profile:

```sh
dsh plugin --profile mayfly-build-health add file:/absolute/path/to/build-health
dsh --profile mayfly-build-health
```

Rebuild after source edits and reinstall after dependency or package-content
changes. Do not use the production `mayfly` profile for acceptance.
