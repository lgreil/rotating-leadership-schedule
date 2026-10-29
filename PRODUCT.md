# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Five students in a university project seminar (winter 2026/27) building an AI-based Socratic tutoring system on top of the Moodle-based Learnweb. All five are tech-savvy. They share a rotating team-lead role and use this tool to see who leads now and next, enter how much room they have per week, and swap leads when plans change. Typical use: a quick look on the phone after a notification, or a few minutes at a laptop when planning the coming weeks.

## Product Purpose

Plan the rotating team-lead role fairly, taking each person's other commitments into account, from the first period until the final presentation. Success: everybody knows who leads this and next period without asking in the group chat, availability is up to date before a period locks, and the lead load ends up evenly shared by the end of the seminar.

## Positioning

A planner built for exactly this team and ritual: availability traffic lights per week, deterministic fair rotation, automatic Monday lock, push nudges, and a ready-to-paste WhatsApp announcement. Not a general scheduling tool.

## Operating Context

- Sign-in through the team's GitLab instance (gitlab.git.nrw); only the five members have access.
- Announcements go to the team's WhatsApp group (copied text).
- Periods start on Mondays, Europe/Berlin. The first period (weeks 44–45 of 2026) is two weeks long, after that periods are one week. The team may switch to two-week periods later; when is undecided and set in the app.
- The plan ends with the final presentation on Thursday, 4 February 2027.
- Installed as a PWA on phones and laptops; push notifications for availability reminders and lead announcements.

## Capabilities and Constraints

- Cloudflare Worker, single HTML page with vanilla JS, no runtime dependencies, KV storage.
- Public repository: no secrets, no real names or usernames in code or docs.
- English UI, German optional.
- Must work well at phone width.

## Product Principles

1. The answer to "who leads now, who's next, when am I up" is visible without scrolling.
2. Entering availability takes a tap per week, with no forms or confirmation dialogs.
3. Fairness is transparent: anyone can see why the planner picked someone.
4. Nothing irreversible without being obvious: locked periods are clearly marked, swaps are easy to undo.
