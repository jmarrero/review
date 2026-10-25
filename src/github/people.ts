// Human asks come from GitHub search and notifications, never a local inbox.
import type { GitHub } from "./api.ts";
import type { IssueRef } from "./board.ts";
import { BOT_LOGIN, FETCH_CONCURRENCY, OPERATOR } from "./config.ts";
import { ciChecks, ciSummary, type CiState, type RawCheckRun, type RawStatus, refKey } from "./forge.ts";
import { mapLimit } from "./prs.ts";

export const PEOPLE_RECENT_DAYS = 14;
const DAY_MS = 86_400_000;
const SEARCH_PAGES = 10;
export const PEOPLE_QUERY = `is:pr is:open review-requested:${OPERATOR} -author:${BOT_LOGIN}`;

interface Actor {
  login?: string;
  type?: string;
}

export interface PeopleSubject {
  number: number;
  title: string;
  html_url: string;
  user?: Actor | null;
  state?: string;
  pull_request?: unknown;
  head?: { sha: string };
  body?: string | null;
  created_at?: string;
}

export interface PeopleEvent {
  event?: string;
  actor?: Actor | null;
  user?: Actor | null;
  requested_reviewer?: Actor | null;
  created_at?: string;
  submitted_at?: string;
  body?: string | null;
  /** Inline review comments of a `line-commented` event. */
  comments?: PeopleEvent[];
}

export interface PeopleNotification {
  id: string;
  unread: boolean;
  reason: string;
  updated_at: string;
  repository: { full_name: string };
  subject: { type: string; url: string | null };
}

export interface PersonAsk {
  key: string;
  ref: IssueRef;
  title: string;
  url: string;
  author: string;
  action: "Review" | "Reply";
  requestedAt?: string;
  ci: CiState | "unknown" | "n/a";
  notificationIds: string[];
  reviewRequested: boolean;
  /** A mention notification whose mention wasn't found in the text read. */
  unlocated?: boolean;
  /** In-flight UI action only; never persisted. */
  marking?: boolean;
  markError?: string;
}

export interface People {
  rows: PersonAsk[];
  warnings: string[];
}

/** Only an explicit GitHub human account counts; missing types aren't evidence. */
export function isHuman(actor: Actor | null | undefined): boolean {
  const login = actor?.login?.toLowerCase();
  return actor?.type === "User" && !!login && login !== BOT_LOGIN.toLowerCase() && !login.endsWith("[bot]");
}

function eventTime(event: PeopleEvent): string | undefined {
  return event.submitted_at ?? event.created_at;
}

/** Whitelist substantive events; commits, labels and automation aren't human asks. */
export function humanAsk(event: PeopleEvent, reason: string): boolean {
  const actor = event.actor ?? event.user;
  if (!isHuman(actor) || actor?.login?.toLowerCase() === OPERATOR.toLowerCase()) return false;
  if (reason === "review_requested") return event.event === "review_requested" && event.requested_reviewer?.login?.toLowerCase() === OPERATOR.toLowerCase();
  return reason === "mention" && (event.event === "commented" || event.event === "reviewed") && mentionsOperator(event);
}

function mentionsOperator(event: PeopleEvent): boolean {
  return new RegExp(`(^|[^\\w])@${OPERATOR}(?![\\w-])`, "i").test(event.body ?? "");
}

/**
 * Everything a mention can be written in: the timeline's comments and
 * reviews, each inline review comment of a `line-commented` event, and the
 * opening body of the issue or PR, which has no timeline event of its own.
 * Inline comments and the body are judged as comments by their author.
 */
export function mentionSources(subject: PeopleSubject, events: PeopleEvent[]): PeopleEvent[] {
  const inline = events.flatMap((e) => e.event === "line-commented" ? (e.comments ?? []).map((c): PeopleEvent => ({ ...c, event: "commented" })) : []);
  const opening: PeopleEvent = { event: "commented", user: subject.user ?? null, body: subject.body ?? null };
  if (subject.created_at) opening.created_at = subject.created_at;
  return [...events, ...inline, opening];
}

