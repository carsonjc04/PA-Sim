-- Voice-history scaffolding. A hint records which authored key history item was suggested (action_id) so the
-- debrief can report hints used and mark items asked after a hint. A mode change records the learner switching
-- the history phase between voice (no option list) and guided (option list), detail = {"mode": ...}.
-- Neither is graded: grading reads only type = 'action'.
ALTER TABLE attempt_events DROP CONSTRAINT attempt_events_type_check;
ALTER TABLE attempt_events ADD CONSTRAINT attempt_events_type_check
  CHECK (type IN ('action', 'phase_locked', 'live_started', 'hint_used', 'mode_changed'));
