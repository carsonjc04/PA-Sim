# PA-Sim design system: Charted form

Point of view: **the printed encounter form on a clipboard. Labeled fields, a ruled grid, one red stamp.**

This file is the single source for visual decisions. A screen built from it should need no other choices. If something is not specified here, add it here first, then build it.

- **Reference mock:** `design/mocks/c-chart.html`
- **Archived alternatives:** `design/archive/` (not for use)

---

## 1. Color tokens

Each token has the same name in both themes, and component CSS references tokens only. A hex value outside this table is a defect.

| Token | Light | Dark | Use for | Never use for |
|---|---|---|---|---|
| `--bg` | `#E9E7E0` | `#121314` | Page area around the sheet | Text; component fills inside a sheet |
| `--form` | `#F6F5F0` | `#1A1B1D` | Sheet surface, inputs, dialogs, buttons that are not filled | The page area outside a sheet |
| `--grid` | `#C7C3B8` | `#34363A` | 1px rules between cells inside a sheet | Text, input borders, or any border a user must see to operate a control (1.6:1, decorative only) |
| `--grid-strong` | `#8F8B80` | `#6E7178` | Sheet outer edge, section separators, input borders, dashed borders on ruled-out and disabled boxes | Text |
| `--ink` | `#161616` | `#EDEBE4` | Body text, headings, values, unchecked box borders, the focus ring, the secondary button border | Fills larger than 18×18px |
| `--label` | `#5B5A55` | `#A3A29C` | Field labels, helper text, metadata, placeholder text, ruled-out text, upcoming phase tabs | Body copy longer than 1 sentence; anything the student must act on |
| `--stamp` | `#B3261E` | `#F0614F` | Brand and forward motion: the current phase tab fill, the primary button fill, flagged choices, the "Finding revealed" label, plain-button hover text | Errors, critical misses, incorrect answers, destructive actions (those use `--alert`); decoration; icons without text; success states; more than 1 filled element per viewport besides the phase tab |
| `--stamp-hover` | `#931F18` | `#F4806F` | Hover and pressed fill of the primary button | Anything else |
| `--on-stamp` | `#FFFFFF` | `#121314` | Text and icons on `--stamp` or `--stamp-hover` | Text on any other fill |
| `--alert` | `#A3123F` | `#FF7FA0` | Something is wrong or must not be repeated: input errors, voice errors, offline notices, critical misses, `INCORRECT` answers, destructive button text and border | Brand, primary actions, the phase bar, flags, decoration. Never used as a large fill; it appears as text, 1.5px box borders and 1px button borders only |
| `--alert-wash` | `#F8E4EA` | `#3A1B26` | Row background of a critical miss or incorrect answer, and the fill of an error or offline notice | Any element that is not an alert row or notice |
| `--carbon` | `#2D3A44` | `#9DB4C4` | Selected choice boxes, "met" rubric boxes, the voice-connected indicator, selected segment fills, the completed-phase letter | Buttons, links, errors |
| `--carbon-wash` | `#E3E7E9` | `#22292E` | Background of selected rows and hovered rows | Text; any element that is not a row or segment |
| `--focus` | `#161616` | `#EDEBE4` | 2px focus outline | Anything else |
| `--backdrop` | `rgba(22,22,22,.5)` | `rgba(0,0,0,.6)` | Area behind modal dialogs | Anything else |

**Measured contrast (WCAG 2.x).** Every text pairing listed here is AA or better (≥ 4.5:1). Non-text UI pairs only need ≥ 3:1.

| Pair | Light | Dark |
|---|---|---|
| `--ink` on `--form` | 16.58 | 14.45 |
| `--ink` on `--carbon-wash` | 14.54 | 12.36 |
| `--label` on `--form` | 6.33 | 6.73 |
| `--label` on `--bg` | 5.59 | 7.27 |
| `--label` on `--carbon-wash` | 5.55 | 5.76 |
| `--stamp` on `--form` (text) | 5.99 | 5.36 |
| `--stamp` on `--carbon-wash` (text) | 5.25 | 4.58 |
| `--on-stamp` on `--stamp` | 6.54 | 5.78 |
| `--on-stamp` on `--stamp-hover` | 8.57 | 7.23 |
| `--alert` on `--form` (text) | 7.08 | 7.22 |
| `--alert` on `--alert-wash` (text) | 6.36 | 6.45 |
| `--ink` on `--alert-wash` | 14.89 | 12.90 |
| `--label` on `--alert-wash` | 5.69 | 6.01 |
| `--carbon` on `--form` | 10.69 | 8.01 |
| `--form` on `--carbon` (check glyph, segment text) | 10.69 | 8.01 |
| `--grid-strong` on `--form` (input borders, non-text) | 3.12 | 3.53 |

