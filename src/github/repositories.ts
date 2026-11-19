// Read-only poll observations; never authorization for a PR action.
import { h } from "../dom.ts";
import { isBot } from "./authors.ts";
import { USAGE_ISSUE, USAGE_REPO } from "./config.ts";
import { isObject, type RawComment } from "./heartbeat.ts";
import { boardNote, boardRepositories, repositoryTable, type BoardPublication } from "./repositoryboard.ts";
import { repositoryChatButton } from "./chatitem.ts";

export const REPORT_SCHEMA = "agent-board/maintainer-report/v1";
const MARKER = "<!-- agent-board-maintainer-report -->";
const STALE_MS = 2 * 60 * 60_000;
// Oversized publisher inventories must not create unbounded work/DOM; addresses
// in publisher prose must not become navigation. No new controls or target reads.
const MAX_RECORDS = 1000;
const text = (v: unknown): v is string => typeof v === "string" && v.length <= 4096;
const repo = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(v) && ![".", ".."].includes(v.split("/")[1]!);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const date = (v: unknown): v is string => typeof v === "string" && v.length <= 64 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v));
const list = (v: unknown, check: (v: unknown) => boolean): boolean => Array.isArray(v) && v.length <= MAX_RECORDS && v.every(check);

interface Pull { repository: string; number: number; head: string; action: string; reason: string; ran: boolean }
interface Need { repository: string; number: number; head: string; kind: string; reason: string }
interface QueueEntry { number: number | null; head: string | null; position: number | null; state: string | null }

export interface MaintainerReport {
  schema: typeof REPORT_SCHEMA;
  generated_at: string;
  mode: "preview" | "apply";
  repositories: string[];
  pull_requests: Record<string, Pull[]>;
  needs_human: Need[];
  undecided_repositories: string[];
  errors: number;
  /** Absent from older producers; null means a repository's queue was unread. */
  merge_queues?: Record<string, QueueEntry[] | null>;
}
export interface ReportBlock { report: MaintainerReport | string; commentUrl?: string }

/** Validate the published docs/maintainer-report.schema.json, ignoring unknown fields.
 * Local bounds limit the producer's otherwise unbounded arrays and strings. */
export function parseMaintainerReport(raw: unknown): MaintainerReport | string {
  const invalid = "Invalid maintainer report: malformed or over its publication bounds.";
  if (!isObject(raw) || raw.schema !== REPORT_SCHEMA || !date(raw.generated_at) || !["preview", "apply"].includes(raw.mode as string)
    || !list(raw.repositories, repo) || new Set(raw.repositories as string[]).size !== (raw.repositories as string[]).length
    || !list(raw.undecided_repositories, repo) || new Set(raw.undecided_repositories as string[]).size !== (raw.undecided_repositories as string[]).length
    || !Number.isSafeInteger(raw.errors) || (raw.errors as number) < 0 || !isObject(raw.pull_requests)) return invalid;
  const member = (v: unknown): boolean => repo(v) && (raw.repositories as string[]).includes(v);
  const pull = (v: unknown): boolean => isObject(v) && member(v.repository) && positive(v.number) && text(v.head) && text(v.action) && text(v.reason) && typeof v.ran === "boolean";
  const groups = Object.entries(raw.pull_requests);
  if (groups.length > 100 || groups.some(([k, v]) => !text(k) || !list(v, pull))
    || groups.reduce((n, [, v]) => n + (v as unknown[]).length, 0) > MAX_RECORDS
    || !(raw.undecided_repositories as string[]).every(member)
    || !list(raw.needs_human, (v) => isObject(v) && member(v.repository) && positive(v.number) && text(v.head) && text(v.kind) && text(v.reason))
    || !list(raw.merge_queue_events, (v) => isObject(v) && member(v.repository) && positive(v.number) && pull(v.step) && isObject(v.event)
      && (v.event.id === null || text(v.event.id)) && (v.event.created_at === null || date(v.event.created_at)) && (v.event.reason === null || text(v.event.reason)))) return invalid;
  if (raw.merge_queues !== undefined) {
    if (!isObject(raw.merge_queues)) return invalid;
    const queues = Object.entries(raw.merge_queues);
    // Bound the total inventory before doing more work; reject ambiguous case variants.
    if (queues.length > MAX_RECORDS || new Set(queues.map(([k]) => k.toLowerCase())).size !== queues.length) return invalid;
    let entries = 0;
    for (const [k, v] of queues) {
      if (!member(k)) return invalid;
      if (v === null) continue;
      if (!Array.isArray(v) || (entries += v.length) > MAX_RECORDS || !v.every((e) => isObject(e)
        && (e.number === null || positive(e.number)) && (e.head === null || text(e.head))
        && (e.position === null || Number.isSafeInteger(e.position)) && (e.state === null || text(e.state)))) return invalid;
    }
  }
  return raw as unknown as MaintainerReport;
}

