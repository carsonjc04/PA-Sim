import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api, ApiRequestError } from '../../api/client'
import type { AnnotationMark, AnnotationTargetKind, PublicAnnotation, PublicAttempt, PublicNotes } from '../../api/contracts'
import { phaseOrder, type PhaseId } from '../../domain/types'
import { PHASE_TOOL, planEvents } from './encounterModel'

export type Confidence = 'sure' | 'unsure'
const message = (e: unknown) => (e instanceof ApiRequestError ? e.message : 'Something went wrong.')
const isNetwork = (e: unknown) => e instanceof ApiRequestError && e.code === 'network'

// ---- Connectivity ----

function subscribeOnline(cb: () => void) {
  window.addEventListener('online', cb)
  window.addEventListener('offline', cb)
  return () => {
    window.removeEventListener('online', cb)
    window.removeEventListener('offline', cb)
  }
}
/** Browser connectivity. Guided mode needs the ClinicSim server (grading is server-side), never the AI service. */
export const useOnline = () => useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true)

// ---- Encounter state machine ----

export interface EncounterState {
  attempt: PublicAttempt | null
  resumed: boolean
  /** Findings already recorded when an attempt with progress was resumed (0 for a fresh attempt). */
  resumedFindings: number
  loadError: string | null
  /** The last failed action, shown as a system entry with a retry. */
  actionError: { text: string; offline: boolean; retry: () => void } | null
  busy: boolean
  draft: { diagnosis: string[]; treatment: string[] }
  confidence: Confidence | null
}

/**
 * The guided encounter. Same API calls as before the redesign: start-or-resume, one event per history/exam/
 * diagnostics choice, diagnosis and plan held as drafts until the phase is locked or the case submitted.
 */
