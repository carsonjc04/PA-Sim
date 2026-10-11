import { Check } from 'lucide-react'
import { useRef, useState, type KeyboardEvent } from 'react'
import { annotationMarks, type AnnotationMark, type AnnotationTargetKind, type PublicAnnotation } from '../../api/contracts'
import { MARK_ACTION, MARK_KEY, marksFor, type OptionData } from './encounterModel'
import { MarkBadges } from './CaseSurface'

interface Props {
  /** Accessible name of the group (the phase). */
  label: string
  options: OptionData[]
  selected: string[]
  /** Diagnosis is a single choice (radio semantics); everything else is a set of toggles. */
  single: boolean
  /** Choosing is impossible (locked phase, review, offline, saving). Marks still work. */
  readOnly: boolean
  readOnlyReason?: string
  annotations: PublicAnnotation[]
  shortcuts: boolean
  onChoose: (id: string) => void
  onMark: (kind: AnnotationTargetKind, id: string, mark: AnnotationMark) => void
}

const isTyping = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))

/**
 * Options for the current phase. One tab stop for the whole list (roving tabindex): arrows or j/k move,
 * Enter or Space choose, and x / h / f rule out, mark key or flag the focused row. Every state is shown in
 * text as well as icon and color.
 */
export function OptionList({ label, options, selected, single, readOnly, readOnlyReason, annotations, shortcuts, onChoose, onMark }: Props) {
  const [active, setActive] = useState(0)
  const [openMarks, setOpenMarks] = useState<string | null>(null)
  const rows = useRef<(HTMLButtonElement | null)[]>([])
  const focusRow = (i: number) => {
    const next = Math.max(0, Math.min(options.length - 1, i))
    setActive(next)
    rows.current[next]?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || isTyping(e.target)) return
    const fromRow = rows.current.indexOf(e.target as HTMLButtonElement)
    if (fromRow === -1) return
    const key = e.key
    if (key === 'ArrowDown' || (shortcuts && key === 'j')) return void (e.preventDefault(), focusRow(fromRow + 1))
    if (key === 'ArrowUp' || (shortcuts && key === 'k')) return void (e.preventDefault(), focusRow(fromRow - 1))
    if (key === 'Home') return void (e.preventDefault(), focusRow(0))
    if (key === 'End') return void (e.preventDefault(), focusRow(options.length - 1))
    if (!shortcuts) return
    const mark = annotationMarks.find((m) => MARK_KEY[m] === key)
    if (mark) {
      e.preventDefault()
      const o = options[fromRow]
      onMark(o.targetKind, o.id, mark)
    }
  }

  return (
    <div className="option-list" role={single ? 'radiogroup' : 'group'} aria-label={label} aria-describedby={readOnly && readOnlyReason ? 'options-readonly' : undefined} onKeyDown={onKeyDown}>
      {readOnly && readOnlyReason && (
        <p className="options-readonly" id="options-readonly">
          {readOnlyReason}
        </p>
      )}
      {options.map((o, i) => {
        const isSelected = selected.includes(o.id)
        const marks = marksFor(annotations, o.targetKind, o.id)
        const ruledOut = marks.includes('ruled_out')
        return (
          <div key={o.id} className={`option-row${isSelected ? ' is-selected' : ''}${ruledOut ? ' is-ruled-out' : ''}`}>
            <button
              type="button"
              ref={(el) => void (rows.current[i] = el)}
              className="option-choose"
              tabIndex={i === Math.min(active, options.length - 1) ? 0 : -1}
              onFocus={() => setActive(i)}
              {...(single ? { role: 'radio', 'aria-checked': isSelected } : { 'aria-pressed': isSelected })}
              aria-disabled={readOnly || undefined}
              aria-labelledby={`option-${o.id}-label`}
              aria-describedby={`option-${o.id}-hint option-${o.id}-state`}
              onClick={() => !readOnly && onChoose(o.id)}
            >
              <span className="option-check" aria-hidden="true">
                {isSelected ? <Check size={15} /> : null}
              </span>
              <span className="option-text">
                <strong id={`option-${o.id}-label`}>{o.label}</strong>{' '}
                <small id={`option-${o.id}-hint`}>{o.hint}</small>
              </span>
              <span className="option-state" id={`option-${o.id}-state`}>
                {isSelected && <span className="option-selected-text">{single ? 'Chosen' : 'Selected'}</span>}{' '}
                <MarkBadges marks={marks} />
              </span>
            </button>
            <button type="button" className="option-mark-toggle" aria-label={`Mark ${o.label}`} aria-expanded={openMarks === o.id} aria-controls={`marks-${o.id}`} onClick={() => setOpenMarks(openMarks === o.id ? null : o.id)}>
              Mark
            </button>
            {openMarks === o.id && (
              <div className="option-marks" id={`marks-${o.id}`} role="group" aria-label={`Marks for ${o.label}`}>
                {annotationMarks.map((m) => (
                  <button key={m} type="button" className="mark-button" aria-pressed={marks.includes(m)} onClick={() => onMark(o.targetKind, o.id, m)}>
                    {MARK_ACTION[m]}
                    {shortcuts && <kbd aria-hidden="true">{MARK_KEY[m]}</kbd>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
