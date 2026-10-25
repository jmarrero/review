import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import { humanAsk, loadPeople, markPeopleDone, PEOPLE_QUERY, PEOPLE_RECENT_DAYS, type PeopleEvent, type PeopleNotification, type PeopleSubject } from "../src/github/people.ts";
import type { Recorded, Scripted } from "./helpers.ts";

const data = JSON.parse(readFileSync(new URL("fixtures/people.json", import.meta.url), "utf8")) as { search: PeopleSubject[]; notifications: PeopleNotification[]; timelines: Record<string, PeopleEvent[]> };
const now = Date.parse("2026-10-04T00:00:00Z");

function client(options: { notificationsStatus?: number; searchStatus?: number; failedThread?: number; failedTimeline?: number; failedCI?: boolean; truncatedCI?: boolean; notifications?: PeopleNotification[]; paginated?: boolean; threads?: Record<number, { subject: Partial<PeopleSubject>; timeline: PeopleEvent[] }> } = {}) {
  const calls: Recorded[] = [];
  const route = (method: string, url: string): Scripted | undefined => {
    const path = new URL(url).pathname;
    // GitHub answers "mark a thread as read" with 205 and no body.
    if (method === "PATCH") return { status: 205 };
    if (path === "/search/issues") return options.searchStatus ? { status: options.searchStatus } : { body: { items: data.search } };
    if (path === "/notifications") {
      if (options.notificationsStatus) return { status: options.notificationsStatus, body: { message: "notifications denied" } };
      const notifications = options.notifications ?? data.notifications;
      if (options.paginated) return new URL(url).searchParams.has("page") ? { body: notifications.slice(1) } : { body: notifications.slice(0, 1), headers: { link: '<https://api.github.com/notifications?page=2>; rel="next"' } };
      return { body: notifications };
    }
    const timeline = /\/issues\/(\d+)\/timeline$/.exec(path);
    if (timeline) return Number(timeline[1]) === options.failedTimeline ? { status: 403 } : { body: options.threads?.[Number(timeline[1])]?.timeline ?? data.timelines[timeline[1]!] ?? [] };
    const issue = /\/issues\/(\d+)$/.exec(path);
    if (issue) {
      const n = Number(issue[1]);
      if (n === options.failedThread) return { status: 404 };
      const thread = options.threads?.[n];
      if (thread) return { body: { number: n, title: `Thread ${n}`, ...thread.subject } };
      return { body: data.search.find((s) => s.number === n) ?? { number: n, title: `Thread ${n}`, user: { login: "jmarrero-bot", type: "User" }, ...(n === 12 ? { pull_request: {} } : {}) } };
    }
    if (/\/pulls\/\d+$/.test(path)) return { body: { head: { sha: "abc" } } };
    if (path.endsWith("/check-runs")) return options.failedCI ? { status: 403 } : { body: { total_count: options.truncatedCI ? 101 : 1, check_runs: [{ name: "test", status: "completed", conclusion: "success" }] } };
    if (path.endsWith("/status")) return { body: { statuses: [] } };
    return undefined;
  };
  // Keep model fixtures runnable with Node alone; no DOM or real fetch needed.
  const gh = new GitHub(async () => "fixture-only", async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, headers: {}, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const response = route(method, url);
    assert.ok(response, `unexpected fixture request: ${method} ${url}`);
    const status = response.status ?? 200;
    return new Response(status === 204 || status === 205 ? null : JSON.stringify(response.body ?? {}), { status, headers: { "content-type": "application/json", ...response.headers } });
  });
  return { gh, calls };
}

