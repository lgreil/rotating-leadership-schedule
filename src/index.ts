import html from "../public/index.html";
import manifest from "../public/manifest.webmanifest";
import serviceWorker from "../public/sw.js";
import icon192 from "../public/icon-192.png";
import icon512 from "../public/icon-512.png";
import andika400 from "../public/fonts/andika-400.woff2";
import andika700 from "../public/fonts/andika-700.woff2";
import { runCron, type Notify } from "./cron";
import { langOf, t, type Lang } from "./i18n";
import { buildPeriods, computePlan, type Capacity, type HistoryEntry, type Period } from "./plan";
import { sendPush, vapidPublicKey, b64url, fromB64url, type Vapid } from "./push";
import {
  ConfigError,
  loadCapacities,
  loadConfig,
  loadHistory,
  loadSubscriptions,
  saveCadence,
  saveHistory,
  saveSubscriptions,
  type Config,
} from "./store";
import { berlinToday, isWeekKey, weekKeyOf } from "./weeks";

export interface Env {
  LEAD: KVNamespace;
  GITLAB_CLIENT_ID: string;
  GITLAB_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  ALLOWED_USERS: string;
  /** GitLab instance, set in wrangler.toml [vars] */
  GITLAB_URL?: string;
  /** optional – push is disabled without it. Private VAPID key as JWK JSON (see scripts/vapid.mjs) */
  VAPID_PRIVATE_JWK?: string;
  /** optional – contact for push services, e.g. "mailto:team@example.org" */
  VAPID_SUBJECT?: string;
}

const DEFAULT_GITLAB_URL = "https://gitlab.git.nrw";
const SESSION_COOKIE = "lead_session";
const STATE_COOKIE = "lead_oauth_state";
const SESSION_MAX_AGE = 30 * 24 * 3600;
const MAX_SUBSCRIPTIONS = 5;

// Public files: the browser fetches them without the session (manifest) or for the install prompt.
const PUBLIC: Record<string, () => Response> = {
  "/manifest.webmanifest": () => asset(manifest, "application/manifest+json"),
  "/sw.js": () => asset(serviceWorker, "text/javascript; charset=utf-8", "no-cache"),
  "/icon-192.png": () => asset(icon192, "image/png"),
  "/icon-512.png": () => asset(icon512, "image/png"),
  "/fonts/andika-400.woff2": () => asset(andika400, "font/woff2", "public, max-age=31536000, immutable"),
  "/fonts/andika-700.woff2": () => asset(andika700, "font/woff2", "public, max-age=31536000, immutable"),
};

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const lang = langOf(request.headers.get("accept-language"));
    try {
      const pub = PUBLIC[url.pathname];
      if (pub) return pub();
      switch (url.pathname) {
        case "/auth/login":
          return login(url, env);
        case "/auth/callback":
          return await callback(request, url, env, lang);
        case "/auth/logout":
          return page(t(lang).pageSignedOut, lang, 200, [cookie(SESSION_COOKIE, "", 0, "/")]);
      }

      const user = await readSession(request, env);
      if (url.pathname.startsWith("/api/")) {
        // fetch() can't follow a redirect into the OAuth flow, the page handles 401 itself
        if (!user) return json({ error: "unauthorized" }, 401);
        return await api(request, url, env, user);
      }
      if (!user) return redirect(`${url.origin}/auth/login`);
      if (url.pathname === "/" && request.method === "GET") {
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS } });
      }
      return new Response("Not found", { status: 404 });
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.code }, err.status);
      if (err instanceof ConfigError) return json({ error: "invalid_config" }, 500);
      console.error(err);
      return json({ error: "internal" }, 500);
    }
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runCron(env.LEAD, new Date(), notifier(env)));
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------- auth

function login(url: URL, env: Env): Response {
  const state = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const authorize = new URL(`${gitlabUrl(env)}/oauth/authorize`);
  authorize.search = new URLSearchParams({
    client_id: env.GITLAB_CLIENT_ID,
    redirect_uri: `${url.origin}/auth/callback`,
    response_type: "code",
    scope: "read_user",
    state,
  }).toString();
  return redirect(authorize.toString(), [cookie(STATE_COOKIE, state, 600, "/auth")]);
}

