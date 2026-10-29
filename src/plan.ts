// Pure planning logic: which weeks form a period, and who leads which period. No I/O, fully unit-tested.

import { addWeeks } from "./weeks";

/** 0 = can't, 1 = little room, 2 = good */
export type Capacity = 0 | 1 | 2;
export const DEFAULT_CAPACITY: Capacity = 1;

export interface Member {
  username: string;
  displayName: string;
}

/** username -> week key -> capacity */
export type Capacities = Record<string, Record<string, Capacity>>;

export interface HistoryEntry {
  week: string;
  leader: string;
  locked: boolean;
  override: boolean;
  /** length of the period in weeks; entries written before cadences existed count as 1 */
  weeks?: number;
}

/** From week `from` on, periods are `periodWeeks` long (until the next segment starts). */
export interface Segment {
  from: string;
  periodWeeks: number;
}

export interface Period {
  /** first week of the period, identifies it */
  week: string;
  weeks: string[];
}

/** Why the planner picked this person: the first rule that separated them from the runner-up. */
export type Reason = "fixed" | "only-available" | "fewest-weeks" | "longest-ago" | "more-room" | "alphabetical";

export interface PlannedPeriod extends Period {
  leader: string;
  /** nobody had capacity (computed) or the fixed leader has capacity 0 */
  conflict: boolean;
  /** true if taken from history instead of computed */
  fixed: boolean;
  locked: boolean;
  override: boolean;
  reason: Reason;
  /** lead weeks of the leader before this period (incl. all overrides) */
  leaderWeeks: number;
}

/**
 * Splits the season into periods. Each segment produces periods of its length from its `from`
 * week until the next segment starts; a period never crosses a segment border or `lastWeek`.
 */
export function buildPeriods(segments: Segment[], lastWeek: string): Period[] {
  const sorted = [...segments].sort((a, b) => cmp(a.from, b.from));
  const end = addWeeks(lastWeek, 1);
  const periods: Period[] = [];
  sorted.forEach((segment, i) => {
    const limit = sorted[i + 1] && sorted[i + 1].from < end ? sorted[i + 1].from : end;
    const length = Math.max(1, Math.floor(segment.periodWeeks));
    for (let week = segment.from; week < limit; week = addWeeks(week, length)) {
      const weeks = Array.from({ length }, (_, j) => addWeeks(week, j)).filter((w) => w < limit);
      periods.push({ week, weeks });
    }
  });
  return periods;
}

/** The period that contains `week`, if any. */
export function periodContaining(periods: Period[], week: string): Period | undefined {
  return periods.find((p) => p.weeks.includes(week));
}

/** Capacity of a person for a period: the worst week counts. */
export function capacityFor(capacities: Capacities, username: string, weeks: string[]): Capacity {
  let result: Capacity = 2;
  for (const week of weeks) {
    const c = capacities[username]?.[week] ?? DEFAULT_CAPACITY;
    if (c < result) result = c;
  }
  return result;
}

/**
 * Plans `periods` (chronological). Periods that already have a history entry
 * (locked or manual override) keep that leader; all others are computed:
 *  1. capacity 0 is excluded
 *  2. fewest lead weeks so far (all history incl. overrides + simulated periods before),
 *     so a two-week period weighs double
 *  3. tie: longest time since last lead, then more room, then display name (first name)
 *  4. if everybody has 0: pick by the same order among all, mark as conflict
 */
export function computePlan(
  members: Member[],
  capacities: Capacities,
  history: HistoryEntry[],
  periods: Period[],
): PlannedPeriod[] {
  const usernames = new Set(members.map((m) => m.username));
  // last tiebreak is the display name (first name first), not the username
  const sortName = new Map(members.map((m) => [m.username, m.displayName.toLowerCase()]));
  const count = new Map<string, number>(members.map((m) => [m.username, 0]));
  const lastLead = new Map<string, string>();
  const fixed = new Map(history.map((h) => [h.week, h]));
  const sortedHistory = [...history].sort((a, b) => cmp(a.week, b.week));

  // Overrides for future periods are already counted, so the computed
  // periods in between are balanced around them.
  for (const h of history) {
    if (usernames.has(h.leader)) count.set(h.leader, count.get(h.leader)! + (h.weeks ?? 1));
  }

  const markLead = (username: string, week: string) => {
    if ((lastLead.get(username) ?? "") < week) lastLead.set(username, week);
  };

  let h = 0;
  return periods.map((period) => {
    while (h < sortedHistory.length && sortedHistory[h].week < period.week) {
      markLead(sortedHistory[h].leader, sortedHistory[h].week);
      h++;
    }

    const entry = fixed.get(period.week);
    if (entry) {
      return {
        ...period,
        leader: entry.leader,
        conflict: usernames.has(entry.leader) && capacityFor(capacities, entry.leader, period.weeks) === 0,
        fixed: true,
        locked: entry.locked,
        override: entry.override,
        reason: "fixed",
        leaderWeeks: (count.get(entry.leader) ?? 0) - (entry.weeks ?? 1),
      };
    }

    const cap = (u: string) => capacityFor(capacities, u, period.weeks);
    const available = members.filter((m) => cap(m.username) > 0);
    const conflict = available.length === 0;
    const pool = (conflict ? members : available).map((m) => m.username);
    const keys = [
      (a: string, b: string) => count.get(a)! - count.get(b)!,
      (a: string, b: string) => cmp(lastLead.get(a) ?? "", lastLead.get(b) ?? ""),
      (a: string, b: string) => cap(b) - cap(a),
      (a: string, b: string) => cmp(sortName.get(a)!, sortName.get(b)!) || cmp(a, b),
    ];
    pool.sort((a, b) => keys.reduce((r, key) => r || key(a, b), 0));

    const leader = pool[0] ?? "";
    let reason: Reason = "only-available";
    if (pool.length > 1) {
      const decisive = keys.findIndex((key) => key(pool[0], pool[1]) !== 0);
      reason = (["fewest-weeks", "longest-ago", "more-room", "alphabetical"] as const)[decisive];
    }
    const leaderWeeks = count.get(leader) ?? 0;
    if (leader) {
      count.set(leader, leaderWeeks + period.weeks.length);
      markLead(leader, period.week);
    }
    return { ...period, leader, conflict, fixed: false, locked: false, override: false, reason, leaderWeeks };
  });
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