describe("From people loader", () => {
  it("merges human review search with recent participating asks, excluding bot-only and unknown activity", async () => {
    const { gh, calls } = client();
    const people = await loadPeople(gh, now);
    assert.deepEqual(people.rows.map((r) => r.key), ["upstream/widget#1", "upstream/widget#12", "upstream/widget#6"]);
    assert.deepEqual(people.rows.map((r) => r.action), ["Review", "Review", "Reply"]);
    assert.deepEqual(people.rows.map((r) => r.ci), ["success", "success", "n/a"]);
    assert.deepEqual(people.rows[0]?.notificationIds, ["101"]);
    assert.equal(people.rows[0]?.requestedAt, "2026-10-02T00:00:00Z");
    assert.equal(people.rows[2]?.author, "jmarrero-bot", "a bot-authored thread with a human ask still counts");
    assert.deepEqual(people.warnings, []);
    const search = new URL(calls.find((c) => c.url.includes("/search/issues"))!.url);
    assert.equal(search.searchParams.get("q"), PEOPLE_QUERY);
    const notifications = new URL(calls.find((c) => new URL(c.url).pathname === "/notifications")!.url);
    assert.equal(notifications.searchParams.get("participating"), "true");
    assert.equal(notifications.searchParams.get("all"), "false");
    assert.equal(notifications.searchParams.get("since"), new Date(now - PEOPLE_RECENT_DAYS * 86_400_000).toISOString());
    assert.equal(calls.filter((c) => c.url.includes("/issues/1/timeline")).length, 1);
    assert.ok(!calls.some((c) => /\/issues\/(8|11)(?:\/|$)/.test(new URL(c.url).pathname)));
  });

  for (const status of [403, 404, 500]) it(`retains search when notifications fail with ${status}`, async () => {
    const { gh } = client({ notificationsStatus: status });
    const people = await loadPeople(gh, now);
    assert.deepEqual(people.rows.map((r) => r.key), ["upstream/widget#1"]);
    assert.match(people.warnings.join(" "), /Notifications unavailable/);
  });

  it("keeps other rows after an inaccessible thread and keeps unknown ages/CI honest", async () => {
    const { gh } = client({ failedThread: 6, failedTimeline: 1, failedCI: true });
    const people = await loadPeople(gh, now);
    assert.deepEqual(people.rows.map((r) => r.key), ["upstream/widget#1", "upstream/widget#12"]);
    assert.equal(people.rows[0]?.requestedAt, undefined);
    assert.equal(people.rows[0]?.ci, "unknown");
    assert.match(people.warnings.join(" "), /Request age unavailable/);
    assert.match(people.warnings.join(" "), /Notification 106 unavailable/);
  });

  it("doesn't read another signed-in viewer's notifications", async () => {
    const { gh, calls } = client();
    assert.equal((await loadPeople(gh, now, false)).rows.length, 1);
    assert.ok(!calls.some((c) => new URL(c.url).pathname === "/notifications"));
  });

  it("follows notification pagination and retains notifications when search fails", async () => {
    const { gh, calls } = client({ paginated: true, searchStatus: 500 });
    const people = await loadPeople(gh, now);
    assert.deepEqual(people.rows.map((r) => r.key), ["upstream/widget#12", "upstream/widget#1", "upstream/widget#6"]);
    assert.match(people.warnings.join(" "), /Review-request search unavailable/);
    assert.equal(calls.filter((c) => new URL(c.url).pathname === "/notifications").length, 2);
  });

  it("excludes read, invalid, future, stale-event and foreign notification subjects", async () => {
    const base = data.notifications[1]!;
    const notifications = [
      { ...base, unread: false }, { ...base, updated_at: "invalid" },
      { ...base, updated_at: "2026-10-05T00:00:00Z" },
      { ...base, subject: { type: "Issue", url: "https://evil.example/repos/upstream/widget/issues/6" } },
      { ...base, repository: { full_name: "other/widget" } },
      { ...base, subject: { type: "Issue", url: "https://api.github.com/repos/upstream/widget/issues/8" } },
    ];
    const { gh } = client({ notifications });
    const people = await loadPeople(gh, now);
    assert.deepEqual(people.rows.map((r) => r.key), ["upstream/widget#1"]);
  });

  it("repeats the notifications URL between polls so it is revalidated, still filtering by the exact cutoff", async () => {
    const seen: { url: string; validator: string | null }[] = [];
    const threads: string[] = [];
    const base = data.notifications[1]!;
    const start = Date.parse("2026-10-06T12:00:00Z");
    // Updated after the floored since= but before the exact 14-day cutoff.
    const stale = { ...base, updated_at: new Date(start - PEOPLE_RECENT_DAYS * 86_400_000 - 3_600_000).toISOString() };
    const gh = new GitHub(async () => "fixture-only", async (url, init) => {
      const path = new URL(url).pathname;
      if (path === "/notifications") {
        const validator = new Headers(init?.headers).get("if-none-match");
        seen.push({ url, validator });
        if (validator === '"n1"') return new Response(null, { status: 304 });
        return new Response(JSON.stringify([stale]), { headers: { "content-type": "application/json", etag: '"n1"' } });
      }
      if (path !== "/search/issues") threads.push(path);
      return new Response(JSON.stringify(path === "/search/issues" ? { items: [] } : []), { headers: { "content-type": "application/json" } });
    });
    assert.deepEqual((await loadPeople(gh, start)).rows, []);
    assert.deepEqual((await loadPeople(gh, start + 60_000)).rows, []);
    assert.equal(seen.length, 2);
    assert.equal(seen[0]!.url, seen[1]!.url);
    assert.equal(new URL(seen[0]!.url).searchParams.get("since"), "2026-09-22T00:00:00.000Z");
    assert.equal(seen[0]!.validator, null);
    assert.equal(seen[1]!.validator, '"n1"');
    assert.deepEqual(threads, [], "the extra day since= fetches is dropped by the exact cutoff before any thread read");
  });

  it("finds mentions in an opening body and inline review comments, and lists unlocated mentions", async () => {
    const alice = { login: "alice", type: "User" };
    const bot = { login: "jmarrero-bot", type: "User" };
    const mention = (n: number): PeopleNotification => ({ ...data.notifications[1]!, id: String(200 + n), subject: { type: "Issue", url: `https://api.github.com/repos/upstream/widget/issues/${n}` } });
    const threads = {
      // The mention is in the issue body; the timeline has no event for it.
      20: { subject: { user: alice, body: "@jmarrero, is this the right approach?", created_at: "2026-10-01T00:00:00Z" }, timeline: [] },
      // An inline review comment is a line-commented event with comments[].
      21: { subject: { user: bot, body: "Automated PR", pull_request: {} }, timeline: [{ event: "line-commented", comments: [{ user: alice, body: "@jmarrero see this line", created_at: "2026-10-02T12:00:00Z" }] }] },
      // Nothing read mentions the operator: listed, not hidden.
      22: { subject: { user: alice, body: "no mention here" }, timeline: [] },
      // Located but from a bot, or before the window: still dropped.
      23: { subject: { user: bot, body: "@jmarrero bot body", created_at: "2026-10-02T00:00:00Z" }, timeline: [] },
      24: { subject: { user: alice, body: "@jmarrero old body", created_at: "2026-09-01T00:00:00Z" }, timeline: [{ event: "line-commented", comments: [{ user: bot, body: "@jmarrero bot line", created_at: "2026-10-02T00:00:00Z" }] }] },
    };
    const { gh } = client({ notifications: [20, 21, 22, 23, 24].map(mention), threads, searchStatus: 500 });
    const people = await loadPeople(gh, now);
    assert.deepEqual(people.rows.map((r) => [r.key, r.requestedAt, r.unlocated, r.notificationIds]), [
      ["upstream/widget#21", "2026-10-02T12:00:00Z", undefined, ["221"]],
      ["upstream/widget#20", "2026-10-01T00:00:00Z", undefined, ["220"]],
      ["upstream/widget#22", undefined, true, ["222"]],
    ]);
    assert.equal(people.rows[2]?.url, "https://github.com/upstream/widget/issues/22");
  });

  it("leaves a truncated CI summary unknown instead of claiming success", async () => {
    const { gh } = client({ truncatedCI: true });
    const people = await loadPeople(gh, now);
    assert.equal(people.rows[0]?.ci, "unknown");
  });

  it("requires exact mentions and operator-targeted human review requests", () => {
    const base = { event: "commented", user: { login: "alice", type: "User" } };
    assert.equal(humanAsk({ ...base, body: "@jmarrero-other" }, "mention"), false);
    assert.equal(humanAsk({ ...base, body: "@JMARRERO hello" }, "mention"), true);
    assert.equal(humanAsk({ event: "review_requested", actor: base.user, requested_reviewer: { login: "other" } }, "review_requested"), false);
    assert.equal(humanAsk({ ...base, event: "committed", body: "@jmarrero" }, "mention"), false);
  });

  it("marks only the notification read and invalidates notification response caches", async () => {
    const { gh, calls } = client();
    await gh.get("/notifications");
    await markPeopleDone(gh, "106");
    assert.equal(calls.at(-1)?.method, "PATCH");
    assert.equal(calls.at(-1)?.url, "https://api.github.com/notifications/threads/106");
    assert.equal(calls.at(-1)?.body, undefined);
    await assert.rejects(gh.cacheOnly().get("/notifications"), /not cached/);
    await assert.rejects(markPeopleDone(gh, "106/other"), /invalid notification/);
  });
});
