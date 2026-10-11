import { useCallback, useSyncExternalStore } from 'react'

/** Per-viewer display preferences. Kept in localStorage (a convenience, never needed for correctness). */
export interface DisplaySettings {
  theme: 'system' | 'light' | 'dark'
  reading: '100' | '115' | '130' | '150'
  motion: 'system' | 'reduce'
  /** Compact one-handed encounter layout. */
  downtime: boolean
  /** Single-key encounter shortcuts (only active while focus is in the case surface). */
  shortcuts: boolean
}

export const DISPLAY_KEY = 'clinicsim-display-v1'
export const DEFAULT_DISPLAY: DisplaySettings = { theme: 'system', reading: '100', motion: 'system', downtime: false, shortcuts: true }
const EVENT = 'clinicsim-display'

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback)

export function parseDisplay(raw: string | null): DisplaySettings {
  try {
    const v = raw ? (JSON.parse(raw) as Partial<Record<keyof DisplaySettings, unknown>>) : {}
    return {
      theme: pick(v.theme, ['system', 'light', 'dark'] as const, DEFAULT_DISPLAY.theme),
      reading: pick(v.reading, ['100', '115', '130', '150'] as const, DEFAULT_DISPLAY.reading),
      motion: pick(v.motion, ['system', 'reduce'] as const, DEFAULT_DISPLAY.motion),
      downtime: typeof v.downtime === 'boolean' ? v.downtime : DEFAULT_DISPLAY.downtime,
      shortcuts: typeof v.shortcuts === 'boolean' ? v.shortcuts : DEFAULT_DISPLAY.shortcuts,
    }
  } catch {
    return DEFAULT_DISPLAY
  }
}

let cached: { raw: string | null; value: DisplaySettings } | null = null
export function readDisplay(): DisplaySettings {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(DISPLAY_KEY)
  } catch {
    /* storage unavailable: defaults */
  }
  if (!cached || cached.raw !== raw) cached = { raw, value: parseDisplay(raw) }
  return cached.value
}

/** Mirrors the inline script in index.html, which applies the same attributes before first paint. */
export function applyDisplay(s: DisplaySettings, root: HTMLElement = document.documentElement) {
  if (s.theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', s.theme)
  if (s.reading === '100') root.removeAttribute('data-reading')
  else root.setAttribute('data-reading', s.reading)
  if (s.motion === 'reduce') root.setAttribute('data-motion', 'reduce')
  else root.removeAttribute('data-motion')
}

export function writeDisplay(next: DisplaySettings) {
  try {
    localStorage.setItem(DISPLAY_KEY, JSON.stringify(next))
  } catch {
    /* storage unavailable: applies for this page only */
    cached = { raw: JSON.stringify(next), value: next }
  }
  applyDisplay(next)
  window.dispatchEvent(new Event(EVENT))
}

function subscribe(callback: () => void) {
  window.addEventListener(EVENT, callback)
  window.addEventListener('storage', callback)
  return () => {
    window.removeEventListener(EVENT, callback)
    window.removeEventListener('storage', callback)
  }
}

export function useDisplaySettings(): [DisplaySettings, (patch: Partial<DisplaySettings>) => void] {
  const settings = useSyncExternalStore(subscribe, readDisplay, () => DEFAULT_DISPLAY)
  const update = useCallback((patch: Partial<DisplaySettings>) => writeDisplay({ ...readDisplay(), ...patch }), [])
  return [settings, update]
}

/** True when motion should be minimized: the system preference or the explicit setting. */
export function prefersReducedMotion(s: DisplaySettings): boolean {
  if (s.motion === 'reduce') return true
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}
