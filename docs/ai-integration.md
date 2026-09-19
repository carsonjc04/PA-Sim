# Future AI integration

ClinicSim currently has no network calls. Any future provider must preserve the deterministic domain contract and keep the grading engine authoritative.

## Pre-generated scenarios

A backend may ask a model to draft a complete `ScenarioDefinition`, but it should:

1. Keep provider credentials and API keys server-side.
2. Version the prompt, model, and `schemaVersion` together.
3. Parse and validate the response with the same strict Zod schema before storage or delivery.
4. Reject unknown IDs, missing phases, unsafe malformed rules, unsupported references, and incomplete rubrics.
5. Run clinician review and content moderation before making a scenario available to students.

## Live patient responses

A live response provider may receive the scenario ID, patient state, phase, and selected action IDs and return a structured patient turn. Set timeouts, retry only bounded transient failures, and handle refusals or unavailable providers without blocking the encounter. Fall back to the static response provider when a response is invalid, unavailable, or clinically unsafe.

Never allow model output to assign grades, change rubric weights, declare correctness, or alter critical-safety rules. The model may supply dialogue or findings; the deterministic grading engine applies authored IDs and score effects.

## Operational safeguards

Keep real patient data out of prompts and logs. Use synthetic identifiers, redact telemetry, and version prompts and schemas so an attempt can be reproduced. Record provider failures as technical events rather than exposing implementation details to students. A provider outage should leave the student with a clear recovery state or deterministic static content, never a blank encounter.
