import { describe, expect, it } from "vitest";
import {
  buildPeriods,
  capacityFor,
  computePlan,
  periodContaining,
  type Capacities,
  type HistoryEntry,
  type Member,
} from "./plan";
import { addWeeks, berlinToday, isWeekKey, mondayOf, weekKeyOf } from "./weeks";

const members: Member[] = ["alpha", "bravo", "charlie", "delta", "echo"].map((u) => ({
  username: u,
  displayName: u.toUpperCase(),
}));

const periods = (start: string, n: number, len = 1) =>
  Array.from({ length: n }, (_, i) => {
    const week = addWeeks(start, i * len);
    return { week, weeks: Array.from({ length: len }, (_, j) => addWeeks(week, j)) };
  });

const locked = (week: string, leader: string): HistoryEntry => ({ week, leader, locked: true, override: false });
const leaders = (plan: { leader: string }[]) => plan.map((p) => p.leader);

describe("computePlan", () => {
  it("rotates alphabetically through everyone when nothing is known", () => {
    const plan = computePlan(members, {}, [], periods("2026-W46", 7));
    expect(leaders(plan)).toEqual(["alpha", "bravo", "charlie", "delta", "echo", "alpha", "bravo"]);
    expect(plan.every((p) => !p.conflict && !p.fixed)).toBe(true);
  });

  it("excludes people with capacity 0", () => {
    const caps: Capacities = { alpha: { "2026-W46": 0 } };
    const plan = computePlan(members, caps, [], periods("2026-W46", 2));
    expect(leaders(plan)).toEqual(["bravo", "alpha"]);
  });

  it("prefers the fewest lead periods from history", () => {
    const history = [locked("2026-W40", "alpha"), locked("2026-W41", "bravo"), locked("2026-W42", "alpha")];
    const plan = computePlan(members, {}, history, periods("2026-W46", 3));
    expect(leaders(plan)).toEqual(["charlie", "delta", "echo"]);
  });

  it("does not prioritize who led longest ago when lead weeks are tied", () => {
    const history = [
      locked("2026-W40", "echo"),
      locked("2026-W41", "delta"),
      locked("2026-W42", "charlie"),
      locked("2026-W43", "bravo"),
      locked("2026-W44", "alpha"),
    ];
    const plan = computePlan(members, {}, history, periods("2026-W45", 3));
    expect(leaders(plan)).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("batches periods evenly and continues the previous lead only up to the whole-week target", () => {
    const plan = computePlan(members, {}, [], periods("2026-W46", 10));
    expect(leaders(plan)).toEqual(["alpha", "alpha", "bravo", "bravo", "charlie", "charlie", "delta", "delta", "echo", "echo"]);
    expect(plan[1].reason).toBe("continued-below-target");

    const afterHistory = computePlan(members, {}, [locked("2026-W45", "alpha")], periods("2026-W46", 10));
    expect(leaders(afterHistory).slice(0, 2)).toEqual(["alpha", "bravo"]);
    expect(afterHistory[0].reason).toBe("continued-below-target");
  });

  it("then by higher capacity, then alphabetically", () => {
    const caps: Capacities = { delta: { "2026-W46": 2 }, echo: { "2026-W46": 2 } };
    const plan = computePlan(members, caps, [], periods("2026-W46", 1));
    expect(leaders(plan)).toEqual(["delta"]);
  });

  it("missing capacity counts as 1", () => {
    expect(capacityFor({}, "alpha", ["2026-W46"])).toBe(1);
    expect(capacityFor({ alpha: { "2026-W46": 2, "2026-W47": 0 } }, "alpha", ["2026-W46", "2026-W47"])).toBe(0);
  });

  it("marks a conflict and still picks the lowest count when everyone is 0", () => {
    const caps: Capacities = Object.fromEntries(members.map((m) => [m.username, { "2026-W46": 0 as const }]));
    const history = [locked("2026-W44", "alpha"), locked("2026-W45", "bravo")];
    const [p] = computePlan(members, caps, history, periods("2026-W46", 1));
    expect(p.leader).toBe("charlie");
    expect(p.conflict).toBe(true);
  });

  it("keeps history entries fixed and counts them", () => {
    const history = [locked("2026-W46", "echo")];
    const plan = computePlan(members, {}, history, periods("2026-W46", 3));
    expect(plan[0]).toMatchObject({ leader: "echo", fixed: true, locked: true });
    expect(leaders(plan)).toEqual(["echo", "alpha", "bravo"]);
  });

  it("counts future overrides like normal leads", () => {
    const history: HistoryEntry[] = [{ week: "2026-W48", leader: "alpha", locked: false, override: true }];
    const plan = computePlan(members, {}, history, periods("2026-W46", 4));
    expect(leaders(plan)).toEqual(["bravo", "charlie", "alpha", "delta"]);
    expect(plan[2]).toMatchObject({ fixed: true, override: true, locked: false });
  });

  it("flags a fixed leader without capacity", () => {
    const history: HistoryEntry[] = [{ week: "2026-W46", leader: "alpha", locked: false, override: true }];
    const [p] = computePlan(members, { alpha: { "2026-W46": 0 } }, history, periods("2026-W46", 1));
    expect(p).toMatchObject({ leader: "alpha", conflict: true });
  });

  it("ignores history of people who are no longer members", () => {
    const plan = computePlan(members, {}, [locked("2026-W40", "former")], periods("2026-W46", 1));
    expect(leaders(plan)).toEqual(["alpha"]);
  });

  it("uses the worst week of multi-week periods", () => {
    const caps: Capacities = { alpha: { "2026-W47": 0 } };
    const plan = computePlan(members, caps, [], periods("2026-W46", 2, 2));
    expect(leaders(plan)).toEqual(["bravo", "alpha"]);
  });

  it("is deterministic", () => {
    const caps: Capacities = { bravo: { "2026-W47": 0 }, delta: { "2026-W48": 2 } };
    const a = computePlan(members, caps, [locked("2026-W45", "charlie")], periods("2026-W46", 8));
    const b = computePlan([...members].reverse(), caps, [locked("2026-W45", "charlie")], periods("2026-W46", 8));
    expect(leaders(a)).toEqual(leaders(b));
  });

  it("breaks the last tie by first name, not by username", () => {
    const team: Member[] = [
      { username: "zz-first", displayName: "Anna Zed" },
      { username: "aa-second", displayName: "Bea Ash" },
      { username: "mm-third", displayName: "Cara Moss" },
    ];
    expect(leaders(computePlan(team, {}, [], periods("2026-W46", 3)))).toEqual(["zz-first", "aa-second", "mm-third"]);
  });

  it("weighs two-week periods double", () => {
    const history: HistoryEntry[] = [{ ...locked("2026-W44", "bravo"), weeks: 2 }, locked("2026-W46", "alpha")];
    // alpha: 1 week, bravo: 2 weeks; the others 0, then alpha before bravo
    const plan = computePlan(members, {}, history, periods("2026-W47", 4));
    expect(leaders(plan)).toEqual(["charlie", "delta", "echo", "alpha"]);
  });

  it("explains each pick", () => {
    const caps: Capacities = { delta: { "2026-W49": 2 } };
    const history = [locked("2026-W44", "alpha"), locked("2026-W45", "bravo")];
    const plan = computePlan(members, caps, history, periods("2026-W46", 4));
    expect(plan.map((p) => [p.leader, p.reason])).toEqual([
      ["charlie", "alphabetical"], // charlie, delta, echo: 0 weeks, never led, same room
      ["delta", "alphabetical"],
      ["echo", "fewest-weeks"],
      ["delta", "more-room"],
    ]);
    const only = computePlan(members, { alpha: { "2026-W46": 0 }, bravo: { "2026-W46": 0 }, charlie: { "2026-W46": 0 }, delta: { "2026-W46": 0 } }, [], periods("2026-W46", 1));
    expect(only[0]).toMatchObject({ leader: "echo", reason: "only-available" });
    expect(computePlan(members, {}, history, periods("2026-W44", 1))[0]).toMatchObject({ reason: "fixed", leaderWeeks: 0 });
  });
});

describe("buildPeriods", () => {
  it("builds a two-week first period, then weekly periods until the season end", () => {
    const season = buildPeriods(
      [
        { from: "2026-W46", periodWeeks: 1 },
        { from: "2026-W44", periodWeeks: 2 },
      ],
      "2027-W05",
    );
    expect(season[0]).toEqual({ week: "2026-W44", weeks: ["2026-W44", "2026-W45"] });
    expect(season[1]).toEqual({ week: "2026-W46", weeks: ["2026-W46"] });
    expect(season.at(-1)).toEqual({ week: "2027-W05", weeks: ["2027-W05"] });
    expect(season.length).toBe(1 + 13); // W46..W53 (2026 has 53 weeks) + W01..W05
  });

  it("switches to two-week periods later and never crosses a border", () => {
    const season = buildPeriods(
      [
        { from: "2026-W46", periodWeeks: 1 },
        { from: "2026-W50", periodWeeks: 2 },
      ],
      "2027-W02",
    );
    expect(season.map((p) => p.weeks.join("+"))).toEqual([
      "2026-W46",
      "2026-W47",
      "2026-W48",
      "2026-W49",
      "2026-W50+2026-W51",
      "2026-W52+2026-W53",
      "2027-W01+2027-W02",
    ]);
    // the season end cuts the last period short
    expect(buildPeriods([{ from: "2026-W46", periodWeeks: 2 }], "2026-W48").at(-1)?.weeks).toEqual(["2026-W48"]);
  });
});

describe("weeks", () => {
  it("computes ISO week keys across year boundaries", () => {
    expect(weekKeyOf(new Date("2026-11-09T00:00:00Z"))).toBe("2026-W46");
    expect(weekKeyOf(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
    expect(weekKeyOf(new Date("2027-01-04T00:00:00Z"))).toBe("2027-W01");
    expect(mondayOf("2026-W53").toISOString().slice(0, 10)).toBe("2026-12-28");
    expect(addWeeks("2026-W52", 2)).toBe("2027-W01");
  });

  it("validates week keys", () => {
    expect(isWeekKey("2026-W46")).toBe(true);
    expect(isWeekKey("2026-W54")).toBe(false);
    expect(isWeekKey("2027-W53")).toBe(false);
    expect(isWeekKey("2026-W4")).toBe(false);
  });

  it("finds the period containing a week", () => {
    const season = buildPeriods([{ from: "2026-W44", periodWeeks: 2 }], "2026-W49");
    expect(periodContaining(season, "2026-W47")?.week).toBe("2026-W46");
    expect(periodContaining(season, "2026-W50")).toBeUndefined();
  });

  it("uses the Berlin calendar day (Monday 00:05 local is still Sunday in UTC)", () => {
    // winter time: 00:05 CET = 23:05 UTC the day before
    expect(weekKeyOf(berlinToday(new Date("2026-11-08T23:05:00Z")))).toBe("2026-W46");
    expect(weekKeyOf(berlinToday(new Date("2026-11-08T22:05:00Z")))).toBe("2026-W45");
    // summer time: 00:05 CEST = 22:05 UTC the day before
    expect(weekKeyOf(berlinToday(new Date("2026-06-07T22:05:00Z")))).toBe("2026-W24");
  });
});
