# rotating-leadership-schedule

> 🤖 Fully vibe-coded

A tool to coordinate rotation of leadership role in project work by accounting for other responsibilities whilst guaranteeing for equal share.

**Team Lead Rotation** is a small Cloudflare Worker (TypeScript, no runtime dependencies) that plans a rotating team-lead role over a season, e.g. a project seminar up to its final presentation. Sign-in is via GitLab OAuth on https://gitlab.git.nrw (set as `GITLAB_URL` in `wrangler.toml`). The page is a single HTML file with vanilla JS, served by the worker. It can be installed as an app (PWA) and sends push notifications. The UI is in English, with German as an option (Settings → Language; the browser language picks the default). The visual design is documented in [DESIGN.md](DESIGN.md).

## How it works

- **Season:** `config.cadence` splits the season into periods, e.g. one 2-week period first, then weekly. Anyone can switch to a different length from a future period on (Settings → Period length). The season ends at `config.seasonEnd`; `config.milestones` (e.g. an intermediate presentation) show up in the plan and on the board.
- **Availability:** each person sets can't / little room / good per week by tapping their own column (keys 1/2/3 on a computer). A missing entry counts as little room.
- **Plan** (`src/plan.ts`, pure functions with unit tests). For each period from the running one on, in order:
  1. Anyone who can't is left out.
  2. The previous period's lead can continue if assigning them again keeps their total at or below the whole-week projected equal-share target across the remaining plan. This batches consecutive periods where it still fits the overall balance.
  3. Otherwise, whoever has the fewest **lead weeks** wins, so a 2-week period counts double. Counts include history (including manual swaps, also future ones) plus periods simulated before it. Ties go to more room, then **first name**.
  4. If everyone can't, the person with the fewest weeks is picked anyway and the period is marked as a conflict.

  Each pick carries the rule that decided it, which the page shows under the name ("fewest lead weeks (2)" or "continuing below target").
- **Locking:** an hourly cron checks the Europe/Berlin time. When a new period has started (Monday 00:05 local time, correct in summer and winter), it writes that period's lead to `history` with `locked: true`. It is idempotent, so a doubled or missed run does no harm.
- **Swaps:** anyone signed in can change the lead of a period that isn't locked yet (`override: true`). Choosing "↺ automatic" removes the swap.
- **Push notifications** (opt-in per device, sent by the same hourly cron, all times Europe/Berlin):
  - On Wednesday from 10:00 in the week before a period, people who haven't set their availability for it get a reminder.
  - On Friday from 15:00 in the week before, the planned lead gets "You're team lead from Monday …".
  - On Monday from 08:00, after the lock: if the locked lead isn't the person announced on Friday (for example after a weekend swap), the new lead gets a message.

  The times are constants at the top of `src/cron.ts`. Push texts follow the language chosen on that device.

### KV layout (binding `LEAD`)

| Key | Content | Written by |
| --- | --- | --- |
| `config` | `{ members: [{ username, displayName }], cadence: [{ from, periodWeeks }], seasonEnd, milestones: [{ date, kind }] }`, see `config.example.json` | you (seed, see below) |
| `cadence` | period lengths changed in the app; wins over `config.cadence`, so re-uploading `config.json` doesn't undo them | cadence endpoint |
| `history` | `[{ week, leader, locked, override, weeks }]` | cron, swap and cadence endpoints |
| `cap:<username>` | `{ "2026-W46": 0\|1\|2, … }` | only that user |
| `push:<username>` | that user's push subscriptions (max 5 devices) | only that user |
| `announced:<week>`, `reminded:<week>` | notification bookkeeping, expires after 90 days | cron |

KV is eventually consistent (up to about 60 s), which is fine here.

### API

- `GET /api/state` returns members, cadence, season end and milestones, all availabilities, the history, the plan for the whole season (past periods from history, the rest computed, each with its reason), lead weeks done and planned per person, your own username and the VAPID public key.
- `PUT /api/cadence` with `{ from, periodWeeks }` (1 or 2) changes the period length from a future period on. Swaps that no longer start a period are dropped.
- `PUT /api/capacity` with `{ week, value }` writes only `cap:<you>`.
- `POST /api/override` with `{ week, leader }` swaps the lead (`leader: ""` removes the swap). It only works for periods that aren't locked yet.
- `POST /api/push` with `{ subscription, lang }`, `DELETE /api/push` with `{ endpoint }`, and `POST /api/push/test` manage notifications.

Without a session, pages redirect to `/auth/login` and `/api/*` answers `401`; the page then redirects itself. Write requests must be `application/json`.