/** Same bounded configured comment page as the pass view; bot publications only. */
export function findMaintainerReports(comments: readonly RawComment[]): ReportBlock[] {
  return comments.slice(0, 100).flatMap((c) => {
    if (!isBot(c.user?.login) || !c.body?.startsWith(MARKER)) return [];
    const commentUrl = positive(c.id) ? `https://github.com/${USAGE_REPO}/issues/${USAGE_ISSUE}#issuecomment-${c.id}` : undefined;
    const blocks: ReportBlock[] = [];
    if (c.body.length <= 60_000) {
      const fences = c.body.matchAll(/^```agent-board\/maintainer-report\/v1\r?\n([\s\S]*?)\r?\n```[ \t]*\r?$/gm);
      for (const match of fences) {
        let report: MaintainerReport | string;
        try { report = parseMaintainerReport(JSON.parse(match[1]!)); }
        catch { report = "Invalid maintainer report: unreadable JSON."; }
        blocks.push({ report, ...(commentUrl ? { commentUrl } : {}) });
        if (blocks.length === 8) {
          if (fences.next().done !== true) blocks.push({ report: "Invalid maintainer report: more than 8 blocks in one comment.", ...(commentUrl ? { commentUrl } : {}) });
          break;
        }
      }
    }
    return blocks.length ? blocks : [{ report: "Invalid maintainer report: missing block or oversized comment.", ...(commentUrl ? { commentUrl } : {}) }];
  });
}

/** Removals in merge_queue_events are not current queue entries. */
function queueDepth(report: MaintainerReport, repository: string, undecided: boolean): string {
  if (undecided) return "unknown (repository undecided this pass)";
  if (!report.merge_queues) return "unknown (not published by this producer)";
  const queue = Object.entries(report.merge_queues).find(([key]) => key.toLowerCase() === repository)?.[1];
  if (queue === undefined) return "unknown (not published for this repository)";
  return queue === null ? "unknown (queue unread)" : String(queue.length);
}

export function repositoriesView(blocks: readonly ReportBlock[], now = Date.now(), unavailable?: string, board: BoardPublication = {}): HTMLElement {
  const el = h("section", { class: "pass-view repository-board", "aria-label": "Repositories" }, h("h2", {}, "Repositories"),
    h("p", { class: "repository-toolbar" }, "Published work by repository · ", h("a", { href: "https://github.com/jmarrero-forge/tracker/actions/workflows/poll.yml" }, "Run a pass now ↗"), " (opens tracker workflow; no dispatch from this page)"), boardNote(board, now));
  if (unavailable) el.append(h("p", { class: "warn" }, `Publication unavailable: ${unavailable}. Any facts below are last read, not current.`));
  if (!blocks.length) el.append(h("p", { class: "note" }, "Maintainer report not published (off or older producer)."));
  const latest = new Map<string, { report: MaintainerReport; commentUrl?: string }>();
  for (const block of blocks) {
    if (typeof block.report === "string") {
      el.append(h("article", { class: "pass-record warn" }, block.report, block.commentUrl ? h("a", { href: block.commentUrl }, " Report comment") : ""));
      continue;
    }
    for (const repository of block.report.repositories) {
      const prev = latest.get(repository.toLowerCase());
      if (!prev && latest.size >= MAX_RECORDS) {
        el.append(h("article", { class: "pass-record warn" }, "Repository inventory exceeds 1,000 rows; additional repositories not displayed."));
        break;
      }
      if (!prev || Date.parse(prev.report.generated_at) <= Date.parse(block.report.generated_at)) latest.set(repository.toLowerCase(), { report: block.report, ...(block.commentUrl ? { commentUrl: block.commentUrl } : {}) });
    }
  }
  const names = new Set([...latest.keys(), ...boardRepositories(board).map((r) => r.toLowerCase())]);
  for (const repository of [...names].sort()) {
    const row = h("article", { class: "pass-record" }, h("h3", {}, h("a", { href: `https://github.com/${repository}` }, repository), repositoryChatButton(repository)), repositoryTable(repository, board));
    el.append(row);
    const observation = latest.get(repository);
    if (!observation) continue;
    const { report, commentUrl } = observation;
    const age = now - Date.parse(report.generated_at);
    const unread = report.undecided_repositories.some((r) => r.toLowerCase() === repository);
    const states = Object.entries(report.pull_requests).flatMap(([state, pulls]) => {
      const n = pulls.filter((p) => p.repository.toLowerCase() === repository).length;
      return n ? [`${state}: ${n}`] : [];
    });
    const needs = report.needs_human.filter((n) => n.repository.toLowerCase() === repository);
    const details = h("details", {}, h("summary", {}, "Maintainer observations"),
      h("p", { class: age > STALE_MS || age < -60_000 ? "warn" : "note" }, `Last run ${report.generated_at} · ${report.mode}${age > STALE_MS ? " · stale (over two hours)" : age < -60_000 ? " · clock is in the future" : ""}`),
      h("p", {}, `Merge-queue depth: ${queueDepth(report, repository, unread)}.`),
      h("p", {}, `Open PRs by poll state: ${states.join(" · ") || (unread ? "unknown" : "0")}${unread ? " · inventory unread/undecided; listed counts may be incomplete" : ""}`),
      h("p", {}, `Needs you: ${needs.length}${unread ? " listed; coverage unknown" : ""}`),
      h("ul", {}, ...needs.map((n) => h("li", {}, h("a", { href: `https://github.com/${n.repository}/pull/${n.number}` }, `#${n.number}`), ` · ${n.kind}: ${n.reason}`))),
      report.errors ? h("p", { class: "warn" }, `Poll errors: ${report.errors}; observations may be incomplete.`) : "",
      commentUrl ? h("a", { href: commentUrl }, "Report comment") : h("span", { class: "note" }, "Report comment link unavailable"));
    row.append(details);
  }
  return el;
}
