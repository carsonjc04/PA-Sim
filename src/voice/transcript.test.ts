import { describe, expect, it } from 'vitest'
import { TranscriptAggregator } from './transcript'

describe('transcript aggregation', () => {
  it('joins fragments into one segment rather than one per delta', () => {
    const agg = new TranscriptAggregator()
    agg.apply({ speaker: 'patient', delta: 'It started ', startMs: 0, endMs: 400 })
    agg.apply({ speaker: 'patient', delta: 'about twenty ', startMs: 400, endMs: 800 })
    const segments = agg.apply({ speaker: 'patient', delta: 'minutes ago.', startMs: 800, endMs: 1200 })

    expect(segments).toHaveLength(1)
    expect(segments[0].text).toBe('It started about twenty minutes ago.')
    expect(segments[0].endMs).toBe(1200)
  })

  it('keeps overlapping speakers in separate segments', () => {
    const agg = new TranscriptAggregator()
    agg.apply({ speaker: 'student', delta: 'Any chest pain', startMs: 0, endMs: 500 })
    agg.apply({ speaker: 'patient', delta: 'Yes, right here', startMs: 300, endMs: 900 })
    const segments = agg.apply({ speaker: 'student', delta: ' or pressure?', startMs: 500, endMs: 1000 })

    expect(segments).toHaveLength(2)
    const student = segments.find((s) => s.speaker === 'student')!
    const patient = segments.find((s) => s.speaker === 'patient')!
    // The interleaved patient delta must not land in the student's text.
    expect(student.text).toBe('Any chest pain or pressure?')
    expect(patient.text).toBe('Yes, right here')
  })

  it('starts a new segment after a long pause', () => {
    const agg = new TranscriptAggregator()
    agg.apply({ speaker: 'patient', delta: 'I feel awful.', startMs: 0, endMs: 500 })
    const segments = agg.apply({ speaker: 'patient', delta: 'Is this serious?', startMs: 9000, endMs: 9500 })

    expect(segments).toHaveLength(2)
    expect(segments[1].text).toBe('Is this serious?')
  })

  it('orders segments by when they began', () => {
    const agg = new TranscriptAggregator()
    agg.apply({ speaker: 'patient', delta: 'second', startMs: 5000, endMs: 5500 })
    const segments = agg.apply({ speaker: 'student', delta: 'first', startMs: 100, endMs: 600 })

    expect(segments.map((s) => s.text)).toEqual(['first', 'second'])
  })

  it('ignores empty deltas and resets cleanly', () => {
    const agg = new TranscriptAggregator()
    expect(agg.apply({ speaker: 'patient', delta: '', startMs: 0, endMs: 0 })).toHaveLength(0)
    agg.apply({ speaker: 'patient', delta: 'hello', startMs: 0, endMs: 100 })
    agg.reset()
    expect(agg.snapshot()).toHaveLength(0)
  })
})