Any pairing not listed here is not permitted until it has been measured and added. Use `contrast()` from `src/theme/contrast.ts`.

**Meaning rule.** Color never carries meaning alone. Every state colored `--stamp`, `--alert` or `--carbon` also has an uppercase text label, such as `FLAGGED`, `CRITICAL`, `MET` or `ERROR`.

**Two reds, two meanings.** `--stamp` (orange-red, hue ≈ 3°) means *this is where you are or what you do next*. `--alert` (crimson, hue ≈ 341°) means *something went wrong*. Hue is not the only signal: alert states also carry an `--alert-wash` row or notice fill, and stamp is never paired with a wash. A screen may show both. Never swap them, and never use `--alert` to draw attention to a normal next step.

## 2. Typography

**Families.** These are the only typefaces.

- **Archivo** (variable `wdth` 62–125, `wght` 400–800) for all UI text and headings. Fallback: `system-ui, sans-serif`.
- **Spline Sans Mono** (400, 500) for values the student entered or received: vitals, patient and student utterances in the exchange log, question prompts under choices, inputs, timestamps and helper notes. Fallback: `ui-monospace, monospace`.

Load them with:
`https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&family=Spline+Sans+Mono:wght@400;500&display=swap`

**Scale.** Base 16px = 1rem. "Stretch" is `font-stretch`.

| Role | Family | Size | Line-height | Weight | Stretch | Tracking | Case | Use |
|---|---|---|---|---|---|---|---|---|
| Display | Archivo | `clamp(1.75rem, 4.4vw, 3.25rem)` (28–52px) | 1.04 | 700 | 112% | -0.02em | As written | The chief complaint on the encounter screen. Max 1 per screen; max 24ch measure |
| Title | Archivo | 2rem (32px) | 1.1 | 700 | 100% | -0.01em | Sentence | Page title on non-encounter screens. Max 1 per screen |
| Section | Archivo | 1.375rem (22px) | 1.1 | 700 | 100% | 0 | Sentence | Phase name, debrief section, review question |
| Subhead | Archivo | 1.0625rem (17px) | 1.3 | 600 | 100% | 0 | Sentence | Panel headings inside a section |
| Body | Archivo | 0.9375rem (15px) | 1.5 | 400 | 100% | 0 | Sentence | Default text, choice titles (weight 600) |
| Body small | Archivo | 0.8125rem (13px) | 1.45 | 400 | 100% | 0 | Sentence | Helper text under a section heading. Minimum size for prose |
| Label | Archivo | 0.6875rem (11px) | 1 | 600 | 75% | 0.1em | UPPER | Field labels, choice status, metadata. Max 6 words |
| Tab | Archivo | 0.8125rem (13px) | 1.2 | 600 | 87.5% | 0.06em | UPPER | Phase bar cells |
| Button | Archivo | 0.8125rem (13px) | 1 | 700 | 87.5% | 0.08em | UPPER | All button text |
| Wordmark | Archivo | 0.9375rem (15px) | 1 | 800 | 125% | 0.02em | UPPER | "PA-SIM", once, in the header |
| Value | Spline Sans Mono | 0.9375rem (15px) | 1.4 | 400 | — | 0 | As written | Field values, vitals, the exchange log |
| Value small | Spline Sans Mono | 0.8125rem (13px) | 1.45 | 400 | — | 0 | As written | Question prompt under a choice, input text (0.875rem / 14px) |
| Meta | Spline Sans Mono | 0.75rem (12px) | 1.4 | 400 | — | 0 | As written | Save status, footnotes, image captions, "PA"/"PT" speaker codes |

**Rules.**

- All numbers use `font-variant-numeric: tabular-nums`.
- Units (`bpm`, `°C`, `%`) are Value small in `--label`, separated by a 4px space.
- Prose measure is max 72ch. Text is left-aligned everywhere, with no centered body text and no justified text.
- No italic anywhere. Emphasis is weight 600 on Archivo.
- Underline is used only for inline links (1px, offset 3px).

## 3. Spacing

- **Base unit:** 4px. The allowed values are 4, 8, 12, 16, 20, 24, 32, 48 and 64px. Any other value is a defect.

