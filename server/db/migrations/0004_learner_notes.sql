-- Learner annotations and notes, tied to one attempt and deleted with it.
--
-- Annotations are structured marks on case items (no free text).
-- Notes are learner free text. They live only in this table: never copied into attempt_events,
-- content_versions, attempt_results, remediation_evidence or learning_events, never part of grading
-- input, and served only by the owner-scoped notes endpoint (not inside attempt payloads).
CREATE TABLE attempt_annotations (
  attempt_id uuid NOT NULL REFERENCES attempts (id) ON DELETE CASCADE,
  target_kind text NOT NULL CHECK (target_kind IN ('action', 'diagnosis', 'plan')),
  target_id text NOT NULL,
  mark text NOT NULL CHECK (mark IN ('ruled_out', 'key', 'revisit')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (attempt_id, target_kind, target_id, mark)
);

CREATE TABLE attempt_notes (
  attempt_id uuid PRIMARY KEY REFERENCES attempts (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(body) <= 4000),
  version integer NOT NULL CHECK (version >= 1),
  updated_at timestamptz NOT NULL
);
