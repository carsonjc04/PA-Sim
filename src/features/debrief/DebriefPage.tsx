import { ArrowRight, Flag, RotateCcw, ShieldAlert, Star } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, ApiRequestError } from '../../api/client'
import type { PublicAnnotation, PublicAttempt, PublicChecklistItem, PublicDebriefMiss, PublicNotes, PublicTimelineEntry } from '../../api/contracts'
import type { MissKind } from '../../domain/remediation/types'
import { phaseOrder, type Category, type PhaseId } from '../../domain/types'
import { marksFor } from '../encounter/encounterModel'
import { RemediationPanel } from '../review/RemediationPanel'

const CATEGORY_LABEL: Record<Category, string> = {
  history: 'History taking',
  exam: 'Physical examination',
  diagnostics: 'Diagnostics and reasoning',
  diagnosis: 'Diagnostic accuracy',
  treatment: 'Treatment and follow-up',
  communication: 'Communication',
}

const MISS_LABEL: Record<MissKind, string> = {
  omission: 'Not done',
  unnecessary: 'Unnecessary',
  unsafe: 'Unsafe',
  critical: 'Critical safety issue',
  'wrong-diagnosis': 'Different diagnosis chosen',
  'guessed-correct': 'Right answer, low confidence',
}

const TIMELINE_VERB: Record<PublicTimelineEntry['type'], Record<string, string>> = {
  finding: { history: 'Asked', exam: 'Examined', diagnostics: 'Ordered' },
  phase_locked: {},
  diagnosis: {},
  plan: {},
}

const CHECKLIST_STATE: Record<PublicChecklistItem['status'], string> = { asked: 'Asked', asked_with_hint: 'Asked with hint', missed: 'Missed' }
const CHECKLIST_MODE = { voice: 'to voice', guided: 'to guided' } as const

const minutes = (ms: number) => {
  const m = Math.floor(ms / 60_000)
  return m < 1 ? 'Under 1 min' : `${m} min`
}
const message = (e: unknown) => (e instanceof ApiRequestError ? e.message : 'Something went wrong.')

