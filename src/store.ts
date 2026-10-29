// KV access. Every person has their own keys, so concurrent writes never clobber each other:
//   config                                 – written by the admin seed (config.json)
//   cadence                                – period lengths changed in the app; wins over config.cadence
//   history                                – written by cron / swap endpoint
//   cap:<username>, push:<username>        – written only by that user
//   announced:<week>, reminded:<week>      – cron bookkeeping for notifications

import type { Lang } from "./i18n";
import { buildPeriods, type Capacities, type Capacity, type HistoryEntry, type Member, type Period, type Segment } from "./plan";
import type { PushSubscriptionJSON } from "./push";
import { addWeeks, isWeekKey, weekKeyOf } from "./weeks";

export type Store = Pick<KVNamespace, "get" | "put" | "delete">;

/** What config.json contains. `startWeek` + `periodWeeks` is the older single-cadence form. */
interface RawConfig {
  members: Member[];
  cadence?: Segment[];
  startWeek?: string;
  periodWeeks?: number;
  /** ISO date of the last day of the season, e.g. the final presentation */
  seasonEnd?: string;
  /** dates worth showing in the plan, e.g. { "date": "2026-12-14", "kind": "intermediate" } */
  milestones?: Milestone[];
}

/** `kind` has a translated name in the page ("intermediate", "final"); `label` is shown for anything else. */
export interface Milestone {
  date: string;
  kind?: string;
  label?: string;
}

export interface Config {
  members: Member[];
  cadence: Segment[];
  seasonEnd: string | null;
  milestones: Milestone[];
  /** all periods of the season, chronological */
  periods: Period[];
}

export interface StoredSubscription extends PushSubscriptionJSON {
  lang: Lang;
}

export class ConfigError extends Error {}

/** Without a season end, plan one year ahead of the first period. */
const OPEN_END_WEEKS = 52;

export async function loadConfig(kv: Store): Promise<Config | null> {
  const [raw, override] = await Promise.all([
    kv.get<RawConfig>("config", "json"),
    kv.get<Segment[]>("cadence", "json"),
  ]);
  if (!raw) return null;
  if (!Array.isArray(raw.members)) throw new ConfigError("config.members missing");

  const cadence = normalizeCadence(
    override ?? raw.cadence ?? (raw.startWeek ? [{ from: raw.startWeek, periodWeeks: raw.periodWeeks ?? 1 }] : []),
  );
  if (!cadence.length) throw new ConfigError("config.cadence missing");

  let seasonEnd: string | null = null;
  let lastWeek = addWeeks(cadence[0].from, OPEN_END_WEEKS);
  if (raw.seasonEnd) {
    const end = new Date(`${raw.seasonEnd}T00:00:00Z`);
    if (Number.isNaN(end.getTime())) throw new ConfigError("config.seasonEnd is not a date");
    seasonEnd = raw.seasonEnd;
    lastWeek = weekKeyOf(end);
  }

  return {
    members: raw.members.map((m) => ({
      username: String(m.username).trim().toLowerCase(),
      displayName: String(m.displayName ?? m.username).trim(),
    })),
    cadence,
    seasonEnd,
    milestones: normalizeMilestones(raw.milestones ?? []),
    periods: buildPeriods(cadence, lastWeek),
  };
}

function normalizeMilestones(milestones: unknown): Milestone[] {
  if (!Array.isArray(milestones)) throw new ConfigError("config.milestones must be a list");
  return milestones
    .map((m) => {
      if (typeof m?.date !== "string" || Number.isNaN(new Date(`${m.date}T00:00:00Z`).getTime())) {
        throw new ConfigError(`invalid milestone date: ${m?.date}`);
      }
      return {
        date: m.date,
        ...(typeof m.kind === "string" ? { kind: m.kind } : {}),
        ...(typeof m.label === "string" ? { label: m.label } : {}),
      };
    })
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

export function normalizeCadence(segments: unknown): Segment[] {
  if (!Array.isArray(segments)) throw new ConfigError("cadence must be a list");
  return segments
    .map((s) => {
      if (!isWeekKey(s?.from)) throw new ConfigError(`invalid cadence week: ${s?.from}`);
      return { from: s.from as string, periodWeeks: Math.min(4, Math.max(1, Math.floor(Number(s.periodWeeks) || 1))) };
    })
    .sort((a, b) => (a.from < b.from ? -1 : 1));
}

export async function saveCadence(kv: Store, cadence: Segment[]): Promise<void> {
  await kv.put("cadence", JSON.stringify(cadence));
}

export async function loadHistory(kv: Store): Promise<HistoryEntry[]> {
  return (await kv.get<HistoryEntry[]>("history", "json")) ?? [];
}

export async function saveHistory(kv: Store, history: HistoryEntry[]): Promise<HistoryEntry[]> {
  const sorted = [...history].sort((a, b) => (a.week < b.week ? -1 : 1));
  await kv.put("history", JSON.stringify(sorted));
  return sorted;
}

export async function loadCapacities(kv: Store, members: Member[]): Promise<Capacities> {
  const entries = await Promise.all(
    members.map(async (m) => [m.username, (await kv.get<Record<string, Capacity>>(`cap:${m.username}`, "json")) ?? {}]),
  );
  return Object.fromEntries(entries);
}

export async function loadSubscriptions(kv: Store, username: string): Promise<StoredSubscription[]> {
  return (await kv.get<StoredSubscription[]>(`push:${username}`, "json")) ?? [];
}

export async function saveSubscriptions(kv: Store, username: string, subs: StoredSubscription[]): Promise<void> {
  if (subs.length) await kv.put(`push:${username}`, JSON.stringify(subs));
  else await kv.delete(`push:${username}`);
}
