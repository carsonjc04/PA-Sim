import { ArrowLeft, ArrowRight, ChevronLeft, Keyboard, Lock, NotebookPen, WifiOff } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { phaseOrder, type PhaseId } from '../../domain/types'
import { ConfidenceToggle } from '../review/ConfidenceToggle'
import { useDisplaySettings } from '../settings/displaySettings'
import { VoicePanel } from './VoicePanel'
import { CaseSurface, Portrait } from './CaseSurface'
import { PatientPortrait } from '../patient/PatientPortrait'
import { patientPortraitAlt, patientPortraitSrc } from '../patient/portrait'
import { buildEntries, ENTRY_LABEL, optionsFor } from './encounterModel'
import { phaseIndexOf, useAnnotations, useAttemptNotes, useEncounter, useOnline } from './hooks'
import { HistoryHints, HistoryModeToggle } from './HistoryScaffold'
import { NotesPanel } from './NotesPanel'
import { OptionList } from './OptionList'

const isTyping = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))

/** Native modal dialog: the browser provides the focus trap, Escape and focus return. */
function ConfirmDialog({ open, title, children, onClose }: { open: boolean; title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog ref={ref} className="confirm-dialog" aria-labelledby="confirm-title" onClose={onClose}>
      <h2 id="confirm-title">{title}</h2>
      {children}
    </dialog>
  )
}

const SHORTCUTS: [string, string][] = [
  ['↑ ↓ or j k', 'Move between choices'],
  ['Enter or Space', 'Choose'],
  ['x', 'Rule out the focused choice'],
  ['h', 'Mark the focused choice as key'],
  ['f', 'Flag the focused choice to revisit'],
  ['n', 'Go to your notes'],
  ['[ and ]', 'View the previous or next phase'],
  ['g', 'Go to the phase heading'],
  ['?', 'Show these shortcuts'],
]

function elapsedText(since: string, now: number) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(since)) / 60_000))
  return minutes < 1 ? 'under a minute' : `${minutes} min`
}

