/**
 * The steps a scenario script is written in. The runner settles after every step that changes the screen: the screen's
 * content stands still for the quiet time, no synchronized frame is open, and no stub request is in flight.
 * @module script/scenarios/steps
 */

/**
 * Play the replay up to the mark `until` (a `mark()` of its timeline), or to its end. Playing stops early at a prompt
 * that waits for an answer (an approval or a question), which the next steps answer with keys.
 */
export const play = (until, { timed = false } = {}) => ({ step: 'play', ...(until === undefined ? {} : { until }), ...(timed ? { timed } : {}) })
/**
 * Capture the screen as the checkpoint `name`. With `tick`, the product's counters (`Bash · 4s`) are ticked once at the
 * timeline time first, so a counter does not depend on where the product's own timer fell under load.
 */
export const checkpoint = (name, { tick = false } = {}) => ({ step: 'checkpoint', name, ...(tick ? { tick } : {}) })
/** Send a key by name (`enter`, `down`, `ctrl+o`, `alt+x`, or literal text), `repeat` times. */
export const key = (name, { repeat = 1 } = {}) => ({ step: 'key', name, repeat })
/** Type text one character at a time. */
export const type = text => ({ step: 'type', text })
/** Click a cell: `{ row, col }`, or `{ text }` for the first visible occurrence of a text. */
export const click = at => ({ step: 'click', at })
/** Turn the wheel `count` notches (`up` or `down`) over a cell (default the middle of the screen). */
export const wheel = (direction, { at, count = 1 } = {}) => ({ step: 'wheel', direction, count, ...(at === undefined ? {} : { at }) })
/** Resize the terminal. */
export const resize = (cols, rows) => ({ step: 'resize', cols, rows })
/** Let `ms` of wall-clock time pass, then settle: for a state that changes by itself (an arm delay runs out). */
export const wait = ms => ({ step: 'wait', ms })
/**
 * Wait until the visible screen holds `text`, then settle: for a screen the product opens by itself after a key (an
 * overlay that lists something loads it first), so the next key lands on it however long the load takes.
 */
export const until = text => ({ step: 'until', text })
/** Measure the product doing nothing for `ms`: CPU and frames (a perf span named `idle`). */
export const idle = ms => ({ step: 'idle', ms })
/**
 * Measure `steps` as the perf span `name`: CPU, frames, bytes, memory, and for each key or wheel notch the time from its
 * write to the end of the next frame. Inside a span nothing waits on the driver, so the measurement adds no work to
 * the product; `play(…, { timed: true })` plays at the replay's own pace.
 */
export const measure = (name, steps) => ({ step: 'measure', name, steps })
