-- Restarting a case: the active attempt becomes 'abandoned' (kept, never graded, left out of history, analytics
-- and review) and a new attempt links back to it through restarted_from. The voice budget is summed across that
-- chain, so a restart never resets the voice time already used.
ALTER TABLE attempts DROP CONSTRAINT attempts_status_check;
ALTER TABLE attempts ADD CONSTRAINT attempts_status_check CHECK (status IN ('active', 'submitted', 'abandoned'));
ALTER TABLE attempts ADD COLUMN restarted_from uuid REFERENCES attempts (id) ON DELETE SET NULL;
ALTER TABLE attempts ADD COLUMN abandoned_at timestamptz;
CREATE INDEX attempts_restarted_from_idx ON attempts (restarted_from) WHERE restarted_from IS NOT NULL;
