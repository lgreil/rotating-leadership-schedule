// Server-side texts. The page has its own dictionary in public/index.html.

export type Lang = "en" | "de";

export function langOf(value: string | null | undefined): Lang {
  return value?.toLowerCase().startsWith("de") ? "de" : "en";
}

export function formatDate(date: Date, lang: Lang): string {
  return date.toLocaleDateString(lang === "de" ? "de-DE" : "en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: lang === "de" ? "2-digit" : "short",
    year: "numeric",
  });
}

const texts = {
  en: {
    remindTitle: "Set your availability",
    remindBody: (week: number, date: string) => `How busy are you in week ${week} (from ${date})? Tap to set 🔴🟡🟢.`,
    announceTitle: (date: string) => `You're team lead from Monday ${date}`,
    announceBody: (week: number) => `Planned for week ${week}. Swaps are possible until it locks on Monday 00:05.`,
    leadTitle: "You're team lead this week",
    leadBody: (week: number, date: string) => `Week ${week}, from ${date}.`,
    testTitle: "Notifications work ✓",
    testBody: "You'll get reminders and lead announcements here.",
    pageSignIn: "Sign in",
    pageBadState: "Sign-in failed (invalid state). Please try again.",
    pageTokenFailed: "Token exchange with GitLab failed.",
    pageUserFailed: "Could not read the GitLab user.",
    pageForbidden: "This GitLab account has no access.",
    pageSignedOut: "Signed out.",
  },
  de: {
    remindTitle: "Verfügbarkeit eintragen",
    remindBody: (week: number, date: string) => `Wie viel Luft hast du in KW ${week} (ab ${date})? Tippen und 🔴🟡🟢 setzen.`,
    announceTitle: (date: string) => `Du bist Teamlead ab Montag ${date}`,
    announceBody: (week: number) => `Geplant für KW ${week}. Tauschen geht, bis Montag 00:05 festgeschrieben wird.`,
    leadTitle: "Du bist diese Woche Teamlead",
    leadBody: (week: number, date: string) => `KW ${week}, ab ${date}.`,
    testTitle: "Benachrichtigungen funktionieren ✓",
    testBody: "Hier kommen Erinnerungen und Lead-Ankündigungen an.",
    pageSignIn: "Anmelden",
    pageBadState: "Anmeldung fehlgeschlagen (ungültiger state). Bitte erneut versuchen.",
    pageTokenFailed: "Token-Austausch mit GitLab fehlgeschlagen.",
    pageUserFailed: "GitLab-Benutzer konnte nicht gelesen werden.",
    pageForbidden: "Kein Zugriff für diesen GitLab-Account.",
    pageSignedOut: "Abgemeldet.",
  },
} as const;

export function t(lang: Lang) {
  return texts[lang];
}
