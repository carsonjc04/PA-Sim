# Accessibility and study comfort

What the encounter and debrief support, how it is tested, and what is still manual. See [ux-audit.md](ux-audit.md) for the audit before and after the redesign.

## Guided encounter without a mouse, microphone or AI

The whole guided encounter can be completed with a keyboard alone. It needs only the ClinicSim server, which does the grading. It never needs a microphone or the AI voice service. `e2e/encounter.spec.ts` plays a full case at 360 px using only Tab, arrow keys and Enter, with AI disabled on the server.

| Key | Action |
| --- | --- |
| Tab / Shift+Tab | Move between regions; each choice list is one tab stop |
| ↑ ↓ (or j k), Home, End | Move within the choices |
| Enter or Space | Choose |
| x / h / f | Rule out / mark key / flag to revisit the focused choice |
| n | Go to notes |
| [ and ] | View the previous or next phase (locked phases are read-only) |
| g | Go to the phase heading |
| ? | List shortcuts |
| Escape | Close a dialog (focus returns to the button that opened it) |

**Where shortcuts work.** Single-key shortcuts work only while focus is inside the encounter, and never while typing in a field. They can be turned off in **Display** settings (WCAG 2.1.4).

**Focus after locking a phase.** Focus moves to the new phase heading.

## What is never shown by color alone

**Case entries.** Each entry type has a text label, an icon and its own shape:
- "Patient said" (quotation);
- "Exam finding" (bordered card);
- "Test result";
- "Your note" (dashed);
- "ClinicSim" (system message).

**Choice states** are written out: "Selected" or "Chosen", "Ruled out" (also struck through), "Key" and "Revisit".

**Phases** show their state as text: "In progress", "Locked", "Not started", "Viewing".

**Voice state and cost** are stated in words, including "Muted: still connected and still billed".

**The debrief** labels the safety issue, each kind of miss, key findings and the learner's own marks in text. Scores appear as numbers next to the bars.

## Display settings (header, Display)

**Theme.** Match system, Light or Dark.
- Both themes meet WCAG AA. `scripts/theme/contrast.test.ts` checks 46 token pairs per theme: 4.5:1 for text, and 3:1 for focus rings and control borders.

**Reading size.** 100%, 115%, 130% or 150%.
- All text uses `rem`, with a 12 px minimum at 100%.
- At 150% there is no horizontal page scroll at 360, 390, 768 or 1280 px. This is checked in e2e.

**Motion.** Match system or Reduce. Nothing animates on reveal, and no animation delays study.

**Downtime mode.** A compact, one-handed layout:
- the latest three entries;
- choices at least 56 px tall;
- a fixed bottom bar (previous phase, notes, lock or submit) inside the safe area.

**Shortcuts.** On or off.

**Storage.** Settings are saved in this browser only. An inline script applies them before first paint.

## Screen readers

**Announcements.** A polite live region announces the revealed text itself (for example "Exam finding: …"), phase changes, and the submitted state. Errors use `role="alert"`, and a blocked microphone moves focus to its message.

**Structure.**
- There is one `h1` per page and headings do not skip levels (tested).
- The phase list is a `nav` with `aria-current="step"`.
- The diagnosis is a radio group.
- Choice rows are labelled by the option name, with the hint and state as their description.

**Clinical images.** They render as figures with alt text and an expandable long description. Decorative images use `alt=""`.

**Notes.** The privacy notice is linked to the notes field with `aria-describedby`.

## Automated checks

| Check | Where |
| --- | --- |
| axe (WCAG 2.2 A/AA, best practice; contrast off in jsdom) per encounter, voice, debrief and settings state | `src/features/**/*.test.tsx` with `src/test/axe.ts` |
| axe including color contrast, light and dark, 100% and 150% text, four widths | `e2e/foundations.spec.ts`, `e2e/encounter.spec.ts` |
| Keyboard-only full case, Escape and focus return | `e2e/encounter.spec.ts`, `src/features/encounter/encounter.test.tsx` |
| Microphone denial, offline then sync, reduced motion, 360 px overflow | `e2e/encounter.spec.ts` |
| Token contrast | `scripts/theme/contrast.test.ts` |

Run `npm run db:up && npm run test:e2e`. It needs Postgres and starts its own server, with AI disabled, on port 8788, plus Vite on port 5180.

## Manual checks (not automated)

Real screen-reader runs are not automated. Before a release, check:

1. **VoiceOver (macOS Safari)** and **NVDA (Windows Firefox)**:
   - Complete a case and confirm each revealed finding is read once, with its type.
   - Confirm a phase lock announces the new phase.
   - Confirm the confirmation dialog traps focus and Escape closes it.
2. **Marks:** a choice's marks are read as part of its description.
3. **Notes:** the notes field reads the privacy notice; a conflict is announced and both buttons are reachable.
4. **Voice:** with real voice configured, check that the cost line, End session, the two-minute warning and the automatic end at the limit are announced. No live voice test runs in CI.
5. **Debrief:** read top to bottom. The safety issue is first and the score is last.

## Known limits

- Guided mode needs the ClinicSim server. While offline, choices pause with a stated reason; notes keep saving on the device and sync on reconnect.
- The voice session limit is enforced by the client, not the server.
- jsdom cannot check color contrast or real focus order; the Playwright suite covers both.
