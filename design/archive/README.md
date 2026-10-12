# Archived directions

**Chosen direction:** C, Charted form. It is specified in `docs/design-system.md` and mocked in `design/mocks/c-chart.html`.

The two directions below were explored on 2026-10-11 and not chosen. Keep them for reference only. Do not build screens from them, and do not mix their tokens into the design system without updating `docs/design-system.md` first.

## A — Clinical instrument (`a-instrument.html`)

*A bedside monitor: dark, quiet, and every number legible at a glance.*

- **Dark palette:**
  - bg `#0D0F10`, surface `#141719`, raised `#1B1F21`, line `#272C2F`
  - text `#E4E6E3`, muted `#8B9295`
  - data `#9FE0C0`, caution `#E8B24A`, critical `#FF6A55`
- **Light palette:**
  - bg `#F2F3F1`, surface `#FFFFFF`, line `#D5D9DA`
  - text `#111416`, muted `#5A6266`
  - data `#0F6B4A`, caution `#8A5A00`, critical `#B3261E`
- **Type:** IBM Plex Mono for labels and readouts; IBM Plex Sans for prose.
- **Shape:** 4px radius, 1px hairlines, no shadows.
- **Worth revisiting:** the 3×2 vitals readout with large tabular figures, if a Clinical Sim monitor view ever needs live, changing vitals.

## B — Warm paper (`b-paper.html`)

*A well-made clinical textbook open on the desk: ink, margins, and patience.*

- **Light palette:**
  - bg `#F3EEE4`, page `#FBF8F2`, ink `#26211C`, muted `#6A6056`, rule `#DAD1C2`
  - burgundy `#6B1F2A`, pencil `#7A6A53`
- **Dark palette:**
  - bg `#1A1714`, page `#221E1A`, ink `#EEE6DA`, muted `#B5A999`, rule `#3A332C`
  - accent `#E3A1AA`, pencil `#B8A68C`
- **Type:** Newsreader for display and patient speech; Source Sans 3 for UI.
- **Shape:** 2px radius, ruled lines instead of boxes.
- **Worth revisiting:**
  - the ruled-line notes field
  - the patient's speech set in a serif, distinct from the student's text
  - roman-numeral phase numbering

  These suit long-form reading screens such as teaching points, if the form treatment proves too dense there.
