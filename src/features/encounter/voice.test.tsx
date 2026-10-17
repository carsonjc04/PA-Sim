// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceEncounter } from '../../voice/useVoiceEncounter'
import { axeViolations } from '../../test/axe'
import { VoicePanel } from './VoicePanel'

const mocks = vi.hoisted(() => ({ api: { aiStatus: vi.fn() }, voice: {} as VoiceEncounter }))
vi.mock('../../api/client', () => ({ api: mocks.api }))
vi.mock('../../voice/useVoiceEncounter', () => ({ useVoiceEncounter: () => mocks.voice }))

const status = { aiEnabled: true, setupHint: null, maxSessionMinutes: 20, idleTimeoutSeconds: 120, estimatedVoiceRatePerMinuteUsd: 0.05, storeTranscripts: false }
function voice(over: Partial<VoiceEncounter> = {}): VoiceEncounter {
  return { state: 'idle', transcript: [], error: null, patientSpeaking: false, muted: false, usage: null, connectedAt: null, deadlineAt: null, lastSpeechAt: null, endedByServer: null, connect: vi.fn(), disconnect: vi.fn(), toggleMute: vi.fn(), retry: vi.fn(), ...over }
}
const renderPanel = async () => {
  const view = render(<VoicePanel attemptId="a" />)
  await screen.findByRole('heading', { level: 2 })
  // Flush effects so timers armed by the panel exist before a test moves the clock.
  await act(async () => {})
  return view
}

beforeEach(() => {
  mocks.api.aiStatus.mockResolvedValue(status)
  mocks.voice = voice()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('voice cost and session state', () => {
  it('states the cost, the cap and that muting does not stop billing, before connecting', async () => {
    const { container } = await renderPanel()
    expect(screen.getByText(/about \$0\.05 per minute while connected, for up to 20 minutes \(about \$1\.00 in total\)/)).toBeInTheDocument()
    expect(screen.getByText('Muting does not stop the charge; End session does.')).toBeInTheDocument()
    expect(screen.getByText(/transcript is not saved/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect voice' })).toBeInTheDocument()
    expect(await axeViolations(container)).toEqual([])
  })

  it('shows elapsed time and a running estimate while connected, with End session beside Mute', async () => {
    mocks.voice = voice({ state: 'live', connectedAt: Date.now() - 3 * 60_000 - 5_000 })
    await renderPanel()
    expect(screen.getByRole('status')).toHaveTextContent('Connected 3 minutes, about $0.20 so far (an estimate, not a bill).')
    expect(screen.getByRole('button', { name: 'Mute' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'End session' })).toBeInTheDocument()
  })

  it('says plainly that a muted session is still billed', async () => {
    mocks.voice = voice({ state: 'live', muted: true, connectedAt: Date.now() })
    await renderPanel()
    expect(screen.getByText('Muted: still connected and still billed.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'End session' })).toBeInTheDocument()
  })

  it('warns two minutes before the cap and ends the session at the cap', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const disconnect = vi.fn()
    // A long idle timeout keeps this test about the time cap alone.
    mocks.api.aiStatus.mockResolvedValue({ ...status, idleTimeoutSeconds: 600 })
    mocks.voice = voice({ state: 'live', connectedAt: Date.now() - 18 * 60_000, lastSpeechAt: Date.now(), disconnect })
    await renderPanel()
    expect(screen.getByRole('status')).toHaveTextContent('Wrapping up: summarize and close. The session ends in 2 minutes.')
    expect(screen.getByRole('timer')).toHaveTextContent(/^[12]:\d\d$/)
    expect(disconnect).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(2 * 60_000 + 1_000)
    })
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('counts down to the server’s deadline, not the client’s own idea of the cap', async () => {
    mocks.voice = voice({ state: 'live', connectedAt: Date.now(), lastSpeechAt: Date.now(), deadlineAt: Date.now() + 5 * 60_000 })
    await renderPanel()
    expect(screen.getByRole('timer')).toHaveTextContent(/^(5:00|4:59)$/)
  })

  it('warns when no one has spoken for half the idle timeout, then ends the session', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const disconnect = vi.fn()
    mocks.voice = voice({ state: 'live', connectedAt: Date.now() - 70_000, lastSpeechAt: Date.now() - 61_000, disconnect })
    await renderPanel()
    expect(screen.getByRole('alert')).toHaveTextContent('Still there? The session ends soon if no one speaks.')
    await act(async () => {
      vi.advanceTimersByTime(30_000)
    })
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('says why the server ended the session', async () => {
    mocks.voice = voice({ state: 'closed', endedByServer: 'The voice session reached its 20-minute limit and was ended. Continue with the case below.' })
    await renderPanel()
    expect(screen.getByText(/reached its 20-minute limit/)).toBeInTheDocument()
  })

  it('shows a dropped connection as its own state, not billed, with Reconnect', async () => {
    const retry = vi.fn()
    mocks.voice = voice({ state: 'error', retry, error: { code: 'webrtc_failed', message: 'dropped', recoverable: true } })
    await renderPanel()
    expect(screen.getByRole('alert')).toHaveTextContent('Connection lost. You are not billed while disconnected')
    screen.getByRole('button', { name: 'Reconnect voice' }).click()
    expect(retry).toHaveBeenCalled()
  })

  it('moves focus to a blocked-microphone message with how-to-allow help and the guided fallback', async () => {
    mocks.voice = voice({ state: 'error', error: { code: 'microphone_denied', message: 'Microphone access was blocked. Allow it in your browser, then try again.', recoverable: true } })
    await renderPanel()
    const alert = screen.getByRole('alert')
    expect(alert).toHaveFocus()
    expect(alert).toHaveTextContent(/address bar/)
    expect(alert).toHaveTextContent('You can continue in guided mode instead.')
  })

  it('explains when voice is not set up, without blocking guided mode', async () => {
    mocks.api.aiStatus.mockResolvedValue({ ...status, aiEnabled: false, setupHint: 'Set OPENAI_API_KEY on the server.' })
    await renderPanel()
    expect(screen.getByRole('heading', { name: 'Voice is not set up' })).toBeInTheDocument()
    expect(screen.getByText(/Guided mode is complete without voice/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