function subjectRef(url: string | null): IssueRef | undefined {
  const match = /^https:\/\/api\.github\.com\/repos\/([\w.-]+)\/([\w.-]+)\/(?:issues|pulls)\/(\d+)$/.exec(url ?? "");
  return match ? { owner: match[1]!, repo: match[2]!, number: Number(match[3]) } : undefined;
}

const issuePath = (ref: IssueRef) => `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`;
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

export async function loadPeople(gh: GitHub, now = Date.now(), notifications = true): Promise<People> {
  const result: People = { rows: [], warnings: [] };
  const cutoff = now - PEOPLE_RECENT_DAYS * DAY_MS;
  const byKey = new Map<string, PersonAsk>();
  const timelines = new Map<string, Promise<PeopleEvent[]>>();
  const timeline = (ref: IssueRef) => {
    const key = refKey(ref).toLowerCase();
    let read = timelines.get(key);
    if (!read) {
      read = gh.getAll<PeopleEvent>(`${issuePath(ref)}/timeline?per_page=100`).then((r) => r.data);
      timelines.set(key, read);
    }
    return read;
  };
  const makeRow = (ref: IssueRef, subject: PeopleSubject, reviewRequested: boolean): PersonAsk => ({
    key: refKey(ref).toLowerCase(), ref, title: subject.title, url: `https://github.com/${ref.owner}/${ref.repo}/${subject.pull_request || subject.head ? "pull" : "issues"}/${ref.number}`,
    author: subject.user?.login ?? "unknown", action: reviewRequested ? "Review" : "Reply", ci: subject.pull_request || subject.head ? "unknown" : "n/a", notificationIds: [], reviewRequested,
  });
  const search = async () => {
    const subjects: PeopleSubject[] = [];
    for (let page = 1; page <= SEARCH_PAGES; page++) {
      const { data } = await gh.get<{ items: PeopleSubject[]; incomplete_results?: boolean }>(`/search/issues?q=${encodeURIComponent(PEOPLE_QUERY)}&sort=updated&order=desc&per_page=100&page=${page}`);
      subjects.push(...data.items);
      if (data.incomplete_results) result.warnings.push("GitHub review-request search is incomplete.");
      if (data.items.length < 100) break;
      if (page === SEARCH_PAGES) result.warnings.push("Review-request search reached GitHub's 1,000-result limit.");
    }
    await mapLimit(subjects, FETCH_CONCURRENCY, async (subject) => {
      const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/.exec(subject.html_url);
      if (!match || subject.state !== "open" || !isHuman(subject.user)) return;
      const ref = { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
      const row = makeRow(ref, subject, true);
      byKey.set(row.key, row);
      try {
        const events = await timeline(ref);
        const request = events.filter((e) => e.event === "review_requested" && e.requested_reviewer?.login?.toLowerCase() === OPERATOR.toLowerCase()).sort((a, b) => (eventTime(b) ?? "").localeCompare(eventTime(a) ?? ""))[0];
        const requestedAt = request && eventTime(request);
        if (requestedAt && Number.isFinite(Date.parse(requestedAt)) && Date.parse(requestedAt) <= now) row.requestedAt = requestedAt;
      } catch (e) {
        result.warnings.push(`Request age unavailable for ${row.key}: ${errorText(e)}`);
      }
    });
  };
  const readNotifications = async () => {
    if (!notifications) return;
    // since= is floored to the UTC day so the URL repeats between polls and
    // the cached entry is revalidated (a free 304) instead of every poll
    // being a new, unconditional request and cache entry. The exact cutoff
    // is applied below; this only fetches up to a day more.
    const since = Math.floor(cutoff / DAY_MS) * DAY_MS;
    const { data } = await gh.getAll<PeopleNotification>(`/notifications?all=false&participating=true&since=${encodeURIComponent(new Date(since).toISOString())}&per_page=100`);
    await mapLimit(data, FETCH_CONCURRENCY, async (notification) => {
      if (!notification.unread || !["mention", "review_requested"].includes(notification.reason) || Date.parse(notification.updated_at) < cutoff || Date.parse(notification.updated_at) > now || !Number.isFinite(Date.parse(notification.updated_at))) return;
      if (!["Issue", "PullRequest"].includes(notification.subject.type)) return;
      const ref = subjectRef(notification.subject.url);
      if (!ref || `${ref.owner}/${ref.repo}`.toLowerCase() !== notification.repository.full_name.toLowerCase()) return;
      try {
        const [subject, events] = await Promise.all([gh.get<PeopleSubject>(issuePath(ref)).then((r) => r.data), timeline(ref)]);
        const mention = notification.reason === "mention";
        const sources = mention ? mentionSources(subject, events) : events;
        const ask = sources.filter((e) => humanAsk(e, notification.reason) && Date.parse(eventTime(e) ?? "") >= cutoff && Date.parse(eventTime(e) ?? "") <= now).sort((a, b) => (eventTime(b) ?? "").localeCompare(eventTime(a) ?? ""))[0];
        // A mention found only from a bot, the operator, an unknown actor or
        // before the window is located and deliberately dropped. One found
        // nowhere (an edited-away mention, or text this doesn't read) is
        // still listed, so its unread notification can be marked done.
        const unlocated = !ask && mention && !sources.some(mentionsOperator);
        if (!ask && !unlocated) return;
        // Merge after both sources finish: notification access can't erase search.
        const row = makeRow(ref, subject, false);
        if (notification.reason === "review_requested") row.action = "Review";
        if (ask) row.requestedAt = eventTime(ask)!;
        else row.unlocated = true;
        row.notificationIds.push(notification.id);
        notificationRows.push(row);
      } catch (e) {
        result.warnings.push(`Notification ${notification.id} unavailable: ${errorText(e)}`);
      }
    });
  };
  const notificationRows: PersonAsk[] = [];
  await Promise.all([
    search().catch((e: unknown) => result.warnings.push(`Review-request search unavailable: ${errorText(e)}`)),
    readNotifications().catch((e: unknown) => result.warnings.push(`Notifications unavailable; review-request search is still shown: ${errorText(e)}`)),
  ]);
  for (const row of notificationRows) {
    const existing = byKey.get(row.key);
    if (!existing) byKey.set(row.key, row);
    else {
      existing.notificationIds = [...new Set([...existing.notificationIds, ...row.notificationIds])];
      if (!row.unlocated) delete existing.unlocated;
      if (!existing.reviewRequested) {
        if (row.action === "Review") existing.action = "Review";
        if ((row.requestedAt ?? "") > (existing.requestedAt ?? "")) existing.requestedAt = row.requestedAt!;
      }
    }
  }
  result.rows = [...byKey.values()].sort((a, b) => Number(b.reviewRequested) - Number(a.reviewRequested) || (b.requestedAt ?? "").localeCompare(a.requestedAt ?? "") || a.key.localeCompare(b.key));
  await mapLimit(result.rows.filter((r) => r.ci === "unknown"), FETCH_CONCURRENCY, async (row) => {
    try {
      const repo = `/repos/${row.ref.owner}/${row.ref.repo}`;
      const pull = (await gh.get<PeopleSubject>(`${repo}/pulls/${row.ref.number}`)).data;
      if (!pull.head?.sha) return;
      const sha = pull.head.sha;
      const [runs, statuses] = await Promise.all([
        gh.get<{ check_runs: RawCheckRun[]; total_count?: number }>(`${repo}/commits/${sha}/check-runs?per_page=100`),
        gh.get<{ statuses: RawStatus[]; total_count?: number }>(`${repo}/commits/${sha}/status?per_page=100`),
      ]);
      if ((runs.data.total_count ?? 0) > runs.data.check_runs.length) return;
      if ((statuses.data.total_count ?? 0) > statuses.data.statuses.length) return;
      row.ci = ciSummary(ciChecks(runs.data.check_runs, statuses.data.statuses));
    } catch {
      // An unreadable CI summary is unknown, never green or no checks.
    }
  });
  return result;
}

/** Mark exactly this notification read; search review requests remain actionable. */
export async function markPeopleDone(gh: GitHub, id: string): Promise<void> {
  if (!/^\d+$/.test(id)) throw new Error("invalid notification thread id");
  const notifications = (url: string) => /^https:\/\/api\.github\.com\/notifications(?:[/?]|$)/.test(url);
  gh.cache.invalidate(notifications);
  try {
    await gh.send("PATCH", `/notifications/threads/${id}`);
  } finally {
    gh.cache.invalidate(notifications);
  }
}
