import { readFileSync } from 'node:fs'
import type { FSRSParameters } from 'ts-fsrs'
import { describe, expect, it } from 'vitest'
import { FSRSVersion, FSRS_ALGORITHM_VERSION, TS_FSRS_RELEASE, createFsrsScheduler } from './scheduler'
import { replayCard } from './upgrade'

const t0 = new Date('2026-10-10T15:00:00Z')
const days = (n: number) => new Date(t0.getTime() + n * 86_400_000)
const s = createFsrsScheduler()

describe('FSRS scheduler', () => {
  it('pins the algorithm version to the installed ts-fsrs release', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(pkg.dependencies['ts-fsrs']).toBe(TS_FSRS_RELEASE)
    expect(FSRSVersion).toContain(`v${TS_FSRS_RELEASE}`)
    expect(FSRS_ALGORITHM_VERSION).toBe('fsrs-6/ts-fsrs@5.4.2')
  })

  it('starts new cards due immediately', () => {
    const card = s.init(t0)
    expect(card).toMatchObject({ state: 0, due: t0.toISOString(), reps: 0, lapses: 0, lastReview: null })
    expect(s.retrievability(card, t0)).toBe(0)
  })

  it('is deterministic: same state, rating and time give the same result (fuzz off)', () => {
    const a = s.review(s.init(t0), 3, t0)
    const b = createFsrsScheduler().review(s.init(t0), 3, t0)
    expect(a).toEqual(b)
    expect(s.params.enable_fuzz).toBe(false)
  })

  it('"Got it" schedules later than "Missed it", and Easy later than Good', () => {
    const due = (rating: 1 | 2 | 3 | 4) => Date.parse(s.review(s.init(t0), rating, t0).due)
    expect(due(3)).toBeGreaterThan(due(1))
    expect(due(4)).toBeGreaterThan(due(3))
    expect(due(2)).toBeGreaterThanOrEqual(due(1))
  })

  it('schedules a first "Got it" at least a day ahead (no 10-minute learning step)', () => {
    expect(Date.parse(s.review(s.init(t0), 3, t0).due) - t0.getTime()).toBeGreaterThanOrEqual(86_400_000)
  })

  it('grows intervals with successful reviews and counts lapses', () => {
    let card = s.review(s.init(t0), 3, t0)
    const first = Date.parse(card.due) - t0.getTime()
    const at = new Date(card.due)
    card = s.review(card, 3, at)
    expect(Date.parse(card.due) - at.getTime()).toBeGreaterThan(first)
    card = s.review(card, 1, new Date(card.due))
    expect(card.lapses).toBe(1)
  })

  it('round-trips through JSON without changing the next schedule', () => {
    const card = s.review(s.init(t0), 3, t0)
    const revived = JSON.parse(JSON.stringify(card))
    expect(s.review(revived, 3, days(5))).toEqual(s.review(card, 3, days(5)))
  })

  it('caps "Got it" intervals at one year', () => {
    let card = s.review(s.init(t0), 3, t0)
    for (let i = 0; i < 20; i += 1) card = s.review(card, 3, new Date(card.due))
    // ts-fsrs caps Hard at maximum_interval and keeps Good one day past Hard, so Good tops out at 366.
    expect(card.scheduledDays).toBeLessThanOrEqual(366)
  })

  it('has a stable parameter id', () => {
    expect(s.paramsId).toMatch(/^[0-9a-f]{12}$/)
    expect(createFsrsScheduler().paramsId).toBe(s.paramsId)
  })
})

describe('algorithm upgrades: replaying the review log', () => {
  const log = [
    { rating: 3 as const, reviewedAt: t0.toISOString() },
    { rating: 1 as const, reviewedAt: days(4).toISOString() },
    { rating: 3 as const, reviewedAt: days(5).toISOString() },
  ]

  it('reproduces the stored state under the same algorithm', () => {
    let card = s.init(t0)
    for (const r of log) card = s.review(card, r.rating, new Date(r.reviewedAt))
    expect(replayCard(s, t0.toISOString(), log)).toEqual(card)
  })

  it('is order-independent in its input and deterministic', () => {
    expect(replayCard(s, t0.toISOString(), [...log].reverse())).toEqual(replayCard(s, t0.toISOString(), log))
  })

  it('recomputes the schedule under different parameters (a stand-in for a new algorithm version)', () => {
    const stricter = createFsrsScheduler({ ...(s.params as unknown as FSRSParameters), request_retention: 0.95 })
    expect(stricter.paramsId).not.toBe(s.paramsId)
    const good = [{ rating: 3 as const, reviewedAt: t0.toISOString() }, { rating: 3 as const, reviewedAt: days(4).toISOString() }]
    const a = replayCard(s, t0.toISOString(), good)
    const b = replayCard(stricter, t0.toISOString(), good)
    expect(Date.parse(b.due)).toBeLessThan(Date.parse(a.due))
    expect(b.reps).toBe(a.reps)
  })

  it('keeps a repeat miss recorded after the last review pulling the due date forward', () => {
    const evidence = days(6).toISOString()
    const replayed = replayCard(s, t0.toISOString(), log, [evidence])
    expect(replayed.due).toBe(evidence)
    expect(replayCard(s, t0.toISOString(), log, [days(1).toISOString()]).due).toBe(replayCard(s, t0.toISOString(), log).due)
  })
})
