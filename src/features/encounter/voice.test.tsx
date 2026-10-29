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

const status = { aiEnabled: true, setupHint: null, maxSessionMinutes: 20, idleTimeoutSeconds: 120, estimatedVoiceRatePerMinuteUsd: 0.05, storeTranscripts: false, avatarCaseIds: ['chest-pressure'], estimatedAvatarRatePerMinuteUsd: 0.1, avatarMaxSeconds: 120 }
function voice(over: Partial<VoiceEncounter> = {}): VoiceEncounter {
  return { state: 'idle', transcript: [], error: null, patientSpeaking: false, presence: 'idle', muted: false, usage: null, connectedAt: null, deadlineAt: null, lastSpeechAt: null, endedByServer: null, avatar: 'off', avatarNotice: null, avatarSince: null, avatarUntil: null, stopAvatar: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), toggleMute: vi.fn(), retry: vi.fn(), ...over }
}
const renderPanel = async (caseId = 'asthma') => {
  const view = render(<VoicePanel attemptId="a" caseId={caseId} />)
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

describe('voice presence portrait', () => {
  const patient = { caseId: 'respiratory', name: 'Maya Chen', alt: 'Maya Chen, the fictional patient in the cough and sore throat case' }
  it.each([
    ['idle', 'Waiting'],
    ['listening', 'Listening'],
    ['thinking', 'Thinking'],
    ['speaking', 'Speaking'],
  ] as const)('shows the %s state as a label and a class, never by motion alone', async (presence, label) => {
    mocks.voice = voice({ state: presence === 'idle' ? 'idle' : 'live', presence, connectedAt: presence === 'idle' ? null : Date.now() })
    render(<VoicePanel attemptId="a" caseId="asthma" patient={patient} />)
    const img = await screen.findByRole('img', { name: patient.alt })
    const figure = img.closest('figure')!
    expect(figure).toHaveClass(`voice-presence--${presence}`)
    expect(figure).toHaveTextContent(label)
  })

  it('shows no portrait outside voice history', async () => {
    await renderPanel()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
})

describe('Avatar + Voice toggle (pilot)', () => {
  it('is offered on the pilot case only, and not when the server has no avatar', async () => {
    await renderPanel('chest-pressure')
    expect(screen.getByRole('radio', { name: 'Voice only' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Avatar + Voice' })).not.toBeChecked()
    cleanup()
    await renderPanel('asthma')
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect voice' })).toBeInTheDocument()
    cleanup()
    mocks.api.aiStatus.mockResolvedValue({ ...status, avatarCaseIds: [] })
    await renderPanel('chest-pressure')
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
  })

  it('is keyboard operable and starts the chosen mode, with its cost stated first', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    const { container } = await renderPanel('chest-pressure')
    await user.tab()
    expect(screen.getByRole('radio', { name: 'Voice only' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('radio', { name: 'Avatar + Voice' })).toBeChecked()
    expect(screen.getByText(/adds about \$0\.10 per minute while it runs, for up to 2 minutes per session/)).toBeInTheDocument()
    expect(await axeViolations(container)).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Connect avatar and voice' }))
    expect(mocks.voice.connect).toHaveBeenCalledWith('avatar')
  })

  it('cannot be changed mid-session', async () => {
    mocks.voice = voice({ state: 'live', connectedAt: Date.now() })
    await renderPanel('chest-pressure')
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
  })

  it('shows the avatar with captions, the fictional-patient notice and a Stop avatar control while live', async () => {
    mocks.voice = voice({ state: 'live', connectedAt: Date.now(), avatar: 'live', avatarSince: Date.now(), transcript: [{ id: 'p1', speaker: 'patient', text: 'It feels like pressure.', startMs: 0, endMs: 1 }] })
    await renderPanel('chest-pressure')
    expect(screen.getByText(/a fictional patient, animated by an AI avatar service\. Not a real person\./)).toBeInTheDocument()
    expect(document.querySelector('.voice-avatar-caption')).toHaveTextContent('It feels like pressure.')
    screen.getByRole('button', { name: 'Stop avatar (keep voice)' }).click()
    expect(mocks.voice.stopAvatar).toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent('Avatar 0 minutes, about $0.10 so far.')
  })

  it('after a failure, says so plainly and keeps voice and the transcript', async () => {
    mocks.voice = voice({
      state: 'live',
      connectedAt: Date.now(),
      avatar: 'ended',
      avatarNotice: 'The avatar connection dropped, so the patient continues as voice only. Your transcript and progress are unchanged.',
      transcript: [{ id: 'p1', speaker: 'patient', text: 'It feels like pressure.', startMs: 0, endMs: 1 }],
    })
    await renderPanel('chest-pressure')
    expect(screen.getByText(/continues as voice only/)).toBeInTheDocument()
    expect(document.querySelector('.voice-avatar')).not.toBeVisible()
    expect(screen.getByRole('list', { name: /Voice transcript/ })).toHaveTextContent('It feels like pressure.')
    expect(screen.getByRole('button', { name: 'End session' })).toBeInTheDocument()
  })
})
