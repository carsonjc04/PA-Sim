// Local "study day" bucketing. The review day rolls over at 04:00 in the student's own time zone,
// so a 1 AM session still counts as tonight. Scheduling itself uses absolute instants; only the
// "due today" boundary depends on the zone. Pure and clock-free: callers pass `now`.

export const DAY_CUTOFF_HOUR = 4

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    formatters.set(timeZone, f)
  }
  return f
}

export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 64) return false
  try {
    formatter(timeZone)
    return true
  } catch {
    return false
  }
}

function assertZone(timeZone: string): void {
  if (!isValidTimeZone(timeZone)) throw new RangeError(`Unknown time zone "${timeZone}"`)
}

/** Wall-clock fields of an instant in a zone. */
function wallClock(instant: number, timeZone: string) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(instant)).map((p) => [p.type, p.value]))
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), h: Number(parts.hour), min: Number(parts.minute), s: Number(parts.second) }
}

/** Zone offset (local minus UTC, ms) at an instant. */
function offsetAt(instant: number, timeZone: string): number {
  const w = wallClock(instant, timeZone)
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - Math.floor(instant / 1000) * 1000
}

/** The instant a wall-clock time occurs in a zone. A time skipped by a DST gap resolves to just after the gap. */
function zonedToInstant(y: number, m: number, d: number, h: number, timeZone: string): number {
  const asUtc = Date.UTC(y, m - 1, d, h)
  let t = asUtc - offsetAt(asUtc, timeZone)
  t = asUtc - offsetAt(t, timeZone)
  return t
}

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`
function shiftDay(day: string, by: number): { y: number; m: number; d: number } {
  const [y, m, d] = day.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + by))
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }
}

/** The study day (YYYY-MM-DD) that `now` belongs to in `timeZone`; before 04:00 local it is still the previous day. */
export function localDay(now: Date, timeZone: string, cutoffHour = DAY_CUTOFF_HOUR): string {
  assertZone(timeZone)
  const w = wallClock(now.getTime(), timeZone)
  if (w.h >= cutoffHour) return ymd(w.y, w.m, w.d)
  const prev = shiftDay(ymd(w.y, w.m, w.d), -1)
  return ymd(prev.y, prev.m, prev.d)
}

/** First instant of a study day: 04:00 local on that date. */
export function dayStart(day: string, timeZone: string, cutoffHour = DAY_CUTOFF_HOUR): Date {
  assertZone(timeZone)
  const { y, m, d } = shiftDay(day, 0)
  return new Date(zonedToInstant(y, m, d, cutoffHour, timeZone))
}

/** End of a study day (exclusive): 04:00 local on the next calendar date. 23 or 25 hours long across DST changes. */
export function dayEnd(day: string, timeZone: string, cutoffHour = DAY_CUTOFF_HOUR): Date {
  assertZone(timeZone)
  const { y, m, d } = shiftDay(day, 1)
  return new Date(zonedToInstant(y, m, d, cutoffHour, timeZone))
}
