# ClinicSim coding agent context

Read this file before making changes. It describes the product direction and working habits for this repository. Inspect the code before assuming a feature exists. If code and this file disagree about what currently works, report the discrepancy and use the code as the source of truth for implementation status.

## Product

ClinicSim is a voice based educational practice app for physician assistant (PA) students. It accompanies a PA study book with separate didactic and clinical sections. Book QR codes should eventually lead students to relevant practice cases. A student should feel as though they are practicing with a standardized patient or managing a realistic clinical encounter, rather than completing a multiple choice quiz.

There are two intended practice modes:

1. **OSCE Practice, for didactic students:** Pick a body system or topic, or choose Random. Initially show only a chief complaint and basic vitals. The student speaks naturally with an AI patient and asks history and review of systems questions. The patient reveals information as appropriate to the case and the student's questions. The student selects examination maneuvers, proposes a differential, orders diagnostics, and gives an assessment, plan, and counseling. An eventual debrief covers history, ROS, exam, differential, diagnostics, treatment/plan, communication, missed items, unnecessary actions, and teaching points.
2. **Clinical Sim, for clinical year students:** Pick a rotation, topic, or chief complaint. Start with a concise presentation, setting, and vitals. The student gathers focused information, prioritizes workup and treatment, reassesses, consults when appropriate, and decides diagnosis and disposition. Cases should usually take 5–10 minutes. Patient state may change when a *case authored for that behavior* supports it. An eventual debrief covers reasoning, workup, prioritization, treatment, reassessment, disposition, delays, unnecessary actions, ideal approach, and EOR/PANCE teaching points.

The product distinction is: **OSCE Practice = conduct the encounter; Clinical Sim = manage the patient.** Future progress tracking should help students identify weak areas and choose similar cases. These are product goals, not claims that the features already exist.

## Current project facts to verify in code

- The project has used a React, React Router, TypeScript, and Vite frontend, plus a Node, Express, and TypeScript backend.
- The OpenAI live voice integration has worked in a deployed version. The frontend has been deployed on Vercel and the backend on Render. Verify current URLs, routes, environment settings, and feature availability from the repository and deployment configuration before changing them.
- OpenAI credentials belong only on the server. The browser may receive only appropriate short lived session credentials or capabilities through the existing server flow. Never put `OPENAI_API_KEY` in Vite client variables, frontend code, logs, test snapshots, or documentation.
- Previous environment options have included `CLIENT_ORIGIN`, `PORT`, voice model settings, session rate limits, maximum session length, and `STORE_TRANSCRIPTS=false`. Verify current names and behavior in code. Do not silently enable transcript storage.
- Tests: Node 22+ and Postgres (`npm run db:up`). On Node 25, jsdom tests need `NODE_OPTIONS=--no-experimental-webstorage`. HTTP tests must use `listenLocal` from `server/test/http.ts`, not a bare `createApp()`, with supertest. See the README's Tests section.
- The visual identity is **Charted form**, specified in `docs/design-system.md` (reference mock: `design/mocks/c-chart.html`). All UI work follows that document: use only its tokens, typefaces (Archivo, Spline Sans Mono), spacing steps and component states, and respect its bans. If a screen needs something the document does not specify, add it to the document first. The existing screens, including the earlier warm-paper/burgundy home screen, have not been restyled yet; migrate them using §10 of the document. Archived directions in `design/archive/` are for reference only.
- The home screen keeps two prominent actions, Start OSCE Practice and Start Clinical Sim, plus the PA study book image. Connect actions only to real flows. Do not invent case counts, streaks, user identities, grades, subscriptions, or book code support.

## Working method

1. For each request, inspect the relevant routes, components, backend contracts, tests, and configuration. Give a short summary of the actual current behavior and the smallest sensible implementation plan.
2. Implement one complete user journey at a time. Prefer an authored case with defined facts, permissible disclosures, expected actions, and a reviewable rubric before expanding to many topics or relying on unrestricted generated cases.
3. Keep the working voice session and existing API behavior intact unless the task explicitly changes them. Integrate new UI into the current architecture; avoid creating parallel fake data or replacing live flows with mock screens.
4. Distinguish shipped features from planned features in the UI. If a destination is unavailable, show a clear unavailable state or omit the action. Do not make a button appear functional when it cannot complete its promised journey.
5. For case interactions, separate patient facing responses from scoring and case state. A patient should not reveal the diagnosis or hidden rubric merely because the student asks. Use the authored case definition as the source of truth for facts and state changes.
6. Treat this as educational software. Avoid claiming clinical accuracy or grading reliability without review by the PA student or a qualified clinical reviewer. Keep feedback traceable to observed student actions and the case rubric; surface uncertainty where relevant.
7. Keep costs and privacy in view: preserve existing server side key handling, origin controls, rate limits, session duration limits, and transcript settings. Do not add personally identifiable patient data or real patient records to test cases.
8. Make interfaces responsive and keyboard accessible. Prioritize clear actions, microphone permission and connection states, recovery from failed sessions, and readable debriefs over decorative polish.
9. Run relevant existing checks and manually follow the changed journey when feasible. Report what changed, what was verified, what still needs a product or clinical decision, and any unverified assumptions. Do not claim a browser or live voice test ran unless it did.

## Priorities for upcoming work

Use these as guidance, not a mandate to build everything at once:

1. A navigable home and case selection flow that clearly distinguishes the two modes.
2. One strong end to end OSCE case using the existing voice implementation, with a case definition and evidence based debrief.
3. PA student testing of realism, pacing, and usefulness of feedback; revise the case and rubric from that review.
4. A distinct, short clinical management case with decision points and explicitly authored state transitions.
5. Accounts, saved performance, recommendations, and book deep links when the core practice journey is validated and their requirements are clear.

When requirements are unresolved, write down the decision needed and continue with work that does not depend on it. Ask for a decision only when it changes the behavior being implemented.