async function callback(request: Request, url: URL, env: Env, lang: Lang): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = parseCookies(request)[STATE_COOKIE];
  if (!code || !state || !expected || state !== expected) return page(t(lang).pageBadState, lang, 400);

  const tokenRes = await fetch(`${gitlabUrl(env)}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: env.GITLAB_CLIENT_ID,
      client_secret: env.GITLAB_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: `${url.origin}/auth/callback`,
    }),
  });
  if (!tokenRes.ok) return page(t(lang).pageTokenFailed, lang, 502);
  const { access_token } = await tokenRes.json<{ access_token: string }>();

  const userRes = await fetch(`${gitlabUrl(env)}/api/v4/user`, {
    headers: { authorization: `Bearer ${access_token}` },
  });
  if (!userRes.ok) return page(t(lang).pageUserFailed, lang, 502);
  const username = (await userRes.json<{ username: string }>()).username.toLowerCase();

  const clearState = cookie(STATE_COOKIE, "", 0, "/auth");
  if (!allowedUsers(env).has(username)) return page(t(lang).pageForbidden, lang, 403, [clearState]);
  const session = await createSession(env, username);
  return redirect(`${url.origin}/`, [clearState, cookie(SESSION_COOKIE, session, SESSION_MAX_AGE, "/")]);
}

function gitlabUrl(env: Env): string {
  return (env.GITLAB_URL || DEFAULT_GITLAB_URL).replace(/\/+$/, "");
}

function allowedUsers(env: Env): Set<string> {
  return new Set(
    (env.ALLOWED_USERS ?? "")
      .split(",")
      .map((u) => u.trim().toLowerCase())
      .filter(Boolean),
  );
}

// Session cookie: base64url("<username>:<expiry>") + "." + base64url(HMAC-SHA256)
async function createSession(env: Env, username: string): Promise<string> {
  const payload = `${username}:${Math.floor(Date.now() / 1000) + SESSION_MAX_AGE}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), encode(payload));
  return `${b64url(encode(payload))}.${b64url(sig)}`;
}

async function readSession(request: Request, env: Env): Promise<string | null> {
  const raw = parseCookies(request)[SESSION_COOKIE];
  if (!raw) return null;
  const [payloadB64, sigB64] = raw.split(".");
  if (!payloadB64 || !sigB64) return null;
  try {
    const payload = fromB64url(payloadB64);
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(env), fromB64url(sigB64), payload);
    if (!ok) return null;
    const [username, exp] = new TextDecoder().decode(payload).split(":");
    if (Number(exp) * 1000 < Date.now()) return null;
    // removing someone from ALLOWED_USERS revokes existing sessions
    return allowedUsers(env).has(username) ? username : null;
  } catch {
    return null;
  }
}

