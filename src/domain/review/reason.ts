import type { DueReason, PromptType, ReviewPrompt } from '../remediation/types'
import { localDay } from './day'

const dateLabel = (iso: string | undefined, timeZone: string) => {
  if (!iso) return 'an earlier session'
  const [y, m, d] = localDay(new Date(iso), timeZone).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/**
 * Why a card is due, in plain words. Pure: the same stored reason, source and zone always give the
 * same text, so every due item has a deterministic, traceable reason.
 */
export function describeDueReason(reason: DueReason, source: { scenarioTitle: string; label: string } | null, timeZone: string): string {
  const where = source ? `${source.scenarioTitle}: ${source.label}` : 'a submitted case'
  if (reason.code === 'new-miss') return `New from your debrief (${dateLabel(reason.at, timeZone)}) — ${where}.`
  if (reason.code === 'new-evidence') return `Missed again (${dateLabel(reason.at, timeZone)}) — ${where}. Brought forward for review.`
  return `Scheduled review — you last reviewed this on ${dateLabel(reason.lastReviewedAt ?? reason.at, timeZone)}.`
}

/**
 * Deterministic prompt rotation for a card. Prefers a prompt type different from the last one shown,
 * then a different prompt, then cycles by review count, so repeated reviews vary across recall,
 * discrimination, next-best-step and differential prompts.
 */
export function choosePrompt(candidates: ReviewPrompt[], lastPromptId: string | null, reps: number): ReviewPrompt | null {
  if (candidates.length === 0) return null
  const sorted = [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const last = sorted.find((p) => p.id === lastPromptId)
  const lastType: PromptType | undefined = last?.type
  const otherType = sorted.filter((p) => p.type !== lastType)
  const otherPrompt = sorted.filter((p) => p.id !== lastPromptId)
  const pool = otherType.length ? otherType : otherPrompt.length ? otherPrompt : sorted
  return pool[reps % pool.length]
}
