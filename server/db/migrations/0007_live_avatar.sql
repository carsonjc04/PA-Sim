-- Avatar + Voice (pilot): at most one LiveAvatar session rides on a voice session, chosen before it starts.
-- Its minutes live on the same ledger row so the voice cap, the sweeper and the attempt record see both.
-- avatar_started_at is claimed before the provider is called, so parallel requests cannot start two.
ALTER TABLE live_sessions
  ADD COLUMN avatar_session_id text UNIQUE,
  ADD COLUMN avatar_started_at timestamptz,
  ADD COLUMN avatar_deadline_at timestamptz,
  ADD COLUMN avatar_ended_at timestamptz,
  ADD COLUMN avatar_end_reason text CHECK (avatar_end_reason IN ('client_end', 'failed', 'voice_ended', 'limit')),
  -- Credits LiveAvatar reports for the session once it has ended; null until then (the estimate is used).
  ADD COLUMN avatar_credits numeric;
CREATE INDEX live_sessions_open_avatar_idx ON live_sessions (avatar_started_at) WHERE avatar_started_at IS NOT NULL AND avatar_ended_at IS NULL;