| Context | Value |
|---|---|
| Cell padding: fields, choice rows, tabs, panel blocks | 12px vertical, 16px horizontal |
| Section header padding | 20px top, 12px bottom, 16px horizontal |
| Label to value inside a field | 8px |
| Choice grid columns | 20px box, 16px gap, then text, then 96px status column |
| Display block padding | 32px top, 24px bottom, 16px horizontal |
| Sheet margin to viewport | 24px (≥ 861px), 0 (≤ 860px) |
| Page gutter | 16px at every width |
| Between stacked sheets | 24px |

**Layout.**

- **Sheet:** max-width 1120px, centered.
- **Field grid:** 8 equal columns above 860px; 4 at or below.
- **Encounter body split:** 8fr work column, 4fr record column. At or below 860px it becomes 1 column, with the record column below the work column.
- **Breakpoints:** 860px is the only breakpoint. Coarse pointers also apply the 44px rule in §5.

## 4. Radius, borders, shadows

- **Radius:** 0 for everything: buttons, inputs, boxes, dialogs, images, tags and indicators. Set `border-radius: 0` globally. There are no exceptions.
- **Shadows:** none. `box-shadow` is banned, including on dialogs and hover.
- **Rule weights by role:**
  - 1px `--grid` between cells inside a sheet.
  - 1px `--grid-strong` for the sheet edge, between major sections, and on inputs.
  - 1.5px `--ink` for checkbox squares.
  - 2px `--ink` for dialog edges and the focus outline.
- **Hierarchy:** comes from rule weight and position, never from elevation.
- **Cell walls:** adjacent cells share 1 rule. Draw the right and bottom borders on cells, clip the overflowing edge with `overflow: hidden` on the sheet, and give the grid `margin-right: -1px`.
- **Dashed borders:** they mean "not in play" (ruled out, disabled, locked). They mean nothing else.

## 5. Components

### Sheet

- `--form` fill, 1px `--grid-strong` edge, `overflow: hidden`.
- A screen has 1 sheet per task. A second sheet is allowed only for an independent task (e.g. a review queue beside a case list), stacked 24px apart.

### Field (label/value pair)

- Label role on top, Value role 8px below. Cell padding is 12px 16px.
- Width is in field-grid spans: 1, 2, 4 or 8.
- Empty value: `—` in `--label`.
- Mock or placeholder data shows a Meta line: `Mock values … not from the authored case.`

### Buttons

| Variant | Fill | Text | Border | Hover / pressed | Use |
|---|---|---|---|---|---|
| Primary | `--stamp` | `--on-stamp` | none | fill `--stamp-hover` | The 1 forward action per view (advance phase, submit, start case) |
| Secondary | `--form` | `--ink` | 1px `--ink` | fill `--carbon-wash` | Alternatives to the primary action |
| Plain | none | `--ink` | none | text `--stamp` | Header actions (Theme, Exit), inline actions in rows |
| Destructive | `--form` | `--alert` | 1px `--alert` | fill `--alert-wash` | End case, discard notes. Always opens a confirm dialog |

- **Sizes:** default min-height 40px, padding 12px 20px; small min-height 32px, padding 8px 12px. Under `@media (pointer: coarse)`, every button is min-height 44px.
- **Disabled:** fill `--form`, text `--label`, 1px dashed `--grid-strong`, `cursor: not-allowed`. The reason appears as Meta text beside the button.
- **Pressed:** no transform, no scale.
- **Icons:** lucide at 16px, stroke 1.5, `currentColor`, placed after the text with an 8px gap. The only icon used is `→` for forward actions. There are no icon-only buttons except dialog close, which has an `aria-label`.

### Inputs (text, textarea, select)

- **Base:** fill `--form`, 1px `--grid-strong` border, 0 radius, Spline Sans Mono 14px/1.5, `--ink` text.
- **Size:** padding 8px 12px, min-height 40px; textarea min-height 120px, `resize: vertical`.
- **Label:** a Label-role element above the input with an 8px gap, always a `<label for>`.
- **Placeholder:** `--label`. It is never the only label.
- **Focus:** border becomes `--ink`, plus the focus ring.
- **Invalid:** 1px `--alert` border, and a Meta line below it in `--alert` starting `Error:`, linked with `aria-describedby`.
- **Disabled:** dashed `--grid-strong` border, `--label` text.

### Choice rows (encounter actions and review answers)

