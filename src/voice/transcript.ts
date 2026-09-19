import type { Speaker, TranscriptSegment } from './types'

/** A pause longer than this starts a new segment for that speaker. */
const SEGMENT_GAP_MS = 2000

export interface TranscriptDelta {
  speaker: Speaker
  delta: string
  startMs: number
  endMs: number
}

/**
 * Deltas are fragments, not turns, and the two speakers can overlap because the
 * session is full duplex. Each speaker therefore accumulates independently:
 * a delta extends that speaker's open segment, or opens a new one after a gap.
 */
export class TranscriptAggregator {
  private segments: TranscriptSegment[] = []
  private counter = 0

  apply(delta: TranscriptDelta): TranscriptSegment[] {
    if (!delta.delta) return this.snapshot()

    const open = this.lastOpenFor(delta.speaker)
    if (open && delta.startMs - open.endMs <= SEGMENT_GAP_MS) {
      open.text += delta.delta
      open.endMs = Math.max(open.endMs, delta.endMs)
    } else {
      this.counter += 1
      this.segments.push({
        id: `${delta.speaker}-${this.counter}`,
        speaker: delta.speaker,
        text: delta.delta,
        startMs: delta.startMs,
        endMs: delta.endMs,
      })
    }
    return this.snapshot()
  }

  snapshot(): TranscriptSegment[] {
    // Ordered by when each segment began so interleaved speech reads correctly.
    return [...this.segments].sort((a, b) => a.startMs - b.startMs)
  }

  reset(): void {
    this.segments = []
    this.counter = 0
  }

  private lastOpenFor(speaker: Speaker): TranscriptSegment | undefined {
    for (let i = this.segments.length - 1; i >= 0; i -= 1) {
      if (this.segments[i].speaker === speaker) return this.segments[i]
    }
    return undefined
  }
}