export function useEncounter(scenarioId: string | undefined, onNotFound: () => void) {
  const [state, setState] = useState<EncounterState>({ attempt: null, resumed: false, resumedFindings: 0, loadError: null, actionError: null, busy: false, draft: { diagnosis: [], treatment: [] }, confidence: null })
  const patch = useCallback((p: Partial<EncounterState>) => setState((s) => ({ ...s, ...p })), [])
  const stateRef = useRef(state)
  useLayoutEffect(() => {
    stateRef.current = state
  })
  // Retries call the latest handlers through a ref, so a failed action can be repeated without stale closures.
  const handlers = useRef<{ choose: (id: string) => void; advance: () => Promise<boolean>; submit: () => Promise<boolean> } | null>(null)

  useEffect(() => {
    if (!scenarioId) return
    let cancelled = false
    api
      .startAttempt(scenarioId)
      // "Resumed" means there was progress to come back to (a double-mounted effect can also report resumed).
      .then((res) => {
        if (cancelled) return
        const resumed = res.resumed && (res.attempt.events.length > 0 || res.attempt.lockedPhases.length > 0)
        const findings = res.attempt.events.filter((e) => e.revealed && e.phase !== 'diagnosis' && e.phase !== 'treatment').length
        patch({ attempt: res.attempt, resumed, resumedFindings: resumed ? findings : 0 })
      })
      .catch((e) => {
        if (cancelled) return
        if (e instanceof ApiRequestError && e.code === 'scenario_not_found') onNotFound()
        else patch({ loadError: message(e) })
      })
    return () => {
      cancelled = true
    }
  }, [scenarioId, onNotFound, patch])

  const attemptId = state.attempt?.id
  const refresh = useCallback(() => {
    if (!attemptId) return
    api.attempt(attemptId).then((attempt) => patch({ attempt })).catch(() => undefined)
  }, [attemptId, patch])

  const run = useCallback(
    async (fn: () => Promise<PublicAttempt>, retry: () => void): Promise<boolean> => {
      patch({ busy: true, actionError: null })
      try {
        patch({ attempt: await fn(), busy: false })
        return true
      } catch (e) {
        patch({ busy: false, actionError: { text: message(e), offline: isNetwork(e), retry } })
        return false
      }
    },
    [patch],
  )

  const choose = useCallback(
    (id: string) => {
      const { attempt, busy, draft } = stateRef.current
      if (!attempt || busy) return
      const phase = attempt.currentPhase
      if (attempt.lockedPhases.includes(phase)) return
      if (phase === 'diagnosis') return patch({ draft: { ...draft, diagnosis: [id] } })
      if (phase === 'treatment') return patch({ draft: { ...draft, treatment: draft.treatment.includes(id) ? draft.treatment.filter((v) => v !== id) : [...draft.treatment, id] } })
      if (attempt.events.some((e) => e.phase === phase && e.actionId === id)) return
      const again = () => handlers.current?.choose(id)
      void run(async () => (await api.event(attempt.id, { type: 'action', tool: PHASE_TOOL[phase], actionIds: [id] })).attempt, again)
    },
    [patch, run],
  )

  const commitDrafts = useCallback(async (): Promise<PublicAttempt> => {
    const { attempt, draft, confidence } = stateRef.current
    let latest = attempt as PublicAttempt
    const phase = latest.currentPhase
    if (phase === 'diagnosis' && draft.diagnosis.length) {
      latest = (await api.event(latest.id, { type: 'action', tool: 'propose_diagnosis', actionIds: draft.diagnosis, confirmed: true, ...(confidence ? { confidence } : {}) })).attempt
    }
    if (phase === 'treatment') {
      for (const { tool, actionIds } of planEvents(latest.scenario, draft.treatment)) latest = (await api.event(latest.id, { type: 'action', tool, actionIds, confirmed: true })).attempt
    }
    return latest
  }, [])

  const advance = useCallback(async (): Promise<boolean> => {
    const { attempt } = stateRef.current
    if (!attempt) return false
    const phase = attempt.currentPhase
    const again = () => void handlers.current?.advance()
    return run(async () => {
      await commitDrafts()
      return (await api.event(attempt.id, { type: 'lock_phase', phase })).attempt
    }, again)
  }, [commitDrafts, run])

  const submit = useCallback(async (): Promise<boolean> => {
    const { attempt } = stateRef.current
    if (!attempt) return false
    const again = () => void handlers.current?.submit()
    return run(async () => {
      await commitDrafts()
      return api.submit(attempt.id)
    }, again)
  }, [commitDrafts, run])

  useLayoutEffect(() => {
    handlers.current = { choose, advance, submit }
  })

  return {
    ...state,
    refresh,
    choose,
    advance,
    submit,
    setConfidence: (confidence: Confidence | null) => patch({ confidence }),
    dismissError: () => patch({ actionError: null }),
  }
}

export const phaseIndexOf = (p: PhaseId) => phaseOrder.indexOf(p)

// ---- Annotations ----

export function useAnnotations(attemptId: string | undefined) {
  const [annotations, setAnnotations] = useState<PublicAnnotation[]>([])
  const [error, setError] = useState<string | null>(null)
  const ref = useRef(annotations)
  useLayoutEffect(() => {
    ref.current = annotations
  })
  useEffect(() => {
    if (!attemptId) return
    api.annotations(attemptId).then(setAnnotations).catch(() => setAnnotations([]))
  }, [attemptId])

  /** Optimistic toggle; rolls back and reports if the server refuses. */
  const toggle = useCallback(
    (targetKind: AnnotationTargetKind, targetId: string, mark: AnnotationMark) => {
      if (!attemptId) return
      const prev = ref.current
      const current = prev.find((a) => a.targetKind === targetKind && a.targetId === targetId)?.marks ?? []
      const marks = current.includes(mark) ? current.filter((m) => m !== mark) : [...current, mark]
      setAnnotations([...prev.filter((a) => !(a.targetKind === targetKind && a.targetId === targetId)), ...(marks.length ? [{ targetKind, targetId, marks }] : [])])
      setError(null)
      api
        .setAnnotation(attemptId, { targetKind, targetId, marks })
        .then(setAnnotations)
        .catch((e) => {
          setAnnotations(prev)
          setError(isNetwork(e) ? 'Offline: that mark was not saved.' : message(e))
        })
    },
    [attemptId],
  )
  return { annotations, toggle, error, clearError: () => setError(null) }
}