export function EncounterPage() {
  const { scenarioId } = useParams()
  const navigate = useNavigate()
  const onNotFound = useCallback(() => navigate('/cases'), [navigate])
  const enc = useEncounter(scenarioId, onNotFound)
  const online = useOnline()
  const [settings, updateSettings] = useDisplaySettings()
  const { annotations, toggle, error: markError, clearError } = useAnnotations(enc.attempt?.id)
  const notes = useAttemptNotes(enc.attempt?.id)
  const [viewPhase, setViewPhase] = useState<PhaseId | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [help, setHelp] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [voiceNotices, setVoiceNotices] = useState<{ id: number; text: string }[]>([])
  const onToolRejected = useCallback((reason: string) => setVoiceNotices((n) => [...n.slice(-2), { id: Date.now(), text: reason }]), [])
  const [now, setNow] = useState(() => Date.now())
  const phaseHeading = useRef<HTMLHeadingElement>(null)
  const headingFocusPending = useRef(false)
  const notesField = useRef<HTMLTextAreaElement>(null)
  const helpRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const attempt = enc.attempt
  const entries = useMemo(() => (attempt ? buildEntries(attempt) : []), [attempt])

  // Announce new case entries by their content, and phase changes. Tracked against the previous render
  // (React's "adjusting state when a prop changes" pattern) rather than in an effect.
  const [seen, setSeen] = useState<{ entries: number; phase: PhaseId } | null>(null)
  if (attempt && (!seen || seen.entries !== entries.length || seen.phase !== attempt.currentPhase)) {
    if (!seen) {
      if (enc.resumedFindings) setAnnouncement(`Resumed encounter: ${enc.resumedFindings} findings so far.`)
    } else if (seen.phase !== attempt.currentPhase) {
      setAnnouncement(`Phase locked. Now in ${attempt.scenario.phases.find((p) => p.id === attempt.currentPhase)?.label}.`)
      setViewPhase(null)
    } else if (entries.length > seen.entries) {
      const e = entries[entries.length - 1]
      setAnnouncement(`${e.label ?? ENTRY_LABEL[e.kind]}: ${e.text}`)
    }
    setSeen({ entries: entries.length, phase: attempt.currentPhase })
  }

  // Move focus to the new phase heading. If the confirmation dialog is open, the browser returns focus to its
  // trigger when it closes, so the move happens in the dialog's close handler instead.
  const focusedPhase = useRef<PhaseId | null>(null)
  const currentPhase = attempt?.currentPhase ?? null
  useEffect(() => {
    if (!currentPhase) return
    if (focusedPhase.current === null) {
      focusedPhase.current = currentPhase
      return
    }
    if (focusedPhase.current === currentPhase) return
    focusedPhase.current = currentPhase
    if (document.querySelector('dialog.confirm-dialog[open]')) headingFocusPending.current = true
    else requestAnimationFrame(() => phaseHeading.current?.focus())
  }, [currentPhase])

  useEffect(() => {
    const d = helpRef.current
    if (!d) return
    if (help && !d.open) d.showModal()
    if (!help && d.open) d.close()
  }, [help])

  if (enc.loadError)
    return (
      <div className="empty-state">
        <h1>Could not open this encounter</h1>
        <p className="lede">{enc.loadError}</p>
        <Link className="button button-primary" to="/cases">
          Return to cases
        </Link>
      </div>
    )
  if (!attempt)
    return (
      <div className="loading" role="status" aria-busy="true">
        Loading encounter…
      </div>
    )
  if (attempt.status === 'submitted') return <Navigate to={`/results/${attempt.id}`} replace />

  const scenario = attempt.scenario
  const current = attempt.currentPhase
  const shown = viewPhase ?? current
  const reviewing = shown !== current
  const shownDef = scenario.phases.find((p) => p.id === shown)!
  const index = phaseIndexOf(current)
  const locked = attempt.lockedPhases
  const viewable = phaseOrder.filter((p) => locked.includes(p) || p === current)
  const recorded = attempt.events.filter((e) => e.phase === shown).map((e) => e.actionId)
  const selected = !reviewing && (shown === 'diagnosis' || shown === 'treatment') ? enc.draft[shown] : recorded
  const offlineBlocks = !online && !reviewing
  const readOnly = reviewing || locked.includes(shown) || enc.busy || offlineBlocks
  const readOnlyReason = reviewing
    ? `${shownDef.label} is locked. You are reviewing it: choices cannot change, but marks and notes still work.`
    : offlineBlocks
      ? 'You are offline. Choices are paused until the connection returns; notes keep saving on this device.'
      : undefined
  const lastPhase = index === phaseOrder.length - 1
  // Voice history: the question list is never rendered, only the door note, voice and hints.
  const historyNow = shown === 'history' && current === 'history'
  const voiceHistory = historyNow && attempt.historyMode === 'voice'
  const portraitAlt = patientPortraitAlt(scenario.patient.name, scenario.summary.title)

  const stepPhase = (dir: -1 | 1) => {
    const at = viewable.indexOf(shown)
    const next = viewable[at + dir]
    if (next) {
      setViewPhase(next === current ? null : next)
      requestAnimationFrame(() => phaseHeading.current?.focus())
    }
  }

  const onRootKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!settings.shortcuts || e.altKey || e.ctrlKey || e.metaKey || isTyping(e.target) || confirm || help) return
    if (e.key === 'n') {
      e.preventDefault()
      notesField.current?.focus()
    } else if (e.key === '[' || e.key === ']') {
      e.preventDefault()
      stepPhase(e.key === '[' ? -1 : 1)
    } else if (e.key === 'g') {
      e.preventDefault()
      phaseHeading.current?.focus()
    } else if (e.key === '?') {
      e.preventDefault()
      setHelp(true)
    }
  }

  const doConfirm = async () => {
    if (lastPhase) {
      if (await enc.submit()) {
        setAnnouncement('Submitted. Opening your debrief.')
        navigate(`/results/${attempt.id}`)
      }
    } else if (await enc.advance()) setConfirm(false)
  }

  const downtime = settings.downtime

  return (
    <div className={`encounter${downtime ? ' encounter--downtime' : ''}`} onKeyDown={onRootKeyDown}>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>

      <header className="phase-bar">
        <div className="phase-bar-top">
          <Link to="/cases" className="back-link">
            <ChevronLeft size={15} aria-hidden="true" /> Exit encounter
          </Link>
          <span className="phase-bar-meta">
            {scenario.summary.setting} · {elapsedText(attempt.createdAt, now)} elapsed
          </span>
        </div>
        <div className="phase-bar-title">
          <PatientPortrait caseId={scenario.id} alt={portraitAlt} className="phase-bar-portrait" />
          <h1>{scenario.summary.title}</h1>
          <p className="phase-bar-patient">
            {scenario.patient.name}, {scenario.patient.demographics} · {scenario.summary.pronouns}
          </p>
        </div>
        <nav aria-label="Encounter phases">
          <ol className="phase-steps">
            {phaseOrder.map((p, i) => {
              const def = scenario.phases.find((x) => x.id === p)
              const isLocked = locked.includes(p)
              const isCurrent = p === current
              const state = isCurrent ? 'In progress' : isLocked ? 'Locked' : 'Not started'
              return (
                <li key={p} className={`phase-step${isCurrent ? ' is-current' : ''}${isLocked ? ' is-locked' : ''}${p === shown ? ' is-shown' : ''}`}>
                  {isLocked || isCurrent ? (
                    <button type="button" aria-current={isCurrent ? 'step' : undefined} onClick={() => setViewPhase(isCurrent ? null : p)}>
                      <span className="phase-step-num" aria-hidden="true">
                        {String.fromCharCode(65 + i)}
                        {isLocked ? ' ✕' : ''}
                      </span>
                      <span className="phase-step-name">{def?.label}</span>{' '}
                      <span className="phase-step-state">{p === shown && reviewing ? 'Viewing' : state}</span>
                    </button>
                  ) : (
                    <span className="phase-step-future">
                      <span className="phase-step-num" aria-hidden="true">
                        {String.fromCharCode(65 + i)}
                      </span>
                      <span className="phase-step-name">{def?.label}</span>{' '}
                      <span className="phase-step-state">{state}</span>
                    </span>
                  )}
                </li>
              )
            })}
          </ol>
        </nav>
      </header>

      {!online && (
        <div className="encounter-banner encounter-banner--offline" role="status">
          <WifiOff size={16} aria-hidden="true" />
          <p>
            <strong>Offline.</strong> Choices are paused until the connection returns. Notes keep saving on this device.
          </p>
        </div>
      )}
      {enc.resumedFindings > 0 && !downtime && (
        <p className="encounter-banner encounter-banner--info">
          Resumed where you left off: {enc.resumedFindings} {enc.resumedFindings === 1 ? 'finding was' : 'findings were'} already recorded.
        </p>
      )}

      <div className="encounter-layout">
        <div className="encounter-main">
          <CaseSurface entries={entries} annotations={annotations} collapsedTo={downtime ? 3 : undefined} />

          <section className="phase-panel" aria-labelledby="phase-heading">
            <p className="eyebrow">
              {reviewing ? 'Reviewing a locked phase' : `Phase ${index + 1} of ${phaseOrder.length}`}
            </p>
            <h2 id="phase-heading" ref={phaseHeading} tabIndex={-1}>
              {shownDef.label}
              {reviewing && (
                <span className="phase-locked-tag">
                  <Lock size={13} aria-hidden="true" /> Locked
                </span>
              )}
            </h2>
            <p className="phase-description">{shownDef.description}</p>
            {reviewing && (
              <button type="button" className="button button-quiet button-small" onClick={() => setViewPhase(null)}>
                Back to {scenario.phases.find((p) => p.id === current)?.label}
              </button>
            )}

            {enc.actionError && (
              <div className="entry entry--system entry--error system-message" role="alert">
                <p>
                  <strong>{enc.actionError.offline ? 'Not recorded: you appear to be offline.' : 'Not recorded.'}</strong> {enc.actionError.offline ? 'Try again when the connection returns.' : enc.actionError.text}
                </p>
                <div className="system-message-actions">
                  <button type="button" className="button button-small" onClick={enc.actionError.retry} disabled={!online}>
                    Try again
                  </button>
                  <button type="button" className="button button-quiet button-small" onClick={enc.dismissError}>
                    Dismiss
                  </button>
                </div>
              </div>
            )}
            {historyNow && <HistoryModeToggle mode={attempt.historyMode} onChange={enc.setHistoryMode} disabled={enc.busy || offlineBlocks} />}

            {voiceNotices.map((n) => (
              <div key={n.id} className="entry entry--system entry--warning system-message" role="alert">
                <p>
                  <strong>Voice request not recorded.</strong> {n.text} {voiceHistory ? 'Try asking again.' : 'You can make the same choice below.'}
                </p>
                <button type="button" className="button button-quiet button-small" onClick={() => setVoiceNotices((all) => all.filter((x) => x.id !== n.id))}>
                  Dismiss
                </button>
              </div>
            ))}
            {markError && (
              <div className="entry entry--system entry--warning system-message" role="alert">
                <p>{markError}</p>
                <button type="button" className="button button-quiet button-small" onClick={clearError}>
                  Dismiss
                </button>
              </div>
            )}

            {voiceHistory ? (
              <HistoryHints hints={attempt.hints} onHint={enc.requestHint} disabled={offlineBlocks} />
            ) : (
              <OptionList
                key={shown}
                label={`${shownDef.label} choices`}
                options={optionsFor(scenario, shown)}
                selected={selected}
                single={shown === 'diagnosis'}
                readOnly={readOnly}
                readOnlyReason={readOnlyReason}
                annotations={annotations}
                shortcuts={settings.shortcuts}
                onChoose={enc.choose}
                onMark={toggle}
              />
            )}

            {!reviewing && current === 'diagnosis' && enc.draft.diagnosis.length > 0 && <ConfidenceToggle value={enc.confidence} onChange={enc.setConfidence} disabled={enc.busy} />}

            {!reviewing && (
              <div className={`phase-footer${downtime ? ' phase-footer--thumb' : ''}`}>
                <p className="phase-hint">
                  {current === 'diagnosis'
                    ? 'Choose one primary diagnosis. It is saved when you lock the phase.'
                    : current === 'treatment'
                      ? 'Choose every plan element. They are saved when you submit.'
                      : voiceHistory
                        ? 'Ask the patient aloud in the voice panel. What you ask is recorded as you go.'
                        : 'Each choice is saved as you make it.'}{' '}
                  {enc.busy && <span>Saving…</span>}
                </p>
                <div className="phase-footer-actions">
                  {downtime && (
                    <>
                      <button type="button" className="button button-quiet thumb-button" onClick={() => stepPhase(-1)} disabled={viewable.indexOf(shown) <= 0}>
                        <ArrowLeft size={16} aria-hidden="true" />
                        <span>Previous phase</span>
                      </button>
                      <button type="button" className="button button-quiet thumb-button" onClick={() => notesField.current?.focus()}>
                        <NotebookPen size={16} aria-hidden="true" />
                        <span>Notes</span>
                      </button>
                    </>
                  )}
                  <button type="button" className="button button-primary" disabled={enc.busy || !online} onClick={() => setConfirm(true)}>
                    {lastPhase ? 'Review and submit' : 'Lock phase and continue'} <ArrowRight size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>

        <aside className="encounter-side" aria-label="Notes and tools">
          <NotesPanel ref={notesField} attemptReady body={notes.body} status={notes.status} conflictBody={notes.conflict?.body ?? null} onChange={notes.change} onResolve={notes.resolve} />
          <div className="side-tools">
            <button type="button" className="button button-quiet button-small" onClick={() => updateSettings({ downtime: !downtime })} aria-pressed={downtime}>
              Downtime mode: {downtime ? 'on' : 'off'}
            </button>
            {settings.shortcuts && (
              <button type="button" className="button button-quiet button-small" onClick={() => setHelp(true)}>
                <Keyboard size={15} aria-hidden="true" /> Keyboard shortcuts
              </button>
            )}
          </div>
          {!downtime && (
            <details className="side-disclosure">
              <summary>Patient and clinician</summary>
              <div className="side-portraits">
                <figure>
                  {/* Portrait falls back to the authored initials if the photo is missing or fails. */}
                  <Portrait config={{ ...scenario.patient.portrait, src: patientPortraitSrc(scenario.id) ?? undefined, alt: portraitAlt }} small />
                  <figcaption>
                    {scenario.patient.name}
                    <small>Fictional patient</small>
                  </figcaption>
                </figure>
                <figure>
                  <Portrait config={scenario.clinician} small />
                  <figcaption>
                    You
                    <small>PA student</small>
                  </figcaption>
                </figure>
              </div>
            </details>
          )}
          <details className="side-disclosure voice-disclosure" open={voiceHistory || undefined}>
            <summary>Voice conversation (optional)</summary>
            <VoicePanel
              attemptId={attempt.id}
              caseId={scenario.id}
              onActivity={enc.refresh}
              onToolRejected={onToolRejected}
              patient={voiceHistory ? { caseId: scenario.id, name: scenario.patient.name, alt: portraitAlt } : undefined}
            />
          </details>
        </aside>
      </div>

      <ConfirmDialog
        open={confirm}
        title={lastPhase ? 'Submit this encounter?' : `Lock ${scenario.phases.find((p) => p.id === current)?.label}?`}
        onClose={() => {
          setConfirm(false)
          if (headingFocusPending.current) {
            headingFocusPending.current = false
            setTimeout(() => phaseHeading.current?.focus(), 0)
          }
        }}
      >
        <p>
          {lastPhase
            ? 'The server grades your choices only after you submit. You can still edit your notes afterwards.'
            : 'You can review this phase later from the phase list, but its choices cannot change after you continue.'}
        </p>
        {enc.actionError && (
          <p className="voice-error" role="alert">
            {enc.actionError.text}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button button-quiet" onClick={() => setConfirm(false)}>
            Keep working
          </button>
          <button type="button" className="button button-primary" disabled={enc.busy || !online} onClick={() => void doConfirm()}>
            {enc.busy ? 'Saving…' : lastPhase ? 'Submit encounter' : 'Lock and continue'}
          </button>
        </div>
      </ConfirmDialog>

      <dialog ref={helpRef} className="confirm-dialog" aria-labelledby="help-title" onClose={() => setHelp(false)}>
        <h2 id="help-title">Keyboard shortcuts</h2>
        <p>Single-key shortcuts work while focus is in the encounter (not while typing). Turn them off in Display settings.</p>
        <dl className="shortcut-list">
          {SHORTCUTS.map(([k, v]) => (
            <div key={k}>
              <dt>
                <kbd>{k}</kbd>
              </dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <div className="modal-actions">
          <button type="button" className="button button-primary" onClick={() => setHelp(false)}>
            Close
          </button>
        </div>
      </dialog>
    </div>
  )
}
