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
/** Capture the screen as the checkpoint `name`. */
export const checkpoint = name => ({ step: 'checkpoint', name })
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
/** Measure the product doing nothing for `ms`: CPU and frames (a perf span named `idle`). */
export const idle = ms => ({ step: 'idle', ms })
/**
 * Measure `steps` as the perf span `name`: CPU, frames, bytes, memory, and for each key or wheel notch the time from its
 * write to the end of the next frame. Inside a span nothing waits on the driver, so the measurement adds no work to
 * the product; `play(…, { timed: true })` plays at the replay's own pace.
 */
export const measure = (name, steps) => ({ step: 'measure', name, steps })