// ---- Notes (autosave with a local draft buffer) ----

export type NotesStatus = 'loading' | 'idle' | 'saving' | 'saved' | 'offline' | 'conflict' | 'error'
const draftKey = (attemptId: string) => `clinicsim-notes-draft:${attemptId}`
const readDraft = (attemptId: string): { body: string; version: number } | null => {
  try {
    const raw = localStorage.getItem(draftKey(attemptId))
    return raw ? (JSON.parse(raw) as { body: string; version: number }) : null
  } catch {
    return null
  }
}
const writeDraft = (attemptId: string, value: { body: string; version: number } | null) => {
  try {
    if (value) localStorage.setItem(draftKey(attemptId), JSON.stringify(value))
    else localStorage.removeItem(draftKey(attemptId))
  } catch {
    /* storage unavailable: the server copy is the only copy */
  }
}

/**
 * Notes autosave 800 ms after typing stops. Unsaved text is buffered on this device so going offline or
 * closing the tab loses nothing, and is flushed when the connection returns. A version conflict is shown
 * to the learner; nothing is overwritten silently.
 */
export function useAttemptNotes(attemptId: string | undefined) {
  const [body, setBody] = useState('')
  const [status, setStatus] = useState<NotesStatus>('loading')
  const [conflict, setConflict] = useState<PublicNotes | null>(null)
  const version = useRef(0)
  const latest = useRef('')
  const saved = useRef('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const save = useCallback(async () => {
    if (!attemptId || latest.current === saved.current) return
    const text = latest.current
    setStatus('saving')
    try {
      const res = await api.saveNotes(attemptId, { body: text, version: version.current })
      version.current = res.version
      saved.current = res.body
      if (latest.current === text) {
        writeDraft(attemptId, null)
        setStatus('saved')
      }
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === 'notes_conflict') {
        setConflict((e.details?.current as PublicNotes | undefined) ?? null)
        setStatus('conflict')
      } else setStatus(isNetwork(e) ? 'offline' : 'error')
    }
  }, [attemptId])

  useEffect(() => {
    if (!attemptId) return
    let cancelled = false
    api
      .notes(attemptId)
      .then((n) => {
        if (cancelled) return
        version.current = n.version
        saved.current = n.body
        const local = readDraft(attemptId)
        // An unsynced local draft based on the current server version wins; an older one becomes a conflict.
        if (local && local.body !== n.body) {
          latest.current = local.body
          setBody(local.body)
          if (local.version === n.version) {
            setStatus('idle')
            void save()
          } else {
            setConflict(n)
            setStatus('conflict')
          }
        } else {
          latest.current = n.body
          setBody(n.body)
          setStatus('idle')
        }
      })
      .catch(() => {
        if (cancelled) return
        const local = readDraft(attemptId)
        if (local) {
          latest.current = local.body
          setBody(local.body)
        }
        setStatus('offline')
      })
    return () => {
      cancelled = true
    }
  }, [attemptId, save])

  // Flush buffered text when the connection returns.
  useEffect(() => {
    const flush = () => void save()
    window.addEventListener('online', flush)
    return () => window.removeEventListener('online', flush)
  }, [save])

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

  const change = useCallback(
    (text: string) => {
      if (!attemptId) return
      latest.current = text
      setBody(text)
      writeDraft(attemptId, { body: text, version: version.current })
      if (status === 'conflict') return
      if (!navigator.onLine) return setStatus('offline')
      setStatus('idle')
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void save(), 800)
    },
    [attemptId, save, status],
  )

  /** Resolve a conflict: keep this device's text (saved over the newer copy) or take the saved copy. */
  const resolve = useCallback(
    (choice: 'mine' | 'theirs') => {
      if (!attemptId || !conflict) return
      version.current = conflict.version
      saved.current = conflict.body
      setConflict(null)
      if (choice === 'theirs') {
        latest.current = conflict.body
        setBody(conflict.body)
        writeDraft(attemptId, null)
        setStatus('saved')
      } else {
        setStatus('idle')
        void save()
      }
    },
    [attemptId, conflict, save],
  )

  return { body, status, conflict, change, resolve, flush: save }
}
