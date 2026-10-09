import { useEffect, useState } from "react";
import { apiBaseUrl } from "../../api/client";
import { useVoiceEncounter } from "../../voice/useVoiceEncounter";
import type { VoiceConnectionState } from "../../voice/types";

const statusLabel: Record<VoiceConnectionState, string> = {
  idle: "Not connected",
  "requesting-microphone": "Waiting for microphone permission",
  connecting: "Connecting",
  live: "Live",
  closing: "Ending conversation",
  closed: "Conversation ended",
  error: "Problem",
};

interface AiStatus {
  aiEnabled: boolean;
  setupHint: string | null;
}

/** Shares the page's persisted attempt, so voice and guided actions land in one graded log. */
export function VoicePanel({
  attemptId,
  onActivity,
}: {
  attemptId: string;
  onActivity?: () => void;
}) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const voice = useVoiceEncounter(attemptId);

  useEffect(() => {
    fetch(`${apiBaseUrl}/api/ai/status`)
      .then((r) => r.json())
      .then(setStatus)
      .catch(() =>
        setStatus({
          aiEnabled: false,
          setupHint:
            "The ClinicSim backend is not reachable. Start it with npm run dev:server.",
        }),
      );
  }, []);

  // Voice tool calls record server-side; tell the page to refresh its view of the attempt.
  const transcriptLength = voice.transcript.length;
  useEffect(() => {
    if (transcriptLength > 0) onActivity?.();
  }, [transcriptLength, onActivity]);

  if (!status)
    return (
      <section className="voice-panel">Checking voice availability...</section>
    );

  if (!status.aiEnabled) {
    return (
      <section className="voice-panel voice-panel--setup">
        <h3>Voice mode is not configured</h3>
        <p>{status.setupHint}</p>
        <p className="voice-fallback">
          Guided mode below works without an OpenAI key or a microphone.
        </p>
      </section>
    );
  }

  const { state } = voice;
  const connecting =
    state === "requesting-microphone" || state === "connecting";
  const active = state === "live" || connecting || state === "closing";

  return (
    <section className="voice-panel">
      <header className="voice-header">
        <h3>AI voice encounter</h3>
        <span className={`voice-status voice-status--${state}`} role="status">
          {/* Never render as live before session.started arrives. */}
          {state === "live" && voice.patientSpeaking
            ? "Patient speaking"
            : statusLabel[state]}
        </span>
      </header>

      {!active && (
        <button type="button" onClick={voice.connect}>
          Connect voice
        </button>
      )}

      {state === "requesting-microphone" && (
        <p className="voice-hint">
          Your browser is asking for microphone access. Choose Allow.
        </p>
      )}

      {voice.error && (
        <div className="voice-error" role="alert">
          <p>{voice.error.message}</p>
          {voice.error.recoverable && (
            <button type="button" onClick={voice.retry}>
              Try again
            </button>
          )}
          <p className="voice-fallback">
            You can continue in guided mode below instead.
          </p>
        </div>
      )}

      {active && (
        <div className="voice-controls">
          <button
            type="button"
            onClick={voice.toggleMute}
            aria-pressed={voice.muted}
          >
            {voice.muted ? "Unmute" : "Mute"}
          </button>
          <button type="button" onClick={voice.disconnect}>
            End conversation
          </button>
        </div>
      )}

      {voice.muted && (
        <p className="voice-hint">
          Muted. The session is still open and still billed until you end the
          conversation.
        </p>
      )}

      <ol className="voice-transcript">
        {voice.transcript.map((segment) => (
          <li
            key={segment.id}
            className={`voice-turn voice-turn--${segment.speaker}`}
          >
            <span className="voice-speaker">
              {segment.speaker === "student" ? "You — PA Student" : "Patient"}
            </span>
            <p>{segment.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
