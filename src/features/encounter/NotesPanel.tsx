import { forwardRef } from 'react'
import { NOTES_MAX_LENGTH } from '../../api/contracts'
import type { NotesStatus } from './hooks'

const STATUS_TEXT: Record<NotesStatus, string> = {
  loading: 'Loading notes…',
  idle: 'Not yet saved',
  saving: 'Saving…',
  saved: 'Saved',
  offline: 'Offline: saved on this device, will sync when you reconnect',
  conflict: 'Changed somewhere else: choose a version',
  error: 'Could not save. Your text is kept on this device.',
}

// Identifier-like patterns: dates, long digit runs (record numbers, phone numbers). A hint only; never blocks or edits.
const IDENTIFIER_HINT = /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d{7,}\b|\b\d{3}[ -.]\d{3}[ -.]\d{4}\b|\bMRN\b/i

interface Props {
  attemptReady: boolean
  body: string
  status: NotesStatus
  conflictBody: string | null
  onChange: (text: string) => void
  onResolve: (choice: 'mine' | 'theirs') => void
}

/** Learner notes for this attempt. The privacy notice sits at the field itself, linked to it for screen readers. */
export const NotesPanel = forwardRef<HTMLTextAreaElement, Props>(function NotesPanel({ attemptReady, body, status, conflictBody, onChange, onResolve }, ref) {
  const looksIdentifying = IDENTIFIER_HINT.test(body)
  return (
    <section className="notes-panel" aria-labelledby="notes-title">
      <h2 id="notes-title">Your notes</h2>
      <p className="notes-notice" id="notes-notice">
        Practice notes only. Do not enter real patient names, dates of birth, record numbers or other identifiers.
      </p>
      <label htmlFor="attempt-notes" className="sr-only">
        Notes for this attempt
      </label>
      <textarea
        id="attempt-notes"
        ref={ref}
        className="notes-field"
        value={body}
        maxLength={NOTES_MAX_LENGTH}
        disabled={!attemptReady || status === 'loading'}
        aria-describedby={`notes-notice notes-status${looksIdentifying ? ' notes-hint' : ''}`}
        onChange={(e) => onChange(e.target.value)}
        rows={5}
        placeholder="Differential, red flags to check, what to look up later…"
      />
      <div className="notes-meta">
        <span id="notes-status" className={`notes-status notes-status--${status}`}>
          {STATUS_TEXT[status]}
        </span>
        <span aria-hidden="true">
          {body.length}/{NOTES_MAX_LENGTH}
        </span>
      </div>
      {looksIdentifying && (
        <p className="notes-hint" id="notes-hint">
          This looks like it may contain a date or record number. Keep notes free of real patient details.
        </p>
      )}
      {status === 'conflict' && conflictBody !== null && (
        <div className="notes-conflict" role="alert">
          <p>These notes were changed on another device or tab. The saved version reads:</p>
          <blockquote>{conflictBody || '(empty)'}</blockquote>
          <div className="notes-conflict-actions">
            <button type="button" className="button button-primary button-small" onClick={() => onResolve('mine')}>
              Keep my version
            </button>
            <button type="button" className="button button-quiet button-small" onClick={() => onResolve('theirs')}>
              Use the saved version
            </button>
          </div>
        </div>
      )}
    </section>
  )
})
