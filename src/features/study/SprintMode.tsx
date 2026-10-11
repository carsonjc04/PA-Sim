import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../api/client'
import type { PublicSprint, SprintAnswerResult } from '../../api/contracts'
import { LoadError } from './shared'
import { messageOf, useLoad } from './util'

export function SprintMode({ user }: { user: string }) {
  const sprints = useLoad(() => api.sprints(), [user])
  const [openId, setOpenId] = useState<string | null>(null)
  if (sprints.error) return <LoadError error={sprints.error} onRetry={sprints.reload} />
  if (!sprints.data) return <div className="loading">Loading sprints...</div>
  const open = sprints.data.find((s) => s.id === openId && !s.locked)
  return (
    <>
      <section className="page-intro">
        <div>
          <p className="eyebrow">DIFFERENTIAL SPRINT</p>
          <h1>Tell similar presentations apart.</h1>
          <p className="lede">
            Each sprint shows the key findings from one case and asks for the best-fitting diagnosis. Sprints reveal their case&rsquo;s diagnosis, so each opens after you submit that case.
          </p>
        </div>
      </section>
      {open ? (
        <SprintRunner key={open.id} sprint={open} onBack={() => setOpenId(null)} />
      ) : sprints.data.length === 0 ? (
        <div className="empty-state">
          <h2>No sprints are authored yet.</h2>
        </div>
      ) : (
        <ul className="study-sprint-list">
          {sprints.data.map((s) => (
            <li key={s.id}>
              <div>
                <strong>{s.sourceTitle}</strong>
                <span className="tag">Draft &mdash; not clinically reviewed</span>
              </div>
              {s.locked ? (
                <p className="study-muted">
                  Locked. <Link to={`/encounter/${s.sourceScenarioId}`}>Finish &ldquo;{s.sourceTitle}&rdquo;</Link> first.
                </p>
              ) : (
                <button type="button" className="button button-small" onClick={() => setOpenId(s.id)}>
                  Start sprint
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function SprintRunner({ sprint, onBack }: { sprint: PublicSprint; onBack: () => void }) {
  const [choice, setChoice] = useState<string | null>(null)
  const [result, setResult] = useState<SprintAnswerResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!choice) return
    setBusy(true)
    setError(null)
    api
      .answerSprint(sprint.id, choice)
      .then(setResult)
      .catch((err) => setError(messageOf(err)))
      .finally(() => setBusy(false))
  }
  return (
    <section className="study-section study-sprint">
      <p className="tag">Draft &mdash; not clinically reviewed</p>
      <h2>{sprint.stem}</h2>
      <h3>Key findings</h3>
      <dl className="study-findings">
        {sprint.findings.map((f) => (
          <div key={f.label}>
            <dt>{f.label}</dt>
            <dd>{f.text}</dd>
          </div>
        ))}
      </dl>
      <form onSubmit={submit}>
        <fieldset disabled={busy || result !== null}>
          <legend>Most likely diagnosis</legend>
          {sprint.options.map((o) => (
            <label key={o.id} className="study-option">
              <input type="radio" name="dx" value={o.id} checked={choice === o.id} onChange={() => setChoice(o.id)} />
              {o.label}
            </label>
          ))}
        </fieldset>
        {!result && (
          <button type="submit" className="button button-primary" disabled={!choice || busy}>
            {busy ? 'Checking...' : 'Check answer'}
          </button>
        )}
      </form>
      {error && (
        <div className="voice-error" role="alert">
          <p>{error}</p>
        </div>
      )}
      {result && (
        <div className={`study-result ${result.correct ? 'is-correct' : 'is-wrong'}`} role="status">
          <p>
            <strong>{result.correct ? 'Correct.' : 'Not quite.'}</strong> The case&rsquo;s answer is <strong>{result.answer.label}</strong>
            {result.correct ? '.' : `; you chose ${result.chosen.label}.`}
          </p>
          <ul className="study-list">
            {result.reasoning.map((r) => (
              <li key={r.id}>
                <strong>{r.label}:</strong> {r.text ?? 'No reasoning authored for this option.'}
              </li>
            ))}
          </ul>
        </div>
      )}
      <button type="button" className="button button-quiet" onClick={onBack}>
        Back to sprints
      </button>
    </section>
  )
}