- **Structure:**
  - a listbox of rows, 1px `--grid` between them
  - grid columns `20px 1fr 96px`, gap 16px, padding 12px 16px
  - title in Body at weight 600
  - the prompt below it in Value small `--label`, 4px gap
  - status in the Label role, right-aligned
- **Box:** 18×18px square, 1.5px border.
- **Mobile (≤ 860px):** the status column moves under the text and is left-aligned.

| State | Row fill | Box | Title / prompt | Status label |
|---|---|---|---|---|
| Default | `--form` | 1.5px `--ink` border, empty | `--ink` / `--label` | none |
| Hover | `--carbon-wash` | unchanged | unchanged | unchanged |
| Selected | `--carbon-wash` | `--carbon` fill, `✕` glyph in `--form` (Value 14px) | unchanged | `ASKED` / `PERFORMED` / `ORDERED` / `CHOSEN` (by phase) in `--carbon` |
| Key (student marked) | unchanged | unchanged | title weight 700 | `KEY` in `--ink` |
| Flagged | unchanged | 1.5px `--stamp` border | unchanged | `FLAGGED` in `--stamp` |
| Ruled out | `--form` | 1.5px dashed `--grid-strong`, empty | both `--label` with `line-through` | `RULED OUT` in `--label` |
| Locked (phase closed) | `--form` | dashed `--grid-strong` | `--label` | `LOCKED` in `--label`; `cursor: not-allowed`; `aria-disabled="true"` |

- **Combined states:** status labels stack vertically, 4px apart, in this order: selected, key, flagged, ruled out.
- **Single-select (review answers):** an 8×8px `--carbon` square centered in the box replaces `✕`.
- **Keyboard:** keep the existing shortcuts in `EncounterPage.tsx` (j/k, Enter/Space, x, h, f). Focus moves with a roving `tabindex`.

### Phase bar

- **Layout:** 5 equal cells in 1 row under the header, 1px `--grid` between them, a 1px `--grid-strong` rule below.
- **Cell content:** a section letter A–E in Spline Sans Mono 500 with an 8px gap, then the phase name in the Tab role.

| State | Fill | Text | Letter |
|---|---|---|---|
| Current | `--stamp` | `--on-stamp` | `--on-stamp` |
| Completed | `--form` | `--ink` | `--carbon`, followed by `✕` |
| Upcoming | `--form` | `--label` | `--label` |
| Viewing a past phase (not current) | `--carbon-wash` | `--ink` | `--carbon` |

- **Semantics:** `aria-current="step"` on the current cell.
- **Mobile (≤ 860px):** cells become `auto` width, the bar scrolls horizontally inside itself (the page never does), and the current cell is scrolled into view on load.
- **No progress indicators:** no percentage and no fill bar. Phases are named, not measured.

### Chief complaint (display block)

- The Label `CHIEF COMPLAINT, IN THE PATIENT'S WORDS`, then the quote in the Display role with curly quotes.
- Padding is 32px 16px 24px, with a 1px `--grid-strong` rule below.
- Only the encounter screen uses this block.

### Exchange log

- Each entry is a 2-column grid: a 28px speaker code (`PA` or `PT` in Meta `--label`), then the utterance in Body.
- Revealed findings add the Label `FINDING REVEALED` in `--stamp` under the utterance.
- Entries are separated by 12px. Newest is at the bottom, and new entries are announced through the existing live region.

### Voice status

- A 10×10px square indicator, then a Value-role status text. The text is always present.

| State | Indicator | Text |
|---|---|---|
| Idle | 1.5px `--ink` border, empty | `Not connected` |
| Connecting | 1.5px `--label` border, empty | `Connecting…` |
| Connected | `--carbon` fill | `Connected · listening` |
| Error | `--alert` fill | `Error: <reason>` in `--alert`, plus a Secondary `Retry` button |

### History mode and hints

- **History mode control:** a segmented row of 2 cells (`VOICE, NO LIST` / `GUIDED LIST`), built like the confidence control (§5, Review cards). It shows only during the history phase. Under it, 1 Label-role line says what the selected mode does, and that a switch is noted in the debrief.
- **Voice history:** no choice rows are rendered: not hidden by CSS, absent from the DOM. The screen holds the chief complaint, the exchange log, voice status and the hint block.
- **Hint block:** a section with the standard section header (`HINTS`), 1 line of Label-role text stating that hints are scaffolding, don't record a question or change the score, and are reported in the debrief. It also holds 1 quiet button (`Show one suggested question`) and a mono `Hints used · n` count. Revealed suggestions form an ordered list, quoted in Value small. A press never moves focus.

