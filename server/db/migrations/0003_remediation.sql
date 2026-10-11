-- Phase 4: remediation loop. Graded misses become evidence; evidence feeds one spaced-review
-- card per user per knowledge component. Timestamps in this feature come from the application
-- clock (not now()) so scheduling is deterministic and testable.

-- IANA zone used for the 04:00 local study-day boundary. Sent by the browser; NULL until first use.
ALTER TABLE users ADD COLUMN time_zone text;

CREATE TABLE scheduler_params (
  id text PRIMARY KEY,
  algorithm_version text NOT NULL,
  params jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One card per user per knowledge component. A repeat miss adds evidence instead of a new card.
CREATE TABLE review_cards (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kc_id text NOT NULL,
  fsrs_state smallint NOT NULL CHECK (fsrs_state BETWEEN 0 AND 3),
  due timestamptz NOT NULL,
  stability double precision NOT NULL,
  difficulty double precision NOT NULL,
  scheduled_days integer NOT NULL,
  learning_steps integer NOT NULL,
  reps integer NOT NULL,
  lapses integer NOT NULL,
  last_review timestamptz,
  algorithm_version text NOT NULL,
  params_id text NOT NULL REFERENCES scheduler_params (id),
  due_reason jsonb NOT NULL,
  last_prompt_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (user_id, kc_id)
);
CREATE INDEX review_cards_due_idx ON review_cards (user_id, due);

-- Every graded miss of every submitted attempt, mapped or not, so each one has a traceable state.
CREATE TABLE remediation_evidence (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL REFERENCES attempts (id) ON DELETE CASCADE,
  scenario_id text NOT NULL,
  rubric_item_id text NOT NULL,
  miss_kind text NOT NULL CHECK (miss_kind IN ('omission', 'unnecessary', 'unsafe', 'critical', 'wrong-diagnosis', 'guessed-correct')),
  error_type text NOT NULL CHECK (error_type IN ('knowledge-gap', 'data-gathering-omission', 'interpretation-error', 'premature-closure', 'unsafe-action', 'communication-lapse', 'guessed-correct')),
  phase text NOT NULL,
  label text NOT NULL,
  status text NOT NULL CHECK (status IN ('linked', 'unmapped')),
  kc_ids text[] NOT NULL DEFAULT '{}',
  remediation_version text,
  created_at timestamptz NOT NULL,
  UNIQUE (attempt_id, rubric_item_id)
);
CREATE INDEX remediation_evidence_user_idx ON remediation_evidence (user_id, created_at);

CREATE TABLE evidence_cards (
  evidence_id uuid NOT NULL REFERENCES remediation_evidence (id) ON DELETE CASCADE,
  card_id uuid NOT NULL REFERENCES review_cards (id) ON DELETE CASCADE,
  PRIMARY KEY (evidence_id, card_id)
);
CREATE INDEX evidence_cards_card_idx ON evidence_cards (card_id);

-- Marks a submitted attempt as processed (even with zero misses); also the claim that makes backfill idempotent.
CREATE TABLE remediation_derivations (
  attempt_id uuid PRIMARY KEY REFERENCES attempts (id) ON DELETE CASCADE,
  derived_at timestamptz NOT NULL,
  remediation_version text,
  miss_count integer NOT NULL
);

-- A review session freezes its queue order and prompt choice so a refresh resumes exactly where it stopped.
CREATE TABLE review_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  local_day date NOT NULL,
  time_zone text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('all', 'micro')),
  card_ids uuid[] NOT NULL,
  prompt_ids text[] NOT NULL,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  closed_at timestamptz,
  closed_reason text CHECK (closed_reason IN ('finished', 'expired', 'restarted'))
);
CREATE UNIQUE INDEX review_sessions_open_idx ON review_sessions (user_id) WHERE closed_at IS NULL;

-- Append-only review log: enough to replay a card under a newer algorithm, plus the idempotent response.
CREATE TABLE review_events (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  card_id uuid NOT NULL REFERENCES review_cards (id) ON DELETE CASCADE,
  session_id uuid REFERENCES review_sessions (id) ON DELETE SET NULL,
  prompt_id text NOT NULL,
  prompt_type text NOT NULL,
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 4),
  latency_ms integer,
  reviewed_at timestamptz NOT NULL,
  state_before jsonb NOT NULL,
  state_after jsonb NOT NULL,
  algorithm_version text NOT NULL,
  params_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX review_events_card_idx ON review_events (card_id, reviewed_at);

-- Product-learning instrumentation only. No free text, no transcripts, no IP or user agent.
-- See docs/remediation.md for the event dictionary and privacy limits.
CREATE TABLE learning_events (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('due', 'shown', 'answered', 'rated', 'retention')),
  card_id uuid NOT NULL REFERENCES review_cards (id) ON DELETE CASCADE,
  session_id uuid REFERENCES review_sessions (id) ON DELETE CASCADE,
  prompt_type text,
  rating smallint,
  latency_ms integer,
  elapsed_days double precision,
  retrievability double precision,
  recalled boolean,
  at timestamptz NOT NULL
);
CREATE UNIQUE INDEX learning_events_once_idx ON learning_events (session_id, card_id, type) WHERE session_id IS NOT NULL;
CREATE INDEX learning_events_type_at_idx ON learning_events (type, at);
