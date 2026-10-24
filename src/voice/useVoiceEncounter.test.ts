// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceClientEvents } from './types'
import { useVoiceEncounter } from './useVoiceEncounter'

const captured = vi.hoisted(() => ({ events: null as VoiceClientEvents | null }))
vi.mock('./liveClient', () => ({
  LiveVoiceClient: class {
    constructor(events: VoiceClientEvents) {
      captured.events = events
    }
    start = () => Promise.resolve()
    stop = () => Promise.resolve()
    getDeadline = () => null
  },
}))
vi.mock('../api/client', () => ({ apiBaseUrl: '', authHeaders: () => ({}) }))

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('voice presence', () => {
  it('moves idle → listening → thinking → speaking → idle from speech events', () => {
    const { result } = renderHook(() => useVoiceEncounter('a'))
    expect(result.current.presence).toBe('idle')
    act(() => result.current.connect())
    const events = captured.events!
    act(() => events.onStateChange('live'))
    expect(result.current.presence).toBe('idle')
    act(() => events.onStudentSpeech?.())
    expect(result.current.presence).toBe('listening')
    act(() => void vi.advanceTimersByTime(1_000))
    expect(result.current.presence).toBe('thinking')
    act(() => events.onPatientSpeakingChange(true))
    expect(result.current.presence).toBe('speaking')
    act(() => events.onPatientSpeakingChange(false))
    expect(result.current.presence).toBe('idle')
  })

  it('stops thinking when no reply comes, and is idle when not live', () => {
    const { result } = renderHook(() => useVoiceEncounter('a'))
    act(() => result.current.connect())
    const events = captured.events!
    act(() => events.onStateChange('live'))
    act(() => events.onStudentSpeech?.())
    act(() => void vi.advanceTimersByTime(9_000))
    expect(result.current.presence).toBe('idle')
    act(() => events.onStudentSpeech?.())
    act(() => events.onStateChange('closed'))
    expect(result.current.presence).toBe('idle')
  })
})
