import { describe, expect, it } from 'vitest'
import { dayEnd, dayStart, isValidTimeZone, localDay } from './day'

const at = (iso: string) => new Date(iso)
const hours = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 3_600_000

describe('localDay: 04:00 local cutoff', () => {
  it('keeps 03:59 local on the previous study day and starts the new one at 04:00 (America/Denver, MDT)', () => {
    expect(localDay(at('2026-10-10T09:59:00Z'), 'America/Denver')).toBe('2026-10-09') // 03:59 MDT
    expect(localDay(at('2026-10-10T10:00:00Z'), 'America/Denver')).toBe('2026-10-10') // 04:00 MDT
  })
  it('counts a 1 AM session as the same night', () => {
    expect(localDay(at('2026-10-10T07:00:00Z'), 'America/Denver')).toBe('2026-10-09') // 01:00 MDT
  })
  it('handles zones ahead of UTC, where the local date is already tomorrow (Pacific/Auckland, NZDT)', () => {
    expect(localDay(at('2026-10-10T14:59:00Z'), 'Pacific/Auckland')).toBe('2026-10-10') // 03:59 Oct 11
    expect(localDay(at('2026-10-10T15:00:00Z'), 'Pacific/Auckland')).toBe('2026-10-11') // 04:00 Oct 11
  })
  it('uses the same rule in UTC, so the server zone never leaks in', () => {
    expect(localDay(at('2026-10-10T03:59:59Z'), 'UTC')).toBe('2026-10-09')
    expect(localDay(at('2026-10-10T04:00:00Z'), 'UTC')).toBe('2026-10-10')
  })
  it('crosses month and year boundaries', () => {
    expect(localDay(at('2027-01-01T02:00:00Z'), 'UTC')).toBe('2026-12-31')
  })
})

describe('day boundaries across DST', () => {
  it('spring forward: the study day is 23 hours (America/Denver, 2026-03-08)', () => {
    expect(dayEnd('2026-03-07', 'America/Denver').toISOString()).toBe('2026-03-08T10:00:00.000Z') // 04:00 MDT
    expect(dayStart('2026-03-07', 'America/Denver').toISOString()).toBe('2026-03-07T11:00:00.000Z') // 04:00 MST
    expect(hours(dayStart('2026-03-07', 'America/Denver'), dayEnd('2026-03-07', 'America/Denver'))).toBe(23)
  })
  it('fall back: the study day is 25 hours (America/Denver, 2026-11-01)', () => {
    expect(dayEnd('2026-10-31', 'America/Denver').toISOString()).toBe('2026-11-01T11:00:00.000Z') // 04:00 MST
    expect(hours(dayStart('2026-10-31', 'America/Denver'), dayEnd('2026-10-31', 'America/Denver'))).toBe(25)
  })
  it('the end of one day is the start of the next', () => {
    for (const tz of ['America/Denver', 'Pacific/Auckland', 'Europe/London', 'Asia/Kolkata', 'UTC']) {
      expect(dayEnd('2026-03-29', tz).getTime()).toBe(dayStart('2026-03-30', tz).getTime())
    }
  })
  it('an instant just before dayEnd belongs to the day, dayEnd itself to the next', () => {
    const end = dayEnd('2026-03-07', 'America/Denver')
    expect(localDay(new Date(end.getTime() - 1), 'America/Denver')).toBe('2026-03-07')
    expect(localDay(end, 'America/Denver')).toBe('2026-03-08')
  })
})

describe('time zone validation', () => {
  it('accepts IANA names and rejects anything else', () => {
    expect(isValidTimeZone('America/Denver')).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
    expect(() => localDay(new Date(), 'Not/AZone')).toThrow(RangeError)
  })
})
