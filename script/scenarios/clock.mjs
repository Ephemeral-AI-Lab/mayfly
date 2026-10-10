/**
 * The scenario clock, preloaded into `dsh` with `NODE_OPTIONS=--import` by the scenario runner: `Date.now()` and an
 * argument-less `new Date()` read a clock that stands at a fixed epoch until the replay driver moves it, so the events
 * written at boot, stored event times, elapsed labels, and dates on screen are the same on every run, however long the
 * boot takes. The driver moves it through `globalThis.__mayflyClock`: `at(ms)` stands it at the epoch plus a timeline
 * time, `freeze()` stops it, and `flow()` lets it run with real time. Timers are not touched. @module script/scenarios/clock
 */

/** 2026-01-01T09:00:00Z. */
export const EPOCH = Date.UTC(2026, 0, 1, 9, 0, 0)

const RealDate = Date
const realNow = () => RealDate.now()
let base = EPOCH
let since = realNow()
let frozen = true

const now = () => frozen ? base : base + (realNow() - since)

/** `Date` on the scenario clock: an instance is a real `Date` (so `instanceof` holds), and `Date()` gives the string. */
function ScenarioDate(...args) {
  if (new.target === undefined) return new RealDate(now()).toString()
  return args.length === 0 ? new RealDate(now()) : new RealDate(...args)
}
ScenarioDate.prototype = RealDate.prototype
ScenarioDate.now = now
ScenarioDate.parse = RealDate.parse
ScenarioDate.UTC = RealDate.UTC

globalThis.Date = ScenarioDate
globalThis.__mayflyClock = Object.freeze({
  now,
  at(ms) { base = EPOCH + ms; since = realNow(); frozen = true },
  freeze() { base = now(); frozen = true },
  flow() { if (frozen) { since = realNow(); frozen = false } },
})