function hmacKey(env: Env): Promise<CryptoKey> {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET missing");
  return crypto.subtle.importKey("raw", encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

// ---------------------------------------------------------------- api

async function api(request: Request, url: URL, env: Env, user: string): Promise<Response> {
  switch (`${request.method} ${url.pathname}`) {
    case "GET /api/state":
      return json(buildState(env, user, await loadData(env)));

    case "PUT /api/capacity": {
      const { week, value } = await readJson<{ week: unknown; value: unknown }>(request);
      if (!isWeekKey(week)) throw new HttpError(400, "invalid_week");
      if (value !== 0 && value !== 1 && value !== 2) throw new HttpError(400, "invalid_value");
      const data = await loadData(env);
      if (!data.config.members.some((m) => m.username === user)) throw new HttpError(403, "not_a_member");
      // only ever touches the caller's own key
      const own = { ...data.capacities[user], [week]: value as Capacity };
      await env.LEAD.put(`cap:${user}`, JSON.stringify(own));
      data.capacities[user] = own;
      return json(buildState(env, user, data));
    }

    case "POST /api/override": {
      const { week, leader } = await readJson<{ week: unknown; leader: unknown }>(request);
      const data = await loadData(env);
      const { config, history } = data;
      const period = config.periods.find((p) => p.week === week);
      if (!period) throw new HttpError(400, "invalid_period");
      if (period.weeks[period.weeks.length - 1] < todayWeek()) throw new HttpError(400, "period_in_past");
      if (history.find((h) => h.week === period.week)?.locked) throw new HttpError(409, "period_locked");

      let next = history.filter((h) => h.week !== period.week);
      if (leader !== "" && leader !== null) {
        if (typeof leader !== "string" || !config.members.some((m) => m.username === leader)) {
          throw new HttpError(400, "unknown_person");
        }
        next = [...next, { week: period.week, leader, locked: false, override: true, weeks: period.weeks.length }];
      }
      data.history = await saveHistory(env.LEAD, next);
      return json(buildState(env, user, data));
    }

    case "PUT /api/cadence": {
      // from the period starting at `from` on, all periods are `periodWeeks` long
      const { from, periodWeeks } = await readJson<{ from: unknown; periodWeeks: unknown }>(request);
      if (periodWeeks !== 1 && periodWeeks !== 2) throw new HttpError(400, "invalid_value");
      const data = await loadData(env);
      const { config } = data;
      if (!config.periods.some((p) => p.week === from)) throw new HttpError(400, "invalid_period");
      const today = todayWeek();
      if ((from as string) <= today) throw new HttpError(400, "period_in_past");
      if (data.history.some((h) => h.week >= (from as string) && h.locked)) throw new HttpError(409, "period_locked");

      const cadence = config.cadence.filter((s) => s.from < (from as string));
      if (cadence[cadence.length - 1]?.periodWeeks !== periodWeeks) cadence.push({ from: from as string, periodWeeks });
      const lastWeek = config.periods[config.periods.length - 1].weeks.at(-1)!;
      const periods = buildPeriods(cadence, lastWeek);

      // swaps that no longer start a period are dropped, the rest take the new length
      const starts = new Map(periods.map((p) => [p.week, p.weeks.length]));
      const history = data.history
        .filter((h) => h.week < (from as string) || starts.has(h.week))
        .map((h) => (h.week >= (from as string) ? { ...h, weeks: starts.get(h.week) } : h));

      await saveCadence(env.LEAD, cadence);
      data.history = await saveHistory(env.LEAD, history);
      data.config = { ...config, cadence, periods };
      return json(buildState(env, user, data));
    }

    case "POST /api/push": {
      const { subscription, lang } = await readJson<{ subscription: any; lang: unknown }>(request);
      const { endpoint, keys } = subscription ?? {};
      if (
        typeof endpoint !== "string" ||
        !endpoint.startsWith("https://") ||
        typeof keys?.p256dh !== "string" ||
        typeof keys?.auth !== "string"
      ) {
        throw new HttpError(400, "invalid_subscription");
      }
      const subs = (await loadSubscriptions(env.LEAD, user)).filter((s) => s.endpoint !== endpoint);
      subs.push({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, lang: langOf(String(lang)) });
      await saveSubscriptions(env.LEAD, user, subs.slice(-MAX_SUBSCRIPTIONS));
      return json({ ok: true });
    }

    case "DELETE /api/push": {
      const { endpoint } = await readJson<{ endpoint: unknown }>(request);
      const subs = await loadSubscriptions(env.LEAD, user);
      await saveSubscriptions(env.LEAD, user, subs.filter((s) => s.endpoint !== endpoint));
      return json({ ok: true });
    }

    case "POST /api/push/test": {
      const notify = notifier(env);
      if (!notify) throw new HttpError(501, "push_disabled");
      await notify(user, (lang) => ({ title: t(lang).testTitle, body: t(lang).testBody }));
      return json({ ok: true });
    }
  }
  return json({ error: "not_found" }, 404);
}

interface Data {
  config: Config;
  history: HistoryEntry[];
  capacities: Record<string, Record<string, Capacity>>;
}

async function loadData(env: Env): Promise<Data> {
  const config = await loadConfig(env.LEAD);
  if (!config) throw new HttpError(503, "no_config");
  const [history, capacities] = await Promise.all([loadHistory(env.LEAD), loadCapacities(env.LEAD, config.members)]);
  return { config, history, capacities };
}

function buildState(env: Env, user: string, { config, history, capacities }: Data) {
  const today = todayWeek();
  // past periods only show what happened; the running one and everything after is planned
  const isPast = (p: Period) => p.weeks[p.weeks.length - 1] < today;
  const past = config.periods.filter(isPast);
  const upcoming = config.periods.filter((p) => !isPast(p));
  const byWeek = new Map(history.map((h) => [h.week, h]));
  const plan = [
    ...past.map((p) => {
      const h = byWeek.get(p.week);
      return { ...p, leader: h?.leader ?? "", conflict: false, fixed: !!h, locked: !!h?.locked, override: !!h?.override, reason: "fixed", leaderWeeks: 0 };
    }),
    ...computePlan(config.members, capacities, history, upcoming),
  ];

  // lead weeks done (up to and including the running period) and planned until the season ends
  const done: Record<string, number> = Object.fromEntries(config.members.map((m) => [m.username, 0]));
  const planned: Record<string, number> = { ...done };
  for (const h of history) {
    if (h.week <= today && Object.hasOwn(done, h.leader)) done[h.leader] += h.weeks ?? 1;
  }
  for (const p of plan) {
    if (Object.hasOwn(planned, p.leader)) planned[p.leader] += p.weeks.length;
  }

  const vapid = vapidOf(env);
  return {
    me: user,
    isMember: config.members.some((m) => m.username === user),
    today,
    members: config.members,
    cadence: config.cadence,
    seasonEnd: config.seasonEnd,
    milestones: config.milestones,
    capacities,
    history,
    done,
    planned,
    plan,
    vapidPublicKey: vapid ? vapidPublicKey(vapid.privateJwk) : null,
  };
}

function todayWeek(): string {
  return weekKeyOf(berlinToday(new Date()));
}

// ---------------------------------------------------------------- push

function vapidOf(env: Env): Vapid | null {
  if (!env.VAPID_PRIVATE_JWK) return null;
  return { privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK), subject: env.VAPID_SUBJECT || "mailto:admin@example.invalid" };
}

/** Sends to all devices of a user in their language and forgets subscriptions the push service dropped. */
function notifier(env: Env): Notify | undefined {
  const vapid = vapidOf(env);
  if (!vapid) return undefined;
  return async (username, message) => {
    const subs = await loadSubscriptions(env.LEAD, username);
    const alive = [];
    for (const sub of subs) {
      try {
        const status = await sendPush(vapid, sub, message(sub.lang));
        if (status === 404 || status === 410) continue;
        if (status >= 400) console.warn(`push to ${username} failed: ${status}`);
      } catch (err) {
        console.warn(`push to ${username} failed`, err);
      }
      alive.push(sub);
    }
    if (alive.length !== subs.length) await saveSubscriptions(env.LEAD, username, alive);
  };
}

// ---------------------------------------------------------------- http helpers

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

function asset(body: string | ArrayBuffer, type: string, cache = "public, max-age=86400"): Response {
  return new Response(body, { headers: { "content-type": type, "cache-control": cache } });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function readJson<T>(request: Request): Promise<Partial<T>> {
  // requiring JSON forces a CORS preflight for cross-site requests (CSRF protection on top of SameSite=Lax)
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    throw new HttpError(415, "json_required");
  }
  try {
    return (await request.json()) as Partial<T>;
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

function page(message: string, lang: Lang, status: number, cookies: string[] = []): Response {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
  for (const c of cookies) headers.append("set-cookie", c);
  const body = `<!doctype html><html lang="${lang}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Team Lead</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem">
<p>${message}</p><p><a href="/auth/login">${t(lang).pageSignIn}</a></p></body></html>`;
  return new Response(body, { status, headers });
}

function cookie(name: string, value: string, maxAge: number, path: string): string {
  return `${name}=${value}; Max-Age=${maxAge}; Path=${path}; HttpOnly; Secure; SameSite=Lax`;
}

function parseCookies(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const encode = (s: string) => new TextEncoder().encode(s);

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
