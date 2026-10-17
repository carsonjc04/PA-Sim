-- Ledger of every billed voice session the server minted. The browser talks to OpenAI directly, so this
-- table is the server's only record of what is open, and the basis for the cap, idle and re-mint checks.
--
-- client_key is a SHA-256 of the client IP, kept only to block re-minting from the same address; the raw IP
-- is never stored.
CREATE TABLE live_sessions (
  session_id text PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES attempts (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  client_key text NOT NULL,
  started_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL,
  last_activity_at timestamptz NOT NULL,
  -- Set by the sweeper when a session is still open past deadline_at. Blocks new sessions for this user and
  -- client_key until the server confirms the close (ended_at).
  flagged_at timestamptz,
  ended_at timestamptz,
  end_reason text CHECK (end_reason IN ('limit', 'replaced', 'idle', 'client_end', 'assumed_expired'))
);
CREATE INDEX live_sessions_open_idx ON live_sessions (started_at) WHERE ended_at IS NULL;
CREATE INDEX live_sessions_attempt_idx ON live_sessions (attempt_id, started_at DESC);