export function DebriefPage() {
  const { attemptId } = useParams()
  const [attempt, setAttempt] = useState<PublicAttempt | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [annotations, setAnnotations] = useState<PublicAnnotation[]>([])
  const [notes, setNotes] = useState<PublicNotes | null>(null)

  useEffect(() => {
    if (!attemptId) return
    api.attempt(attemptId).then(setAttempt).catch((e) => setError(message(e)))
    // Owner-only extras; the debrief is complete without them.
    api.annotations(attemptId).then(setAnnotations).catch(() => setAnnotations([]))
    api.notes(attemptId).then(setNotes).catch(() => setNotes(null))
  }, [attemptId])

  if (error || (attempt && !attempt.debrief))
    return (
      <div className="empty-state">
        <h1>Debrief not found</h1>
        <p className="lede">{error ?? 'This encounter has not been submitted yet.'}</p>
        <Link className="button button-primary" to="/cases">
          Return to cases
        </Link>
      </div>
    )
  if (!attempt?.debrief)
    return (
      <div className="loading" role="status">
        Loading debrief…
      </div>
    )

  const d = attempt.debrief
  const r = d.reasoning
  const s = attempt.scenario
  const phaseLabel = (p: PhaseId) => s.phases.find((x) => x.id === p)?.label ?? p
  // The rubric can count one choice as both unsafe and critical; show it once, as the critical issue.
  const criticalLabels = new Set(r.misses.filter((m) => m.kind === 'critical').map((m) => m.label))
  const misses = r.misses.filter((m) => !(m.kind === 'unsafe' && criticalLabels.has(m.label)))
  const byPhase = phaseOrder.map((p) => ({ phase: p, items: misses.filter((m) => m.phase === p) })).filter((g) => g.items.length)
  const flagged = annotations.filter((a) => a.marks.includes('revisit'))
  const labelFor = (a: PublicAnnotation) =>
    a.targetKind === 'diagnosis' ? s.diagnoses.find((x) => x.id === a.targetId)?.label : a.targetKind === 'plan' ? s.planOptions.find((x) => x.id === a.targetId)?.label : s.phases.flatMap((p) => p.actions).find((x) => x.id === a.targetId)?.label

  return (
    <article className="debrief" aria-labelledby="debrief-title">
      <header className="debrief-head">
        <p className="eyebrow">Encounter debrief</p>
        <h1 id="debrief-title">{s.summary.title}</h1>
        <p className="debrief-outcome">
          {d.criticalSafetyError
            ? 'A critical safety issue needs your attention first.'
            : d.passed
              ? 'You met the case rubric’s passing bar. Use the misses and timeline below to sharpen the reasoning.'
              : 'Below the rubric’s passing bar this time. The misses below say what to change.'}
        </p>
        <p className="debrief-provenance">
          {r.provenance} Rubric {d.gradingVersionId}; case version {d.contentVersionId}.
        </p>
      </header>

      {d.criticalSafetyError && (
        <section className="debrief-section debrief-critical" aria-labelledby="critical-title">
          <h2 id="critical-title">
            <ShieldAlert size={18} aria-hidden="true" /> Critical safety issue
          </h2>
          <ul>
            {d.criticalMessages.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
          <p className="debrief-note">Because of this, the displayed score is capped at 59% (raw {d.rawScore}%).</p>
        </section>
      )}

      <section className="debrief-section" aria-labelledby="missed-title">
        <h2 id="missed-title">What did I miss, and why did it matter?</h2>
        {byPhase.length === 0 ? (
          <p>Nothing was missed against this case’s rubric.</p>
        ) : (
          byPhase.map((g) => (
            <div key={g.phase} className="debrief-group">
              <h3>{phaseLabel(g.phase)}</h3>
              <ul className="debrief-misses">
                {g.items.map((m) => (
                  <MissItem key={m.rubricItemId} miss={m} />
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

      <section className="debrief-section" aria-labelledby="checklist-title">
        <h2 id="checklist-title">History checklist: what did I ask?</h2>
        <p className="debrief-note">
          Every key history question in this case. Times are when the question was recorded, since you started. Hints used: {r.hintsUsed}.
          {r.modeChanges.length > 0 && ` You switched the history mode ${r.modeChanges.length} ${r.modeChanges.length === 1 ? 'time' : 'times'} (${r.modeChanges.map((m) => `${CHECKLIST_MODE[m.mode]} at ${minutes(m.offsetMs).toLowerCase()}`).join(', ')}).`}
        </p>
        {r.historyChecklist.length === 0 ? (
          <p>This case has no key history questions in its rubric.</p>
        ) : (
          <ul className="checklist">
            {r.historyChecklist.map((c) => (
              <li key={c.actionId} className={`checklist-item checklist-item--${c.status}`}>
                <span className="checklist-state">
                  {CHECKLIST_STATE[c.status]}
                  {c.offsetMs !== null && ` · ${minutes(c.offsetMs)}`}
                </span>
                <span>
                  <strong>{c.label}</strong>
                  {c.source === 'voice' && <span className="debrief-badge">From voice</span>}
                </span>
                <p className="checklist-question">“{c.question}”</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="debrief-section" aria-labelledby="timeline-title">
        <h2 id="timeline-title">Reasoning timeline</h2>
        <p className="debrief-note">Each step in order, with time since you started. “Key” means the case rubric counts it as an important data point.</p>
        <ol className="timeline">
          {r.timeline.map((t) => {
            const marks = t.actionId ? marksFor(annotations, t.type === 'diagnosis' ? 'diagnosis' : t.type === 'plan' ? 'plan' : 'action', t.actionId) : []
            return (
              <li key={t.seq} className={`timeline-item timeline-item--${t.type}`}>
                <span className="timeline-time">{minutes(t.offsetMs)}</span>
                <div className="timeline-body">
                  <p className="timeline-title">
                    <span className="timeline-kind">
                      {t.type === 'phase_locked' ? 'Locked' : t.type === 'diagnosis' ? 'Diagnosis' : t.type === 'plan' ? 'Plan' : (TIMELINE_VERB.finding[t.phase] ?? 'Recorded')}
                    </span>{' '}
                    <strong>{t.label}</strong>
                    {t.key && t.type !== 'phase_locked' && (
                      <span className="debrief-badge debrief-badge--key">
                        <Star size={12} aria-hidden="true" /> Key
                      </span>
                    )}
                    {t.source === 'voice' && <span className="debrief-badge">From voice</span>}
                    {t.confidence && <span className="debrief-badge">You were {t.confidence}</span>}
                    {marks.includes('ruled_out') && <span className="debrief-badge">You ruled this out</span>}
                    {marks.includes('revisit') && <span className="debrief-badge">You flagged this</span>}
                  </p>
                  {t.revealed && <p className="timeline-revealed">{t.revealed}</p>}
                </div>
              </li>
            )
          })}
        </ol>
      </section>

      <section className="debrief-section" aria-labelledby="differential-title">
        <h2 id="differential-title">What evidence shaped the differential?</h2>
        <h3>Key findings you had before committing</h3>
        {r.keyFindingsBeforeDiagnosis.length ? (
          <ul className="debrief-list">
            {r.keyFindingsBeforeDiagnosis.map((f) => (
              <li key={f.actionId}>
                <strong>{f.label}:</strong> {f.revealed}
              </li>
            ))}
          </ul>
        ) : (
          <p>You committed to a diagnosis before uncovering any finding the rubric counts as key.</p>
        )}
        {r.missedEvidence.length > 0 && (
          <>
            <h3>Evidence you did not collect</h3>
            <ul className="debrief-list">
              {r.missedEvidence.map((m) => (
                <li key={m.id}>
                  <strong>{m.label}</strong> ({phaseLabel(m.phase)}): {m.feedback}
                </li>
              ))}
            </ul>
          </>
        )}
        <h3>The options, with the case’s reasoning</h3>
        <ul className="differential">
          {r.differential.map((o) => {
            const ruledOut = marksFor(annotations, 'diagnosis', o.id).includes('ruled_out')
            return (
              <li key={o.id} className={`differential-item${o.correct ? ' is-correct' : ''}`}>
                <p className="differential-title">
                  <strong>{o.label}</strong>
                  {o.correct && <span className="debrief-badge debrief-badge--key">Best fit for this case</span>}
                  {o.chosen && <span className="debrief-badge">Your choice</span>}
                  {ruledOut && <span className="debrief-badge">You ruled this out</span>}
                </p>
                <p>{o.reasoning ?? 'No reasoning was authored for this option.'}</p>
              </li>
            )
          })}
        </ul>
      </section>

      <section className="debrief-section" aria-labelledby="retrieve-title">
        <h2 id="retrieve-title">What should I retrieve later?</h2>
        {flagged.length > 0 && (
          <>
            <h3>
              <Flag size={15} aria-hidden="true" /> Items you flagged to revisit
            </h3>
            <ul className="debrief-list">
              {flagged.map((a) => (
                <li key={`${a.targetKind}:${a.targetId}`}>{labelFor(a) ?? a.targetId}</li>
              ))}
            </ul>
          </>
        )}
        <h3>Your notes</h3>
        {notes?.body ? <p className="debrief-notes">{notes.body}</p> : <p className="debrief-note">You did not write notes for this attempt.</p>}
        <p className="debrief-note">Scheduled review for the misses above is listed next.</p>
      </section>

      <RemediationPanel attemptId={attempt.id} />

      <section className="debrief-section debrief-score" aria-labelledby="score-title">
        <h2 id="score-title">Score and rubric</h2>
        <p className="debrief-score-line">
          <strong>{d.finalScore}%</strong> {d.passed ? '(passed)' : '(not passed)'}
          {d.rawScore !== d.finalScore && ` · raw ${d.rawScore}%`}
        </p>
        <table className="score-table">
          <caption className="sr-only">Score by rubric category</caption>
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col">Score</th>
            </tr>
          </thead>
          <tbody>
            {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
              <tr key={c}>
                <th scope="row">{CATEGORY_LABEL[c]}</th>
                <td>
                  <span className="score-bar" aria-hidden="true">
                    <span style={{ width: `${d.categoryScores[c]}%` }} />
                  </span>
                  {d.categoryScores[c]}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {d.strengths.length > 0 && (
          <>
            <h3>What went well</h3>
            <ul className="debrief-list">
              {d.strengths.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </>
        )}
        <h3>Recommended plan</h3>
        <ul className="debrief-list">
          {d.idealPlan.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </section>

      <nav className="debrief-next" aria-label="Next steps">
        <Link className="button button-primary" to={`/encounter/${attempt.scenarioId}`}>
          <RotateCcw size={16} aria-hidden="true" /> Replay this case
        </Link>
        <Link className="button button-quiet" to="/review">
          Today’s review <ArrowRight size={16} aria-hidden="true" />
        </Link>
        <Link className="button button-quiet" to="/cases">
          Case library
        </Link>
      </nav>
    </article>
  )
}

function MissItem({ miss }: { miss: PublicDebriefMiss }) {
  return (
    <li className={`debrief-miss debrief-miss--${miss.kind}`}>
      <p className="debrief-miss-title">
        <span className="debrief-badge">{MISS_LABEL[miss.kind]}</span> <strong>{miss.label}</strong>
      </p>
      {miss.whyItMattered && (
        <p>
          <span className="debrief-why">Why it mattered:</span> {miss.whyItMattered}
        </p>
      )}
    </li>
  )
}