### Dialog

- **Container:** `<dialog>` with `--form` fill, 2px `--ink` border, max-width 480px, padding 24px, and `--backdrop` behind it.
- **Content:** the title in the Section role, then body, then actions right-aligned with a 12px gap. The primary or destructive action goes last.

### Notices (error, offline)

- A full-width row inside the sheet, directly under the phase bar: `--alert-wash` fill, a 1px `--alert` rule above and below, padding 12px 16px.
- Content: the Label `ERROR` or `OFFLINE` in `--alert`, then Body text in `--ink` with an 8px gap, then an optional Secondary action (e.g. `Retry`) right-aligned.
- `role="alert"` for errors and `role="status"` for offline.
- There is no informational or success notice variant. Neutral information goes in a Field or Meta line.

### Tags

- The Label role inside a 1px `--grid-strong` border, padding 4px 8px, `--form` fill.
- No filled tags and no pill shapes.

### Debrief panels

The debrief is 1 sheet, ordered:

1. Header fields (case, mode, phases completed).
2. **Critical misses**.
3. Rubric by phase.
4. Timeline.
5. Teaching points.

Each item is a section with the standard section header.

**Rubric rows** use the choice-row grid, with the box showing the outcome:

| Outcome | Box | Status label |
|---|---|---|
| Met | `--carbon` fill, `✕` | `MET` in `--carbon` |
| Missed | 1.5px `--ink` border, empty | `MISSED` in `--ink` |
| Critical miss | 1.5px `--alert` border, empty; row fill `--alert-wash` | `CRITICAL` in `--alert` |
| Unnecessary action taken | dashed `--grid-strong` | `UNNECESSARY` in `--label` |
| Asked after a hint (history checklist) | `--carbon` border, `✕` in `--carbon`, no fill | `ASKED WITH HINT` in `--carbon` |

- **History checklist:** every authored key history question as a rubric row (`ASKED`, `ASKED WITH HINT` or `MISSED`), with its time since start and the authored question quoted. Above it, a Field row: `Hints used · n`, plus any history-mode switches.

- **Evidence:** under each row, the student's own logged action is quoted in Value small, with its phase letter, e.g. `A · "How have these symptoms changed…"`. Missing evidence shows `No matching action in this attempt.`
- **Teaching points:** an ordered list with 2-digit mono numerals (`01`, `02`) in `--label`, Body text, and 12px between items.
- **No headline scores:** no large score numerals, grades, percentages-as-hero or pass/fail banners. A rubric total, if shown, is a Field (`Rubric items met · 9 of 14`).

### Review cards (spaced review)

- **Container:** 1 sheet per card.
- **Header:** Fields for topic and source case, each span 4.
- **Question:** the Section role at weight 600, line-height 1.35, max 60ch.
- **Answers:** single-select choice rows.
- **Confidence control:** a segmented row of 3 cells (`UNSURE` / `FAIRLY SURE` / `SURE`), in the Label role, 1px `--grid-strong` cell walls, each cell min-height 40px. The selected cell has a `--carbon` fill and `--form` text.
- **Feedback after submitting:**
  - The chosen row's status reads `CORRECT` (`--carbon`) or `INCORRECT` (`--alert`, row fill `--alert-wash`).
  - The correct row, if different, gets `ANSWER` in `--carbon`.
  - An explanation block in Body follows, under a `WHY` label.
- **Excluded:** no streak counts, daily goals or countdowns.

### Patient portraits

- **Source:** static committed files at `public/portraits/<caseId>.webp`, resolved by case ID through `src/features/patient/portrait.ts`. A case without a file, or a file that fails to load, renders no image and no placeholder box.
- **Treatment:** square photo, 1px `--grid-strong` border (2px on the voice presence), 0 radius, `object-fit: cover`, never stretched, never filtered or inverted in dark theme.
- **Alt text:** `<Patient name>, the fictional patient in the <case title> case`. Never empty: a portrait is content.
- **Where:** the case library card (full card width, 4:3 crop), the home plate (fills the frame), the encounter header (48×48px, beside the case title), and the voice history presence (96×96px). Nowhere else: never on dashboard, review or analytics screens.

**Voice presence.** The portrait in the voice panel during voice history. Its border colour and a Label-role word carry the state; nothing moves.

| State | Border (2px) | Label |
|---|---|---|
| Waiting (not connected, or connected and quiet) | `--grid-strong` | `WAITING` |
| Listening (student speaking) | `--ink` | `LISTENING` |
| Thinking (student finished, no reply yet) | `--label` | `THINKING` |
| Speaking (patient speaking) | `--carbon` | `SPEAKING` |