## Setup

Requires Node.js 20+.

```bash
npm install
```

### 1. GitLab application

On https://gitlab.git.nrw go to **User settings → Applications → Add new application** (https://gitlab.git.nrw/-/user_settings/applications):

- Redirect URIs (one per line):
  `https://<your-worker>.<your-subdomain>.workers.dev/auth/callback` and
  `http://localhost:8787/auth/callback`
- Confidential: yes. Scope: `read_user` only.

The worker derives the redirect URI from the request origin, so local and production both work with the same app.

### 2. KV namespace

```bash
npx wrangler login
```

```bash
npx wrangler kv namespace create LEAD
```

Put the printed `id` into `wrangler.toml` under `[[kv_namespaces]]`. The ID there belongs to the original deployment; a fork needs its own. KV namespace IDs are not secret.

### 3. Secrets

```bash
npx wrangler secret put GITLAB_CLIENT_ID
```

```bash
npx wrangler secret put GITLAB_CLIENT_SECRET
```

```bash
npx wrangler secret put ALLOWED_USERS
```

`ALLOWED_USERS` is a comma-separated list of GitLab usernames, e.g. `user1,user2,user3,user4,user5`.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

```bash
npx wrangler secret put SESSION_SECRET
```

Paste the random value from the command before. Changing it signs everybody out.

Push notifications (optional; without these, the page just says push isn't configured):

```bash
node scripts/vapid.mjs
```

```bash
npx wrangler secret put VAPID_PRIVATE_JWK
```

Paste the JSON line printed by `scripts/vapid.mjs`. If you change this key later, every device has to turn notifications on again.

```bash
npx wrangler secret put VAPID_SUBJECT
```

The value is a contact for the push services, e.g. `mailto:you@example.org`.

### 4. Seed the config

```bash
cp config.example.json config.json
```

Edit `config.json` with the real usernames and display names. It is gitignored, so names stay out of the public repo. Then upload it:

```bash
npx wrangler kv key put config --path config.json --binding LEAD --remote
```

To change members later, edit `config.json` and run the same command again. If you want to import leads from before, write them as history once:

```bash
npx wrangler kv key put history '[{"week":"2026-W45","leader":"user1","locked":true,"override":false}]' --binding LEAD --remote
```

### 5. Deploy

```bash
npm run deploy
```

### Install as an app

The page has an "Install as app" box with step-by-step instructions for the device you're on (other devices are under "Other devices"). The box disappears once the page runs as the installed app.

- **iPhone / iPad (iOS 16.4+):** open the page in Safari → Share button (square with arrow up) → "Add to Home Screen" → "Add". Push only works when you open the app from the home screen.
- **Android:** open the page in Chrome → ⋮ menu → "Install app" (or "Add to Home screen") → "Install". The page's "Install app" button does the same.
- **Windows / Linux / Mac with Chrome or Edge:** install icon at the right end of the address bar, or the page's "Install app" button.
- **Mac with Safari 17+:** "File" → "Add to Dock…".

Then use "Turn on notifications" on each device and "Send test" to check it.

## Local development

```bash
cp .dev.vars.example .dev.vars
```

Fill in `.dev.vars` (gitignored). For push, add `VAPID_PRIVATE_JWK='<output of node scripts/vapid.mjs>'` and `VAPID_SUBJECT`.

```bash
npx wrangler kv key put config --path config.json --binding LEAD --local
```

```bash
npx wrangler dev --test-scheduled
```

Open http://localhost:8787. To run the cron by hand while dev is running:

```bash
curl "http://localhost:8787/__scheduled?cron=5+*+*+*+*"
```

Tests and type check:

```bash
npm test
```

```bash
npm run typecheck
```

The tests cover the planning rules, ISO weeks and the Berlin time zone, the cron schedule (lock, reminders, announcements) with an in-memory KV, and push encryption/VAPID signatures. For the push test, the payload is decrypted again on the browser side.

## Files

- `src/index.ts`: routing, GitLab OAuth, signed session cookie, API
- `src/plan.ts`: planning logic (`plan.test.ts`)
- `src/cron.ts`: hourly lock and notifications (`cron.test.ts`)
- `src/push.ts`: Web Push (VAPID + aes128gcm) with WebCrypto only (`push.test.ts`)
- `src/store.ts`: KV access; `src/weeks.ts`: ISO weeks / Europe/Berlin; `src/i18n.ts`: server texts
- `public/`: page, service worker, manifest, icons (`scripts/icons.mjs` renders the icons)
