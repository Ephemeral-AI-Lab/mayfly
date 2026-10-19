/**
 * The accepted cell grids behind the Website app shots, under
 * `script/scenarios/golden/<scenario>/<checkpoint>@<cols>x<rows>.grid`. The
 * component shots are painted from their own manifest; these six grids are the
 * release-pinned product frames. @module script/scenarios/golden
 */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where the app-shot goldens live. */
export const GOLDEN_DIR = fileURLToPath(new URL('./golden/', import.meta.url))

/** The golden file of one checkpoint at one size. */
export const goldenPath = (scenario, checkpoint, cols, rows) => join(GOLDEN_DIR, scenario, `${checkpoint}@${String(cols)}x${String(rows)}.grid`)