- The only motion is `border-color` at 100ms linear (§7). No glow, shadow or scale (§9, §7). Under reduced motion the change is instant.

### Images (clinical findings)

- 1px `--grid-strong` border, 0 radius, never cropped to decorative shapes.
- A caption below in Meta, with alt text from the case content.
- Images are never inverted or filtered in dark theme.

## 6. Focus

- `:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }` applies to every interactive element.
- Never remove the outline without a replacement.
- On a `--stamp`-filled element (current phase tab, primary button), the offset stays 2px so the ring sits on `--form`.
- After a phase advance, focus moves to the phase heading. This is existing behavior; keep it.

## 7. Motion

| What | Property | Duration | Easing |
|---|---|---|---|
| Row and button hover | `background-color`, `color`, `border-color` | 100ms | `linear` |
| Revealed exchange entry, debrief section load | `opacity` 0 → 1 | 150ms | `ease-out` |
| Everything else | none | 0ms | — |

- **Animatable properties:** `opacity`, `color`, `background-color` and `border-color`, and only these.
- **Banned:** `transform` animation of any kind (translate, scale, rotate), bouncing, parallax, animated counters, spinners, skeleton shimmer, `scroll-behavior: smooth`.
- **Loading:** the static text `Loading…` in the Value role.
- **Reduced motion:** under `@media (prefers-reduced-motion: reduce)`, every transition and animation duration is 0ms. Use `* { transition: none !important; animation: none !important; }`.

## 8. Light and dark themes

The mechanism is the one already used by `src/index.css`:

```css
:root { /* light tokens */ }
@media (prefers-color-scheme: dark) { :root:not([data-theme=light]) { /* dark tokens */ } }
:root[data-theme=dark] { /* dark tokens */ }
```

- Light is the default. Dark follows the system unless the user forces a theme in Settings (`data-theme`).
- Both themes define every token in §1. A component never branches on theme; it reads tokens.
- Set `color-scheme: light` or `dark` in the matching block, so native controls and scrollbars follow.
- In dark theme, `--stamp` and `--alert` lighten, and `--on-stamp` becomes near-black. Never put white text on dark-theme `--stamp`.

## 9. Bans

- **Gradients:** no gradients of any kind, including purple/blue ones, gradient portraits and gradient text.
- **Typefaces:** Archivo and Spline Sans Mono are the only typefaces. In particular, no Inter, Roboto, DM Sans, Newsreader or system UI font as the primary face.
- **Layouts:** no three-card (or N-card) feature grids, and no rounded cards.
- **Illustration:** no decorative illustration, blobs, abstract shapes, emoji or mascots.
- **Effects:** no shadows, glows or blur (`backdrop-filter`).
- **Pressure mechanics:** no streaks, daily goals, countdown timers, elapsed-time pressure displays, confetti, badges or leaderboards.
- **Scores:** no hero score numerals, letter grades or readiness percentages.
- **Pills:** no pill shapes, and no radius above 0.
- **Accent color:** no colors outside §1. `--stamp` is the only brand accent; `--alert` is for errors only; `--carbon` marks state, not brand.
- **Text:** no italic, no centered body text and no all-caps text over 6 words.
- **Implying shipped features:** no placeholder content presented as real data, such as case counts, user names or book codes that do not exist.

## 10. Migration notes (for the restyle, not done yet)

- **Fonts:** replace the font import at the top of `src/index.css` (DM Sans + Newsreader) with the URL in §2.
- **Token mapping** from current names:

| Current | New |
|---|---|
| `--bg` | `--bg` |
| `--surface`, `--paper` | `--form` |
| `--line` | `--grid` |
| `--line-strong` | `--grid-strong` |
| `--navy` | `--ink` |
| `--muted`, `--text-2` | `--label` |
| `--teal` as primary action | `--stamp` |
| `--teal` as selected state | `--carbon` |
| `--accent-soft` | `--carbon-wash` |
| `--red`, `--danger-text`, `--danger-line` | `--alert` |
| `--danger-soft`, `--danger-soft-2` | `--alert-wash` |

- **Tokens to remove:** `--amber`, `--warning-*`, `--info-*` and `--patient-*`. Their meanings are carried by text labels (§1, meaning rule).
- **Home screen:** the `.home` burgundy and paper tokens are superseded by §1.
