# Encounter and debrief UX audit

Baseline captured on 2026-10-11, before the redesign, by `npm run test:audit` (`e2e/audit.spec.ts`).

- **Environment:** a real server with **AI voice disabled** and a real browser (Playwright Chromium).
- **Widths:** 1280, 768, 390 and 360 px.
- **Text size:** the browser default.

Screenshots are in [`docs/ux-audit/`](ux-audit/), named `<state>-<width>.png`. Raw measurements are written to `test-results/ux-audit.json`, which is not committed.

The audit records the current state and does not assert anything. The redesign's pass/fail checks live in the other `e2e/` specs.

## Measurements (baseline)

| State | Horizontal overflow (all four widths) | axe violations (WCAG 2.2 A/AA, worst width) |
| --- | --- | --- |
| Loading | 0 px | color-contrast (serious) ×4 |
| Fresh, voice unconfigured | 0 px | color-contrast ×25, scrollable-region-focusable ×1 |
| Finding revealed | 0 px | color-contrast ×27, scrollable-region-focusable ×1 |
| Resumed | 0 px | color-contrast ×27, scrollable-region-focusable ×1 |
| Phase-lock dialog | 0 px | color-contrast ×27, scrollable-region-focusable ×1 |
| Offline action | 0 px | color-contrast ×27, scrollable-region-focusable ×1 |
| Debrief, passed | 0 px | color-contrast ×19 |
| Debrief, critical safety failure | 0 px | color-contrast ×22 |

**Not reachable in this environment.** These states were reviewed in code instead, because the e2e server has no OpenAI key:

- voice live, muted, connection lost, and microphone permission denied (`src/features/encounter/VoicePanel.tsx`, `src/voice/liveClient.ts`);
- tool unavailable (a voice tool call rejected by the server).

## State inventory

| State | Current behavior | Problems found | Target |
| --- | --- | --- | --- |
| Loading | Plain text "Loading encounter..." | Not announced as a status. | `role="status"`, `aria-busy` surface |
| Fresh | No distinct state | No orientation or starting focus. | Opening statement; focus on the phase heading |
| Resumed | " · RESUMED" in the eyebrow only | Easy to miss. Focus is not restored to where the learner was. | Banner with progress; focus on the latest entry |
| Phase complete | Stepper check plus "Phase locked" | The dialog promises later review, but locked phases cannot be viewed. The dialog has no Escape, no focus trap and no focus return. | Read-only review of earlier phases; native `<dialog>` |
| Finding revealed | Same block for every phase, with a "PA" dot | Patient statements, exam findings and test results look identical. The live region says only "N findings revealed". | Typed entries with label and icon; announce the text itself |
| Tool unavailable | Generic red box (guided). Voice rejections are invisible. | No recovery guidance, and nothing from voice is shown. | System entry with a retry |
| Offline | Generic "Could not reach the ClinicSim server" | Choices still look selectable. No offline state, and nothing protects notes. | Offline banner; choices paused with a reason; notes buffered locally |
| Voice unconfigured | Full-width setup box above the case | Takes space from the case. | Compact note; guided mode is complete without voice |
| Microphone denied | Error, "Try again", guided-mode line | Acceptable. Focus is not moved to the message. | Same, plus how-to-allow help and focus to the message |
| Live | Status pill | No elapsed time and no cost. The session cap is advertised but never shown or enforced. | Elapsed time and running estimate; warning and auto-end at the cap |
| Muted | Amber button and billing hint | Good billing copy. Amber is the main signal. | Text state; End session always beside it |
| Connection lost | Error with "Try again" | No distinct state. | "Connection lost" state; manual Reconnect |
| Submitted | Redirect | Not announced. | Announcement, then route |
| Failed safety rule | Banner below a 140 px score ring | The score dominates; the safety lesson comes second. Unsafe and unnecessary items share one list. | Safety first; misses with why they mattered; score last |
| Review | Debrief plus a separate `/review` page | No timeline. The learner's own choices are not shown. | Reasoning timeline; differential evidence; retrieve-later list |

## Cross-cutting findings

**Contrast.** 19–27 elements per page fail WCAG AA contrast.
- The causes are mainly muted grey text (`--muted` on white or `#f5f7f7`), small teal labels, and the 10–11 px eyebrow and meta text.

**Text size.** About 90 font sizes are set in px, many at 9–11 px. Reading size cannot be adjusted.

**Theme.** There is no dark theme, and 75 lines of the stylesheet hard-code colors.

**Keyboard.**
- The transcript is a scroll container that keyboard users cannot reach (`scrollable-region-focusable`).
- Encounter buttons have no `focus-visible` style.
- Focus drops to `<body>` when the phase changes.

**Headings.** The voice panel's h3 comes before the page's h2.

**Clinical images.** They are defined in the content schema, but never sent to the browser or rendered.

**Motion.** It is minimal already. `prefers-reduced-motion` turns off transitions.
