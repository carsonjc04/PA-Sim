export type VoiceConnectionState =
  | 'idle'
  | 'requesting-microphone'
  | 'connecting'
  | 'live'
  | 'closing'
  | 'closed'
  | 'error'

export type Speaker = 'student' | 'patient'

export interface TranscriptSegment {
  id: string
  speaker: Speaker
  text: string
  startMs: number
  endMs: number
}

export type VoiceErrorCode =
  | 'missing_api_key'
  | 'microphone_denied'
  | 'microphone_unavailable'
  | 'unsupported_browser'
  | 'session_failed'
  | 'webrtc_failed'
  | 'data_channel_failed'
  | 'remote_error'
  | 'network'

export interface VoiceError {
  code: VoiceErrorCode
  message: string
  /** Whether retrying without reloading the page is worth offering. */
  recoverable: boolean
}

export interface SessionUsage {
  [key: string]: unknown
}

export interface VoiceClientEvents {
  onStateChange: (state: VoiceConnectionState) => void
  onTranscript: (segments: TranscriptSegment[]) => void
  onError: (error: VoiceError) => void
  onUsage: (usage: SessionUsage) => void
  onPatientSpeakingChange: (speaking: boolean) => void
}

export interface StartVoiceOptions {
  encounterId: string
  apiBaseUrl: string
  signal?: AbortSignal
}
