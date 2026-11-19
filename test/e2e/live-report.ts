// The live dry run's text report (.github/workflows/live.yml): what the
// signed-in page says about its own data, for agents that never see it.
// The browser test (test/browser/app.spec.ts) collects each view's
// diagnostics (diagnosticTexts), and post-live-report.ts puts the report on
// a tracking issue in this public repository. The token reads private data,
// so the report is deny by default: it reads only the app's own note and
// warning elements outside rows, whose titles, asks and notes are private;
// it holds only the matches of STATUS_PHRASES, which are the app's own fixed
// wording and counts of at most MAX_COUNT_DIGITS digits, never the text
// around them; and it counts problems rather than quoting their messages.

/** Digits a count in a status phrase may have; a longer number is no count of the app's and is dropped. */
export const MAX_COUNT_DIGITS = 4;

// A count in the published note's list (src/github/inbox.ts publishedNote), right after its "(" or ", ".
const count = `(?<=\\(|, )\\d{1,${MAX_COUNT_DIGITS}}`;

/** The sources the freshness line names (readSource callers and runs; src/github/homeview.ts fillState). */
const SOURCES = ["board", "decisions", "forge", "heartbeat", "holds", "otherPrs", "people", "queue", "runs", "status", "usage"];

/** The app's notes for empty, missing, unavailable, stale or cut-short panels; fixed text and bounded counts only. */
export const STATUS_PHRASES: readonly RegExp[] = [
  ...[
    "Capacity", "Context", "Detail", "Dispatchable work", "Last pass", "Maintainer report",
    "Pass view", "Pool pace", "Today", "Work in flight",
  ].map((what) => new RegExp(`\\b${what} not published`)),
  ...[
    "Changes", "Dispatchable work", "Epics", "Pass publication", "Pass view", "ready total", "Starts", "Status",
    "Today publication", "Today", "Tracker labels",
  ].map((what) => new RegExp(`\\b${what} unavailable`)),
  ...SOURCES.map((name) => new RegExp(`(?<=^|· )${name}: (?:unavailable|cached)\\b`)),
  /^Publication unavailable/,
  /\bCouldn't read the pass's snapshot/,
  /\bshown from this browser's cache/,
  /\bmarked unavailable until it can be read again/,
  /\bThe pass has not confirmed it for over an hour/,
  /\bIncomplete(?=: | \()/,
  /\bNot every summary was read/,
  /\bHolds, review waits, proposals and digest asks are not listed/,
  /\bPass view (?:stale|incomplete)\b/,
  /\bPass view not in the pass.s snapshot\b/,
  /— stale\b(?:: the pass may have stopped, or failed to publish)?/,
  /\bstale \(over (?:an hour|two hours|a day old)\)/,
  /\bprevious UTC day, not today's activity/,
  /\bstale reading\b/,
  /\bnot read whole, so what is missing is unknown/,
  /\bclock is in the future(?:; current state unknown)?/,
  /\bNone listed: unknown/,
  /\bNot published: agent-board's holds\.passes is off/,
  new RegExp(`${count} past the pass's cap`),
  new RegExp(`${count} unreadable here`),
];

/** The app's note and warning elements, and the rows (ROW_CLASS in src/github/view.ts) whose text stays out. */
export const DIAGNOSTICS = { notes: ".note, .warn, .pass-flag", rows: ".row" } as const;

/**
 * The visible text of each diagnostic element under `root`, outside rows.
 * Self-contained, so the browser test runs it with page.evaluate.
 */
export function diagnosticTexts({ notes, rows }: { notes: string; rows: string }, root: ParentNode = document.body): string[] {
  return [...root.querySelectorAll(notes)].filter((e) => !e.closest(rows) && (e.checkVisibility?.() ?? true)).map((e) => e.textContent ?? "");
}

export interface ViewReport {
  view: string;
  /** The page's diagnostics (diagnosticTexts), in document order. */
  texts: string[];
}

/** What went wrong, counted; messages may quote private data, so they stay out. */
export interface Problems {
  console: number;
  uncaught: number;
  refusedWrites: number;
  unexpectedRequests: number;
  /** Where the test failed (spec file and line), or null if it passed. */
  failedAt: string | null;
}

/** The status phrases on a view, each once with how many text nodes show it. */
export function statusLines(texts: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const t of texts) {
    const text = t.replace(/\s+/g, " ");
    for (const p of STATUS_PHRASES) {
      const m = p.exec(text)?.[0];
      if (m) counts.set(m, (counts.get(m) ?? 0) + 1);
    }
  }
  return [...counts].map(([line, n]) => (n > 1 ? `${line} (×${n})` : line));
}

/** Counts the browser test's problem messages by their prefix. */
export function countProblems(messages: readonly string[], failedAt: string | null): Problems {
  const n = (prefix: string) => messages.filter((m) => m.startsWith(prefix)).length;
  return { console: n("console:"), uncaught: n("uncaught:"), refusedWrites: n("refused write:"), unexpectedRequests: n("unexpected request:"), failedAt };
}

/** One project's report (desktop or phone) as Markdown. */
export function liveReport(project: string, views: readonly ViewReport[], p: Problems): string {
  const out = [`## ${project}`, ""];
  for (const v of views) {
    const lines = statusLines(v.texts);
    out.push(`### ${v.view}`, "", ...(lines.length ? lines.map((l) => `- ${l}`) : ["None of the known unpublished, unavailable or stale notes."]), "");
  }
  out.push("### Problems", "",
    `- ${p.failedAt ? `Failed at ${p.failedAt}` : "Passed"}`,
    `- Console errors: ${p.console}; uncaught exceptions: ${p.uncaught}; refused writes: ${p.refusedWrites}; unexpected requests: ${p.unexpectedRequests}`,
    "");
  return out.join("\n");
}

/** The tracking issue's body: a header, then the projects' reports. */
export function issueBody(reports: readonly string[], runUrl: string, now: Date): string {
  return `Live dry run of the browser test, ${now.toISOString()}: ${runUrl}

Rewritten by each run of .github/workflows/live.yml; edits here are lost. Run \`REVIEW_LIVE_TOKEN=… npm run test:browser\` locally for the messages and screenshots, which stay private.

${reports.join("\n")}`;
}
