import { Lightbulb } from 'lucide-react'
import { useState } from 'react'
import type { HistoryMode, PublicHint } from '../../api/contracts'

/**
 * History-phase mode. Voice hides the question list so the student generates the history (recall); guided shows
 * it (recognition). The choice is server-side, so a reload keeps it and the debrief reports every switch.
 */
export function HistoryModeToggle({ mode, onChange, disabled }: { mode: HistoryMode; onChange: (mode: HistoryMode) => void; disabled?: boolean }) {
  const option = (id: HistoryMode, label: string) => (
    <button type="button" className={`confidence-option ${mode === id ? 'selected' : ''}`} aria-pressed={mode === id} disabled={disabled} onClick={() => onChange(id)}>
      {label}
    </button>
  )
  return (
    <fieldset className="confidence-toggle history-mode">
      <legend>How will you take the history?</legend>
      <div className="confidence-options">
        {option('voice', 'Voice, no list')}
        {option('guided', 'Guided list')}
      </div>
      <p>
        {mode === 'voice'
          ? 'Ask the patient aloud, without a question list. Switching to guided shows the list, and your debrief notes the switch.'
          : 'Choose questions from the list. Voice mode hides it so you practice without prompts.'}
      </p>
    </fieldset>
  )
}

/**
 * Voice-history scaffolding: each press reveals one suggested key question from the case, never the list.
 * Hints are logged and reported in the debrief; they do not record a question or change the score.
 */
export function HistoryHints({ hints, onHint, disabled }: { hints: PublicHint[]; onHint: () => Promise<string | null>; disabled?: boolean }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const latest = hints.at(-1)

  const ask = async () => {
    if (pending || disabled) return
    setPending(true)
    setError(await onHint())
    setPending(false)
  }

  return (
    <section className="history-hints" aria-labelledby="hints-title">
      <h3 id="hints-title">Stuck? Hints</h3>
      <p className="history-hints-note">
        A hint suggests one question from this case. It is scaffolding: it does not ask the question for you or change your score, and your debrief reports how many you used.
      </p>
      {/* aria-disabled while a hint loads, not disabled: a disabled button drops keyboard focus to the page. */}
      <button type="button" className="button button-quiet button-small" onClick={() => void ask()} disabled={disabled} aria-disabled={pending || undefined} aria-describedby="hints-count">
        <Lightbulb size={15} aria-hidden="true" /> {pending ? 'Getting a hint…' : 'Show one suggested question'}
      </button>{' '}
      <span id="hints-count" className="history-hints-count">
        Hints used: {hints.length}
      </span>
      {hints.length > 0 && (
        <ol className="history-hints-list" aria-label="Suggested questions">
          {hints.map((h) => (
            <li key={h.seq}>“{h.text}”</li>
          ))}
        </ol>
      )}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {latest ? `Suggested question: ${latest.text}` : ''}
      </p>
      {error && (
        <p className="voice-hint voice-hint--warning" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
