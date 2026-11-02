import type { HistoryMode } from '../../api/contracts'

const PREFERENCE_KEY = 'clinicsim-history-mode-v1'

/** The student's last-chosen history mode on this device; Talk until they choose. A convenience, never needed for correctness. */
export function readHistoryPreference(): HistoryMode {
  try {
    return localStorage.getItem(PREFERENCE_KEY) === 'guided' ? 'guided' : 'voice'
  } catch {
    return 'voice'
  }
}

export function writeHistoryPreference(mode: HistoryMode) {
  try {
    localStorage.setItem(PREFERENCE_KEY, mode)
  } catch {
    /* storage unavailable: the default applies next time */
  }
}
