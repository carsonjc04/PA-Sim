import { Settings } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useDisplaySettings, type DisplaySettings } from './displaySettings'

type Choice<K extends keyof DisplaySettings> = { value: DisplaySettings[K]; label: string }

function RadioGroup<K extends 'theme' | 'reading' | 'motion'>({ name, legend, choices, value, onChange }: { name: K; legend: string; choices: Choice<K>[]; value: DisplaySettings[K]; onChange: (v: DisplaySettings[K]) => void }) {
  return (
    <fieldset className="settings-group">
      <legend>{legend}</legend>
      {choices.map((c) => (
        <label key={String(c.value)} className="settings-option">
          <input type="radio" name={name} value={String(c.value)} checked={value === c.value} onChange={() => onChange(c.value)} />
          {c.label}
        </label>
      ))}
    </fieldset>
  )
}

/** Header control that opens a native modal dialog (focus trap and Escape come from the browser). */
export function SettingsButton() {
  const ref = useRef<HTMLDialogElement>(null)
  const [s, update] = useDisplaySettings()
  useEffect(() => {
    const dialog = ref.current
    return () => dialog?.close()
  }, [])
  return (
    <>
      <button type="button" className="settings-trigger" onClick={() => ref.current?.showModal()} aria-haspopup="dialog">
        <Settings size={16} aria-hidden="true" />
        <span>Display</span>
      </button>
      <dialog ref={ref} className="settings-dialog" aria-labelledby="settings-title">
        <form method="dialog">
          <h2 id="settings-title">Display settings</h2>
          <p className="settings-note">Saved in this browser only.</p>
          <RadioGroup name="theme" legend="Theme" value={s.theme} onChange={(theme) => update({ theme })} choices={[{ value: 'system', label: 'Match system' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
          <RadioGroup name="reading" legend="Reading size" value={s.reading} onChange={(reading) => update({ reading })} choices={[{ value: '100', label: 'Default' }, { value: '115', label: 'Large (115%)' }, { value: '130', label: 'Larger (130%)' }, { value: '150', label: 'Largest (150%)' }]} />
          <RadioGroup name="motion" legend="Motion" value={s.motion} onChange={(motion) => update({ motion })} choices={[{ value: 'system', label: 'Match system' }, { value: 'reduce', label: 'Reduce motion' }]} />
          <fieldset className="settings-group">
            <legend>Encounter</legend>
            <label className="settings-option">
              <input type="checkbox" checked={s.downtime} onChange={(e) => update({ downtime: e.target.checked })} />
              Downtime mode (compact, one-handed layout)
            </label>
            <label className="settings-option">
              <input type="checkbox" checked={s.shortcuts} onChange={(e) => update({ shortcuts: e.target.checked })} />
              Single-key shortcuts in the case surface
            </label>
          </fieldset>
          <div className="settings-actions">
            <button type="submit" className="button button-primary">
              Done
            </button>
          </div>
        </form>
      </dialog>
    </>
  )
}
