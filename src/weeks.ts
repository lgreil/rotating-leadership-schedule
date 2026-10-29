// ISO-8601 week helpers. Week keys look like "2026-W45" and sort lexically.

const DAY = 86_400_000;
const WEEK_RE = /^(\d{4})-W(\d{2})$/;

/** ISO week key of a calendar day (only the UTC date part is used). */
export function weekKeyOf(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow); // Thursday of this week decides the year
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / DAY + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Monday (00:00 UTC) of a week key. */
export function mondayOf(key: string): Date {
  const m = WEEK_RE.exec(key);
  if (!m) throw new Error(`Ungültige Woche: ${key}`);
  const jan4 = Date.UTC(Number(m[1]), 0, 4);
  const jan4Dow = new Date(jan4).getUTCDay() || 7;
  return new Date(jan4 - (jan4Dow - 1) * DAY + (Number(m[2]) - 1) * 7 * DAY);
}

export function isWeekKey(value: unknown): value is string {
  return typeof value === "string" && WEEK_RE.test(value) && weekKeyOf(mondayOf(value)) === value;
}

export function addWeeks(key: string, n: number): string {
  return weekKeyOf(new Date(mondayOf(key).getTime() + n * 7 * DAY));
}

export function weeksBetween(from: string, to: string): number {
  return Math.round((mondayOf(to).getTime() - mondayOf(from).getTime()) / (7 * DAY));
}

/** Today's calendar date in Europe/Berlin, as a UTC-midnight Date. */
export function berlinToday(now: Date): Date {
  return berlinClock(now).day;
}

/** Local date, ISO weekday (1 = Monday) and hour in Europe/Berlin. */
export function berlinClock(now: Date): { day: Date; weekday: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const day = new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
  return { day, weekday: day.getUTCDay() || 7, hour: get("hour") };
}
