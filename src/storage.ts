import type { Attempt } from './domain/types'
const key='clinicsim-attempts-v1'
export function loadAttempts(): Attempt[] { try { const raw=localStorage.getItem(key); if(!raw) return []; const parsed=JSON.parse(raw); return Array.isArray(parsed)?parsed:[] } catch { return [] } }
export function saveAttempts(attempts:Attempt[]) { try { localStorage.setItem(key,JSON.stringify(attempts)) } catch { /* recovery is intentionally silent */ } }
export function resetAttempts(){ try { localStorage.removeItem(key) } catch {} }
