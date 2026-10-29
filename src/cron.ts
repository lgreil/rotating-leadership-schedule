// Hourly cron: lock the running period and send push notifications.
// Everything is idempotent, so running it any number of times per hour is harmless.

import { formatDate, t, type Lang } from "./i18n";
import { computePlan, periodContaining } from "./plan";
import type { PushMessage } from "./push";
import { loadCapacities, loadConfig, loadHistory, saveHistory, type Config, type Store } from "./store";
import { addWeeks, berlinClock, mondayOf, weekKeyOf } from "./weeks";

export type Notify = (username: string, message: (lang: Lang) => PushMessage) => Promise<void>;

interface At {
  weekday: number; // ISO, 1 = Monday
  hour: number;
}
/** In the week before a period: remind people without availability for it. */
export const REMIND_AT: At = { weekday: 3, hour: 10 };
/** In the week before a period: tell the planned leader. */
export const ANNOUNCE_AT: At = { weekday: 5, hour: 15 };
/** When a period is locked: tell its leader, if they weren't the one announced (e.g. after a swap). */
export const LEAD_AT_HOUR = 8;

const MARKER_TTL = 90 * 24 * 3600;

export async function runCron(kv: Store, now: Date, notify?: Notify): Promise<void> {
  const config = await loadConfig(kv);
  if (!config) return;
  const clock = berlinClock(now);
  const today = weekKeyOf(clock.day);
  await lockCurrentPeriod(kv, config, today);
  if (notify) await sendNotifications(kv, config, today, clock, notify);
}

/** Writes the leader of the running period as locked. */
export async function lockCurrentPeriod(kv: Store, config: Config, today: string): Promise<void> {
  const period = periodContaining(config.periods, today);
  if (!period) return;

  const history = await loadHistory(kv);
  const existing = history.find((h) => h.week === period.week);
  if (existing?.locked) return;

  if (existing) {
    existing.locked = true; // a manual override becomes final
    existing.weeks = period.weeks.length;
  } else {
    const capacities = await loadCapacities(kv, config.members);
    const [planned] = computePlan(config.members, capacities, history, [period]);
    if (!planned.leader) return;
    history.push({ week: period.week, leader: planned.leader, locked: true, override: false, weeks: period.weeks.length });
  }
  await saveHistory(kv, history);
  console.log(`Locked lead for ${period.week}`);
}

async function sendNotifications(
  kv: Store,
  config: Config,
  today: string,
  clock: { weekday: number; hour: number },
  notify: Notify,
): Promise<void> {
  const reached = (at: At) => clock.weekday > at.weekday || (clock.weekday === at.weekday && clock.hour >= at.hour);
  const weekNo = (week: string) => Number(week.slice(6));
  const dateOf = (week: string, lang: Lang) => formatDate(mondayOf(week), lang);
  const history = await loadHistory(kv);
  const current = periodContaining(config.periods, today);

  if (current && reached({ weekday: 1, hour: LEAD_AT_HOUR })) {
    const entry = history.find((h) => h.week === current.week && h.locked);
    if (entry && (await kv.get(`announced:${current.week}`)) !== entry.leader) {
      await notify(entry.leader, (lang) => ({
        title: t(lang).leadTitle,
        body: t(lang).leadBody(weekNo(current.week), dateOf(current.week, lang)),
      }));
      await kv.put(`announced:${current.week}`, entry.leader, { expirationTtl: MARKER_TTL });
    }
  }

  // the next period, in the week right before it starts
  const next = config.periods.find((p) => p.week > today);
  if (!next || addWeeks(next.week, -1) !== today) return;
  const capacities = await loadCapacities(kv, config.members);

  if (reached(REMIND_AT) && !(await kv.get(`reminded:${next.week}`))) {
    for (const m of config.members) {
      if (next.weeks.some((w) => capacities[m.username]?.[w] === undefined)) {
        await notify(m.username, (lang) => ({
          title: t(lang).remindTitle,
          body: t(lang).remindBody(weekNo(next.week), dateOf(next.week, lang)),
        }));
      }
    }
    await kv.put(`reminded:${next.week}`, "1", { expirationTtl: MARKER_TTL });
  }

  if (reached(ANNOUNCE_AT) && !(await kv.get(`announced:${next.week}`))) {
    const [planned] = computePlan(config.members, capacities, history, [next]);
    if (!planned.leader) return;
    await notify(planned.leader, (lang) => ({
      title: t(lang).announceTitle(dateOf(next.week, lang)),
      body: t(lang).announceBody(weekNo(next.week)),
    }));
    await kv.put(`announced:${next.week}`, planned.leader, { expirationTtl: MARKER_TTL });
  }
}
