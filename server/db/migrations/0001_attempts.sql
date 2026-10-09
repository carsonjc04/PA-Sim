CREATE TABLE users (
  id uuid PRIMARY KEY,
  auth_provider text NOT NULL,
  external_subject text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (auth_provider, external_subject)
);

-- Immutable snapshot of an authored scenario. Server-only: holds the answer key.
CREATE TABLE content_versions (
  id text PRIMARY KEY,
  scenario_id text NOT NULL,
  schema_version text NOT NULL,
  content_hash text NOT NULL,
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX content_versions_scenario_idx ON content_versions (scenario_id);

CREATE TABLE grading_versions (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE attempts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  scenario_id text NOT NULL,
  content_version_id text NOT NULL REFERENCES content_versions (id),
  status text NOT NULL CHECK (status IN ('active', 'submitted')),
  current_phase text NOT NULL,
  locked_phases text[] NOT NULL DEFAULT '{}',
  next_seq integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz
);
CREATE UNIQUE INDEX attempts_one_active_per_scenario ON attempts (user_id, scenario_id) WHERE status = 'active';
CREATE INDEX attempts_history_idx ON attempts (user_id, created_at DESC, id DESC);

CREATE TABLE attempt_events (
  id bigserial PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES attempts (id) ON DELETE CASCADE,
  seq integer NOT NULL,
  type text NOT NULL CHECK (type IN ('action', 'phase_locked', 'live_started')),
  phase text NOT NULL,
  action_id text,
  kind text,
  confirmed boolean,
  revealed text,
  source text NOT NULL CHECK (source IN ('guided', 'voice', 'system')),
  detail jsonb,
  retracted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, seq)
);
-- Action IDs repeat across phases, so uniqueness includes the phase.
CREATE UNIQUE INDEX attempt_events_live_action ON attempt_events (attempt_id, phase, action_id)
  WHERE type = 'action' AND retracted_at IS NULL;

CREATE TABLE idempotency_keys (
  attempt_id uuid NOT NULL REFERENCES attempts (id) ON DELETE CASCADE,
  key text NOT NULL,
  request_hash text NOT NULL,
  status_code integer NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (attempt_id, key)
);

CREATE TABLE attempt_results (
  attempt_id uuid PRIMARY KEY REFERENCES attempts (id) ON DELETE CASCADE,
  grading_version_id text NOT NULL REFERENCES grading_versions (id),
  content_version_id text NOT NULL REFERENCES content_versions (id),
  input_digest text NOT NULL,
  raw_score integer NOT NULL,
  final_score integer NOT NULL,
  passed boolean NOT NULL,
  critical_safety_error boolean NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
