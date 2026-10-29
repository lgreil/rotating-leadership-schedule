import { describe, expect, it } from "vitest";
import { runCron, type Notify } from "./cron";
import type { Lang } from "./i18n";
import type { PushMessage } from "./push";
import type { Store } from "./store";

const config = {
  members: ["alpha", "bravo", "charlie", "delta", "echo"].map((u) => ({ username: u, displayName: u })),
  periodWeeks: 1,
  startWeek: "2026-W46", // Monday 2026-11-09
};

function memoryKv(initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(initial).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  const kv = {
    async get(key: string, type?: string) {
      const v = data.get(key);
      return v === undefined ? null : type === "json" ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      data.set(key, value);
    },
    async delete(key: string) {
      data.delete(key);
    },
  } as unknown as Store;
  return { kv, json: (key: string) => JSON.parse(data.get(key) ?? "null") };
}

function recorder() {
  const sent: { to: string; en: PushMessage; de: PushMessage }[] = [];
  const notify: Notify = async (to, message: (lang: Lang) => PushMessage) => {
    sent.push({ to, en: message("en"), de: message("de") });
  };
  return { sent, notify };
}

// Europe/Berlin is UTC+1 in November
const WED_BEFORE_10 = new Date("2026-11-04T09:05:00Z");
const FRI_BEFORE_15 = new Date("2026-11-06T14:05:00Z");
const MON_0005 = new Date("2026-11-08T23:05:00Z");
const MON_0805 = new Date("2026-11-09T07:05:00Z");

describe("runCron", () => {
  it("locks the running period once, at Monday 00:05 Berlin time", async () => {
    const { kv, json } = memoryKv({ config });
    await runCron(kv, new Date("2026-11-08T22:05:00Z")); // Sunday 23:05 in Berlin
    expect(json("history")).toBeNull();

    await runCron(kv, MON_0005);
    await runCron(kv, MON_0005);
    expect(json("history")).toEqual([{ week: "2026-W46", leader: "alpha", locked: true, override: false, weeks: 1 }]);
  });

  it("locks a pending override instead of computing", async () => {
    const override = { week: "2026-W46", leader: "delta", locked: false, override: true };
    const { kv, json } = memoryKv({ config, history: [override] });
    await runCron(kv, MON_0005);
    expect(json("history")).toEqual([{ ...override, locked: true, weeks: 1 }]);
  });

  it("reminds people without availability on Wednesday, once", async () => {
    const { kv } = memoryKv({ config, "cap:alpha": { "2026-W46": 2 } });
    const { sent, notify } = recorder();
    await runCron(kv, new Date("2026-11-04T08:05:00Z"), notify); // 09:05, too early
    expect(sent).toEqual([]);

    await runCron(kv, WED_BEFORE_10, notify);
    await runCron(kv, WED_BEFORE_10, notify);
    expect(sent.map((s) => s.to)).toEqual(["bravo", "charlie", "delta", "echo"]);
    expect(sent[0].en.body).toContain("week 46");
    expect(sent[0].de.body).toContain("KW 46");
  });

  it("announces the planned lead on Friday and stays quiet on Monday if unchanged", async () => {
    const { kv } = memoryKv({ config });
    const { sent, notify } = recorder();
    await runCron(kv, FRI_BEFORE_15, notify);
    const announcements = sent.filter((s) => s.en.title.startsWith("You're team lead from"));
    expect(announcements.map((s) => s.to)).toEqual(["alpha"]);
    expect(announcements[0].de.title).toBe("Du bist Teamlead ab Montag 09.11.2026");

    sent.length = 0;
    await runCron(kv, MON_0005, notify);
    await runCron(kv, MON_0805, notify);
    expect(sent).toEqual([]);
  });

  it("tells the new lead on Monday morning after a weekend swap", async () => {
    const { kv } = memoryKv({ config });
    const { sent, notify } = recorder();
    await runCron(kv, FRI_BEFORE_15, notify);
    await kv.put("history", JSON.stringify([{ week: "2026-W46", leader: "bravo", locked: false, override: true }]));

    sent.length = 0;
    await runCron(kv, MON_0005, notify); // locked, but nobody is woken at midnight
    expect(sent).toEqual([]);
    await runCron(kv, MON_0805, notify);
    await runCron(kv, MON_0805, notify);
    expect(sent.map((s) => [s.to, s.en.title])).toEqual([["bravo", "You're team lead this week"]]);
  });

  it("handles a two-week first period and stops after the season end", async () => {
    const season = {
      members: config.members,
      cadence: [
        { from: "2026-W44", periodWeeks: 2 },
        { from: "2026-W46", periodWeeks: 1 },
      ],
      seasonEnd: "2027-02-04",
    };
    const { kv, json } = memoryKv({ config: season });
    await runCron(kv, new Date("2026-11-02T08:00:00Z")); // Monday of W45, inside the first period
    expect(json("history")).toEqual([{ week: "2026-W44", leader: "alpha", locked: true, override: false, weeks: 2 }]);

    await kv.delete("history");
    await runCron(kv, new Date("2027-02-08T08:00:00Z")); // W06, after the final presentation
    expect(json("history")).toBeNull();
  });

  it("does nothing without config", async () => {
    const { kv, json } = memoryKv();
    await runCron(kv, MON_0005, recorder().notify);
    expect(json("history")).toBeNull();
  });
});
