# Design

The planner is styled as a classroom chalkboard: a green board, chalk-white ink, and one coloured chalk per person. It is a working screen (an operate surface). The world contributes palette, type, density and one signature move; layout and controls are standard web ones.

## Colour

Dark board in every colour scheme (`color-scheme: dark`). Use-scene: a quick look on the phone after a notification, often in the evening, and planning sessions on a laptop. A board does not turn white, so there is no light theme.

| Token | Value | Use |
| --- | --- | --- |
| `--board` | `#1e3b30` | page ground |
| `--board-deep` | `#173026` | top bar, menus, inputs |
| `--board-lift` | `#25473a` | running period row, hover |
| `--board-wipe` | `#2b5143` | pressed/hover on cells, the wipe in the signature move |
| `--rule` / `--rule-strong` | chalk at 14% / 28% | hairlines, outlines |
| `--chalk` | `#ecf0e6` | text, primary buttons, selected tab |
| `--chalk-2` / `--chalk-3` | chalk at 74% / 62% | secondary / tertiary text (≥ 4.5:1 on `--board`) |
| `--cant` / `--little` / `--good` | `#ff8f7e` / `#f1cb6f` / `#93e4b8` | availability states, errors (`--cant`) |
| `--p0`…`--p4` | `#f4dd6b` `#f5a6c1` `#9fd0f5` `#c9b4f6` `#f7b26c` | one chalk per person, assigned in first-name order and used for that person everywhere (column swatch, lead name and bar, fairness bar, history) |

Focus ring and text selection use `--p0` (yellow chalk).

## Type

- **Andika** (SIL, OFL, self-hosted in `public/fonts/`, 400 and 700): names, headings, week labels, the big lead name. A face made for people learning to read, which keeps the board feeling like school without a handwriting gimmick.
- **System UI** stack for dense data, labels and body text. Tabular numerals everywhere.
- Scale: lead name `clamp(3rem, 11vw, 6rem)`, h2 1.45rem, fact values 1.25rem, body 15px, small 0.8rem.

## Components

- **Board band**: lead name in their chalk colour with a hand-drawn underline (SVG path), the "leads · W44–45" line, a facts list (next up, your turn, next milestone) and the WhatsApp copy button.
- **Tabs**: Plan, Fairness, Settings. Sticky, with arrow-key navigation, and the last tab is remembered.
- **Plan grid**: a table with a period column, a lead column, then one column per person. Your own cells are dashed outline buttons that cycle on tap and take keys 1/2/3 and ↑/↓. Everyone else's cells are icons. On phones the other people collapse into a "Team" column of state dots.
- **Lead cell**: chalk bar plus name plus a reason line ("fewest lead weeks (2)", "longest since leading"…), and lock/swap/conflict icons. It opens the swap menu, which lists everyone with their weeks so far and availability.
- **Milestone rows**: a dashed rule with a yellow flag above the period they fall in. The final presentation closes the table.
- **Fairness bars**: solid = lead weeks done, hatched = planned (the hatching encodes "projected", it is not decoration).
- **Icons**: one inline SVG sprite with a 1.9 stroke and round caps. No emoji as icons.
- **Toast**: a chalk pill at the bottom, coral for errors.

## Motion

One authored moment: **wipe and rewrite**. When a lead changes (a swap, a new plan), the lead cell gets a sponge-wipe sweep and the new name is written in with a left-to-right clip reveal; the board's underline redraws. On first load the board name and underline are written in. `prefers-reduced-motion` turns all of it off.

## Layout

The gutter is `clamp(16px, 4vw, 40px)`. From 900px the board splits into name and facts columns. The page never scrolls sideways at 390px: the grid fits, and wider content scrolls inside its own wrapper.
