import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import { composeReview, composeReviews, refKey, type ForgePr } from "../src/github/forge.ts";
import {
  loadFileLines,
  loadForgePrs,
  loadOtherPrs,
  loadPrDetail,
  loadRangeFiles,
  loadWaiting,
  mapLimit,
  OTHER_QUERY,
  refreshVerdicts,
  REQUESTED_QUERY,
  submitReview,
  type VerdictEntry,
} from "../src/github/prs.ts";
import { fixture, scriptedFetch } from "./helpers.ts";
import { buildNeeds } from "../src/github/needs.ts";
import { buildEntries } from "../src/github/queue.ts";

const token = async () => "t";
const API = "https://api.github.com";
const HEAD = "c".repeat(40);
const MOVED = "d".repeat(40);
const ref = { owner: "jmarrero-forge", repo: "widget", number: 7 };
const PULL = `${API}/repos/jmarrero-forge/widget/pulls/7`;

function pull(over: Record<string, unknown> = {}) {
  return {
    number: 7,
    html_url: "https://github.com/jmarrero-forge/widget/pull/7",
    title: "widget: Fix it",
    body: "Body",
    draft: true,
    state: "open",
    user: { login: "jmarrero-bot" },
    head: { sha: HEAD, ref: "bot/fix" },
    base: { ref: "main" },
    additions: 3,
    deletions: 1,
    changed_files: 1,
    commits: 1,
    ...over,
  };
}

describe("loadForgePrs", () => {
  it("searches the bot's open PRs, page by page, and keeps the forge's drafts", async () => {
    const item = (n: number) => ({ html_url: `https://github.com/jmarrero-forge/r/pull/${n}`, pull_request: {}, title: `#${n}`, draft: true, user: { login: "jmarrero-bot" } });
    const { fetchImpl, calls } = scriptedFetch((_m, url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      if (page === 1) return { body: { total_count: 101, items: Array.from({ length: 100 }, (_, i) => item(i + 1)) } };
      if (page === 2) {
        const upstream = { ...item(102), html_url: "https://github.com/bootc-dev/bootc/pull/102" };
        const ready = { ...item(103), draft: false };
        return { body: { total_count: 104, items: [item(101), upstream, ready, { html_url: "https://github.com/x/y/issues/1" }] } };
      }
      return undefined;
    });
    const prs = await loadForgePrs(new GitHub(token, fetchImpl));
    assert.equal(prs.length, 101);
    assert.equal(calls.length, 2);
    assert.equal(new URL(calls[0]?.url ?? "").searchParams.get("q"), OTHER_QUERY);
  });

  it("reuses a search already made rather than searching again", async () => {
    const { fetchImpl, calls } = scriptedFetch(() => undefined);
    const gh = new GitHub(token, fetchImpl);
    assert.deepEqual(await loadForgePrs(gh, []), []);
    assert.equal(calls.length, 0);
  });
});

describe("the bot's PRs other than the forge's drafts", () => {
  const fix = fixture<{ searches: Record<"other" | "requested", unknown>; routes: Record<string, unknown> }>("waiting-prs.json");
  const github = () =>
    scriptedFetch((method, url) => {
      if (method !== "GET") return undefined;
      const u = new URL(url);
      if (u.pathname === "/search/issues") {
        const q = u.searchParams.get("q");
        return { body: q === OTHER_QUERY ? fix.searches.other : q === REQUESTED_QUERY ? fix.searches.requested : { items: [] } };
      }
      const body = fix.routes[url.replace(API, "")];
      return body === undefined ? undefined : { body };
    });

  it("searches them and those requesting his review, with GitHub's own qualifiers", async () => {
    assert.equal(OTHER_QUERY, "is:pr is:open author:jmarrero-bot");
    // Drafts too: the bot requests his review on forge drafts.
    assert.equal(REQUESTED_QUERY, "is:pr is:open author:jmarrero-bot user-review-requested:jmarrero");
    const { fetchImpl } = github();
    const others = await loadOtherPrs(new GitHub(token, fetchImpl));
    assert.deepEqual(
      others.map((o) => [o.pr.url.replace("https://github.com/", ""), o.requested]),
      [
        ["bootc-dev/bootc/pull/10", false],
        ["bootc-dev/bootc/pull/11", false],
        ["jmarrero-bot/homegit/pull/45", true],
        ["bootc-dev/bcvk/pull/12", false],
        ["coreos/bootupd/pull/13", false],
        ["bootc-dev/bootc/pull/14", false],
        // A PR in the forge's own repository is here; its drafts are loadForgePrs',
        ["jmarrero-forge/workflow-compiler/pull/15", true],
        // except those requesting his review, read here for the request.
        ["jmarrero-forge/bootc/pull/16", true],
      ],
    );
  });

  it("classifies each from GitHub: re-sign, rerun, requested, waiting on the bot, or not listed", async () => {
    const { fetchImpl, calls } = github();
    const gh = new GitHub(token, fetchImpl);
    const { prs, errors } = await loadWaiting(gh, await loadOtherPrs(gh));
    assert.deepEqual(errors, []);
    assert.deepEqual(
      prs.map((w) => [w.pr.title, w.wait.reasons, w.wait.onBot]),
      [
        ["resign", ["resign"], false],
        ["rerun", ["rerun"], false],
        ["requested", ["review-requested"], false],
        ["on the bot", [], true],
        ["forge repo, requested", ["review-requested"], false],
        ["forge draft", ["review-requested"], false],
      ],
    );
    assert.equal(prs.find((w) => w.pr.title === "forge draft")?.wait.askedAt, "2026-10-03T00:00:00Z");
    const [resign, rerun] = prs;
    assert.deepEqual(resign?.wait.unsigned, ["111111111111"]);
    assert.deepEqual([rerun?.wait.failed, rerun?.wait.runs?.map((r) => r.url)], [["required-checks"], ["https://github.com/bootc-dev/bootc/actions/runs/900"]]);
    const paths = calls.map((c) => c.url.replace(API, ""));
    // The bot's own repositories have no DCO or maintainer reruns to read.
    assert.ok(!paths.some((p) => /^\/repos\/jmarrero-(bot|forge)\/[^/]+\/(commits|rules)/.test(p)));
    // Commits are read only where DCO fails, review comments only after a change request.
    assert.deepEqual(paths.filter((p) => p.endsWith("/commits?per_page=100")), ["/repos/bootc-dev/bootc/pulls/10/commits?per_page=100"]);
    assert.deepEqual(paths.filter((p) => /pulls\/\d+\/comments/.test(p)), ["/repos/bootc-dev/bcvk/pulls/12/comments?per_page=100"]);
    // One rules read per repository and branch.
    assert.equal(paths.filter((p) => p === "/repos/bootc-dev/bootc/rules/branches/main?per_page=100").length, 1);
  });

  it("re-reads only check runs and rules for a PR whose updated_at stands", async () => {
    const { fetchImpl, calls } = github();
    const gh = new GitHub(token, fetchImpl);
    const others = await loadOtherPrs(gh);
    const T = Date.parse("2026-10-20T00:00:00Z");
    const first = await loadWaiting(gh, others, new Map(), T);
    const poll = async (known: Parameters<typeof loadWaiting>[2], over = others, now = T + 60_000) => {
      const before = calls.length;
      const got = await loadWaiting(gh, over, known, now);
      return { got, paths: calls.slice(before).map((c) => c.url.replace(API, "")) };
    };
    const uncached = await poll(new Map());
    const cached = await poll(first.reads);
    // 34 requests a poll uncached, 7 cached, for these 8 PRs (the requested
    // forge draft adds its 4 reads, none of them per poll once cached).
    assert.deepEqual([uncached.paths.length, cached.paths.length], [34, 7]);
    assert.ok(cached.paths.every((p) => /\/check-runs\?|\/rules\/branches\//.test(p)), cached.paths.join("\n"));
    const sig = (r: typeof first) => JSON.stringify(r.prs);
    assert.equal(sig(cached.got), sig(uncached.got), "the same standing either way");
    // A PR whose updated_at moved is read again; so is everything after WAITING_REUSE_MS.
    const moved = others.map((o) => (o.pr.title === "requested" ? { ...o, pr: { ...o.pr, updatedAt: "2026-10-01T00:00:00Z" } } : o));
    const one = await poll(cached.got.reads, moved);
    assert.ok(one.paths.includes("/repos/jmarrero-bot/homegit/pulls/45"));
    assert.equal(one.paths.filter((p) => /\/pulls\/\d+$/.test(p)).length, 1);
    const old = await poll(cached.got.reads, others, T + 11 * 60_000);
    assert.equal(old.paths.filter((p) => /\/pulls\/\d+$/.test(p)).length, others.length);
    // A search without updated_at, or mergeability not computed yet, is no reason to trust the last read.
    const unknown = new Map([...first.reads].map(([k, v]) => [k, { ...v, pull: { ...v.pull, mergeable_state: "unknown" } }]));
    assert.equal((await poll(unknown)).paths.filter((p) => /\/pulls\/\d+$/.test(p)).length, others.length);
    const undated = others.map((o) => ({ ...o, pr: { ...o.pr, updatedAt: "" } }));
    assert.equal((await poll(first.reads, undated)).paths.filter((p) => /\/pulls\/\d+$/.test(p)).length, others.length);
  });

  it("reads unreadable rules as none, and fails the PRs on any other rules error", async () => {
    const { fetchImpl } = github();
    const rules = (status: number) => async (url: string, init?: RequestInit) =>
      url.includes("/repos/bootc-dev/bootc/rules/") ? new Response(JSON.stringify({ message: "x" }), { status }) : fetchImpl(url, init);
    const hidden = new GitHub(token, rules(404));
    const none = await loadWaiting(hidden, await loadOtherPrs(hidden));
    assert.deepEqual(none.errors, []);
    assert.ok(!none.prs.some((w) => w.wait.reasons.includes("rerun")));
    const flaky = new GitHub(token, rules(502));
    const failing = await loadWaiting(flaky, await loadOtherPrs(flaky));
    assert.ok(failing.failed.has("bootc-dev/bootc#11"), "the rerun PR keeps its last standing");
  });

  it("offers no rerun of a run in another repository", async () => {
    const { fetchImpl } = github();
    const moved = async (url: string, init?: RequestInit) => {
      const res = await fetchImpl(url, init);
      if (!url.includes("/repos/bootc-dev/bootc/commits/")) return res;
      const text = (await res.text()).replaceAll("https://github.com/bootc-dev/bootc/actions/runs/", "https://github.com/evil/other/actions/runs/");
      return new Response(text, { status: res.status, headers: res.headers });
    };
    const gh = new GitHub(token, moved);
    // Nothing there to rerun from here, so it isn't listed for one.
    const { prs } = await loadWaiting(gh, await loadOtherPrs(gh));
    assert.equal(prs.find((w) => w.pr.title === "rerun"), undefined);
  });

  it("reports a PR it can't read, and keeps the rest", async () => {
    const { fetchImpl } = github();
    const broken = async (url: string, init?: RequestInit) =>
      url.endsWith("/repos/bootc-dev/bootc/pulls/11") ? new Response(JSON.stringify({ message: "Server Error" }), { status: 500 }) : fetchImpl(url, init);
    const gh = new GitHub(token, broken);
    const { prs, errors, failed } = await loadWaiting(gh, await loadOtherPrs(gh));
    assert.deepEqual(prs.map((w) => w.pr.title), ["resign", "requested", "on the bot", "forge repo, requested", "forge draft"]);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /^bootc-dev\/bootc#11: /);
    assert.deepEqual([...failed], ["bootc-dev/bootc#11"]);
  });
});

describe("mapLimit", () => {
  it("keeps order and bounds concurrency", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, n));
      running--;
      return n * 10;
    });
    assert.deepEqual(out, [50, 10, 40, 20, 30]);
    assert.equal(peak, 2);
  });
});

describe("current concrete PR asks", () => {
  const pr: ForgePr = { ref, url: "https://github.com/jmarrero-forge/widget/pull/7", title: "Fix widget", body: "", author: "someone", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", draft: false };
  it("rejects direct requests from human-authored PRs outside the bot search", async () => {
    const { fetchImpl } = scriptedFetch((_m, url) => ({ body: { items: new URL(url).searchParams.get("q") === REQUESTED_QUERY ? [{ html_url: pr.url, pull_request: {}, user: { login: "someone" }, draft: false }] : [] } }));
    const others = await loadOtherPrs(new GitHub(token, fetchImpl));
    assert.deepEqual(others, []);
  });
  for (const c of [
    { name: "unreviewed requested head", review: undefined, draft: false, requested: true, wanted: true },
    { name: "comment-reviewed head", review: { state: "COMMENTED", commit_id: HEAD }, draft: false, requested: true, wanted: false },
    { name: "approved head", review: { state: "APPROVED", commit_id: HEAD }, draft: false, requested: true, wanted: false },
    { name: "reviewed older head", review: { state: "APPROVED", commit_id: MOVED }, draft: false, requested: true, wanted: true },
    // A forge draft is what he reviews to promote; drafts upstream are needs.test's.
    { name: "forge draft, moved since search", review: undefined, draft: true, requested: true, wanted: true },
    { name: "forge draft, approved head", review: { state: "APPROVED", commit_id: HEAD }, draft: true, requested: true, wanted: false },
    { name: "withdrawn request", review: undefined, draft: false, requested: false, wanted: false },
    { name: "closed requested PR", review: undefined, draft: false, requested: true, state: "closed", wanted: false },
    { name: "merged requested PR", review: undefined, draft: false, requested: true, merged_at: "2026-10-02T00:00:00Z", wanted: false },
    { name: "new request since search", review: undefined, draft: false, requested: true, searchRequested: false, wanted: true },
  ]) it(c.name, async () => {
    const askedAt = "2026-10-02T00:00:00Z";
    const { fetchImpl } = scriptedFetch((_m, url) => {
      if (url === PULL) return { body: pull({ draft: c.draft, state: c.state ?? "open", merged_at: c.merged_at, requested_reviewers: c.requested ? [{ login: "jmarrero" }] : [] }) };
      if (url.includes("/reviews?")) return { body: c.review ? [{ ...c.review, user: { login: "jmarrero" }, submitted_at: "2026-10-01T00:00:00Z" }] : [] };
      if (url.includes("/timeline?")) return { body: [{ event: "review_requested", requested_reviewer: { login: "jmarrero" }, created_at: askedAt }] };
      if (url.includes("/comments?")) return { body: [] };
      return undefined;
    });
    const read = await loadWaiting(new GitHub(token, fetchImpl), [{ pr, requested: c.searchRequested ?? true }]);
    assert.deepEqual(read.errors, []);
    const needs = buildNeeds({ entries: buildEntries([], [], new Map(), true, new Set(), { others: read.prs }) });
    assert.equal(needs.length, c.wanted ? 1 : 0);
    if (c.wanted) assert.equal(needs[0]?.since, askedAt, "rank and age use request time, not PR creation");
  });

  for (const policy of ["human-text", "ai-ok"]) it(`retains an approved ${policy} fork without reading promotion attribution`, async () => {
    const body = `<!-- bot-meta -->\n- Upstream: \`upstream/widget\`\n- Contribution policy: \`${policy}\`\n<!-- /bot-meta -->`;
    const { fetchImpl, calls } = scriptedFetch((_method, url) => {
      if (url === PULL) return { body: pull({ body }) };
      if (url.includes("/reviews?")) return { body: [{ state: "APPROVED", commit_id: HEAD, user: { login: "jmarrero" }, submitted_at: "2026-10-01T00:00:00Z" }] };
      if (url.includes("/comments?")) return { body: [] };
      return undefined;
    });
    const read = await loadWaiting(new GitHub(token, fetchImpl), [{ pr: { ...pr, body, author: "jmarrero-bot", draft: true }, requested: false }]);
    assert.deepEqual(read.errors, []);
    const entries = buildEntries([], [], new Map(), true, new Set(), { others: read.prs });
    assert.equal(read.prs.length, 1);
    assert.ok(calls.every((c) => c.method === "GET" && !c.url.includes("/commits?")), "no promotion attribution reads");
    const action = policy === "human-text" ? "write" : "promote";
    assert.deepEqual(buildNeeds({ entries }).map((n) => n.action), [action]);
    const forgeEntries = buildEntries([], [{ ...pr, body, author: "jmarrero-bot", draft: true }], new Map([[refKey(ref), { state: "approved" }]]));
    assert.deepEqual(buildNeeds({ entries: forgeEntries }).map((n) => n.action), [action]);
  });
});

describe("refreshVerdicts", () => {
  const forgePr = (n: number, updatedAt: string): ForgePr => ({
    ref: { owner: "jmarrero-forge", repo: "widget", number: n },
    url: `https://github.com/jmarrero-forge/widget/pull/${n}`,
    title: "",
    body: "",
    author: "jmarrero-bot",
    createdAt: "",
    updatedAt,
    draft: true,
  });

  it("re-reads only PRs that changed, against their current heads", async () => {
    const { fetchImpl, calls } = scriptedFetch((_m, url) => {
      if (url.startsWith(`${API}/repos/jmarrero-forge/widget/pulls?`)) {
        return { body: [pull({ number: 1, head: { sha: HEAD } }), pull({ number: 2, head: { sha: MOVED } })] };
      }
      if (url.startsWith(`${API}/repos/jmarrero-forge/widget/pulls/2/reviews`)) {
        return { body: [{ user: { login: "jmarrero" }, state: "APPROVED", commit_id: HEAD, submitted_at: "2026-01-01T00:00:00Z" }] };
      }
      if (url.startsWith(`${API}/repos/jmarrero-forge/widget/issues/2/comments`)) return { body: [] };
      return undefined;
    });
    const known = new Map<string, VerdictEntry>([
      ["jmarrero-forge/widget#1", { updatedAt: "u1", head: HEAD, verdict: { state: "approved" } }],
      ["jmarrero-forge/widget#3", { updatedAt: "gone", head: HEAD, verdict: { state: "none" } }],
    ]);
    const out = await refreshVerdicts(new GitHub(token, fetchImpl), [forgePr(1, "u1"), forgePr(2, "u2")], known);
    assert.deepEqual([...out.keys()].sort(), ["jmarrero-forge/widget#1", "jmarrero-forge/widget#2"]);
    assert.equal(out.get("jmarrero-forge/widget#1")?.verdict.state, "approved");
    assert.equal(out.get("jmarrero-forge/widget#2")?.verdict.state, "approved-older");
    assert.equal(out.get("jmarrero-forge/widget#2")?.head, MOVED);
    assert.equal(calls.filter((c) => c.url.includes("/reviews")).length, 1);
  });

  it("marks a PR the open list no longer has as undecided", async () => {
    const { fetchImpl } = scriptedFetch((_m, url) => (url.includes("/pulls?") ? { body: [] } : undefined));
    const out = await refreshVerdicts(new GitHub(token, fetchImpl), [forgePr(5, "u")], new Map());
    assert.deepEqual(out.get("jmarrero-forge/widget#5")?.verdict, { state: "none" });
  });

  it("counts a /promote comment", async () => {
    const { fetchImpl } = scriptedFetch((_m, url) => {
      if (url.includes("/pulls?")) return { body: [pull({ number: 6 })] };
      if (url.includes("/pulls/6/reviews")) return { body: [] };
      if (url.includes("/issues/6/comments")) return { body: [{ user: { login: "jmarrero" }, body: "/promote", created_at: "2026-01-01T00:00:00Z" }] };
      return undefined;
    });
    const out = await refreshVerdicts(new GitHub(token, fetchImpl), [forgePr(6, "u")], new Map());
    assert.equal(out.get("jmarrero-forge/widget#6")?.verdict.state, "promoted");
  });

  it("notes whether the bot replied after his change request, inline replies included", async () => {
    const cases: [string, { user: { login: string }; created_at: string }[], boolean][] = [
      ["no reply", [], false],
      ["an inline reply", [{ user: { login: "jmarrero-bot" }, created_at: "2026-01-02T00:00:00Z" }], true],
      ["someone else's", [{ user: { login: "someone" }, created_at: "2026-01-02T00:00:00Z" }], false],
      ["the bot's, before", [{ user: { login: "jmarrero-bot" }, created_at: "2025-12-31T00:00:00Z" }], false],
    ];
    for (const [name, replies, want] of cases) {
      const { fetchImpl } = scriptedFetch((_m, url) => {
        if (url.includes("/pulls?")) return { body: [pull({ number: 8 })] };
        if (url.includes("/pulls/8/reviews")) return { body: [{ user: { login: "jmarrero" }, state: "CHANGES_REQUESTED", commit_id: HEAD, submitted_at: "2026-01-01T00:00:00Z" }] };
        if (url.includes("/issues/8/comments")) return { body: [] };
        if (url.includes("/pulls/8/comments")) return { body: replies };
        return undefined;
      });
      const out = await refreshVerdicts(new GitHub(token, fetchImpl), [forgePr(8, "u")], new Map());
      assert.deepEqual([out.get("jmarrero-forge/widget#8")?.verdict.state, out.get("jmarrero-forge/widget#8")?.botReplied], ["changes-requested", want], name);
    }
  });

  it("makes no requests when nothing changed", async () => {
    const { fetchImpl, calls } = scriptedFetch(() => undefined);
    const known = new Map<string, VerdictEntry>([["jmarrero-forge/widget#1", { updatedAt: "u1", head: HEAD, verdict: { state: "none" } }]]);
    const out = await refreshVerdicts(new GitHub(token, fetchImpl), [forgePr(1, "u1")], known);
    assert.equal(out.size, 1);
    assert.equal(calls.length, 0);
  });
});

describe("loadPrDetail", () => {
  const route = (commitSha: string, commitsTotal = 1) => (method: string, url: string, headers: Record<string, string>) => {
    if (url === PULL) return method === "GET" && headers["If-None-Match"] ? { status: 304 } : { body: pull({ commits: commitsTotal }), headers: { etag: '"p"' } };
    if (url.startsWith(`${PULL}/commits`)) {
      return { body: [{ sha: commitSha, html_url: "https://github.com/c", commit: { message: "widget: Fix it\n\nBecause.", author: { name: "Bot", date: "2026-01-01T00:00:00Z" } }, author: { login: "jmarrero-bot" } }] };
    }
    if (url.startsWith(`${PULL}/files`)) return { body: [] };
    if (url.startsWith(`${PULL}/reviews`) || url.includes("/issues/7/comments")) return { body: [] };
    if (url.includes("/check-runs")) return { body: { check_runs: [] } };
    if (url.endsWith("/status")) return { body: { statuses: [] } };
    if (url === `${API}/repos/jmarrero-forge/widget`) return { body: {} };
    if (method === "POST") return { body: { html_url: "https://github.com/review/2" } };
    return undefined;
  };

  it("flags a commit list that doesn't end at the head", async () => {
    const cases: [string, number, boolean][] = [[HEAD, 1, true], [MOVED, 1, false], [MOVED, 2, false], [MOVED, 300, true]];
    for (const [sha, total, want] of cases) {
      const d = await loadPrDetail(new GitHub(token, scriptedFetch(route(sha, total)).fetchImpl), ref);
      assert.equal(d.consistent, want, `${sha.slice(0, 4)} of ${total}`);
      assert.equal(d.warnings.length, want ? 0 : 1);
    }
  });

  it("reads the head's latest check runs past the first page, as the queue does", async () => {
    const run = (i: number, conclusion = "success") => ({ name: `job ${i}`, status: "completed", conclusion });
    const base = route(HEAD);
    const { fetchImpl, calls } = scriptedFetch((method, url, headers) => {
      if (!url.includes("/check-runs")) return base(method, url, headers);
      const q = new URL(url).searchParams;
      if (q.get("filter") !== "latest") return { body: { total_count: 1, check_runs: [run(0, "failure")] } };
      const page = Number(q.get("page"));
      return { body: { total_count: 150, check_runs: page === 1 ? Array.from({ length: 100 }, (_, i) => run(i)) : page === 2 ? [...Array.from({ length: 49 }, (_, i) => run(100 + i)), run(149, "failure")] : [] } };
    });
    const d = await loadPrDetail(new GitHub(token, fetchImpl), ref);
    assert.equal(d.checks.filter((c) => c.name.startsWith("job ")).length, 150);
    assert.ok(d.checks.some((c) => c.name === "job 149"));
    assert.equal(calls.filter((c) => c.url.includes("/check-runs")).length, 2);
  });

  it("re-reads the PR unconditionally before reviewing, even when cached", async () => {
    const { fetchImpl, calls } = scriptedFetch(route(HEAD));
    const gh = new GitHub(token, fetchImpl);
    await loadPrDetail(gh, ref);
    await submitReview(gh, ref, composeReview("comment", "hi", HEAD));
    const gets = calls.filter((c) => c.url === PULL && c.method === "GET");
    assert.equal(gets.length, 2);
    assert.equal(gets[1]?.headers["If-None-Match"], undefined);
  });

  it("gathers the PR, commits, files, checks and verdict; optional parts only warn", async () => {
    const { fetchImpl } = scriptedFetch((_m, url) => {
      if (url === PULL) return { body: pull() };
      if (url.startsWith(`${PULL}/commits`)) {
        return { body: [{ sha: HEAD, html_url: "https://github.com/c", commit: { message: "widget: Fix it\n\nBecause.", author: { name: "Bot", date: "2026-01-01T00:00:00Z" } }, author: { login: "jmarrero-bot" } }] };
      }
      if (url.includes("/issues/7/comments")) return { body: [] };
      if (url.startsWith(`${PULL}/files`)) return { body: [{ filename: "src/a.rs", status: "modified", additions: 3, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" }] };
      if (url.startsWith(`${PULL}/reviews`)) return { body: [] };
      if (url.includes(`/commits/${HEAD}/check-runs`)) return { status: 403, body: { message: "Resource not accessible" } };
      if (url.endsWith(`/commits/${HEAD}/status`)) return { body: { statuses: [{ context: "DCO", state: "success" }] } };
      if (url === `${API}/repos/jmarrero-forge/widget`) return { body: { private: false, parent: { full_name: "up/widget" } } };
      return undefined;
    });
    const d = await loadPrDetail(new GitHub(token, fetchImpl), ref);
    assert.equal(d.head, HEAD);
    assert.equal(d.parent, "up/widget");
    assert.equal(d.baseRef, "main");
    assert.equal(d.commits[0]?.message, "widget: Fix it\n\nBecause.");
    assert.equal(d.files[0]?.patch, "@@ -1 +1 @@\n-a\n+b");
    assert.deepEqual(d.checks.map((c) => c.name), ["DCO"]);
    assert.equal(d.verdict.state, "none");
    assert.equal(d.warnings.length, 1);
    assert.match(d.warnings[0] ?? "", /check runs.*403/);
  });
});

describe("submitReview", () => {
  const run = async (fresh: Record<string, unknown>) => {
    const { fetchImpl, calls } = scriptedFetch((method, url) => {
      if (method === "GET" && url === PULL) return { body: pull(fresh) };
      if (method === "POST" && url === `${PULL}/reviews`) return { body: { html_url: "https://github.com/review/1" } };
      return undefined;
    });
    const review = composeReview("approve", "", HEAD, { draft: true });
    const result = await submitReview(new GitHub(token, fetchImpl), ref, review).then(
      (url) => ({ url }),
      (e: Error) => ({ error: e.message }),
    );
    return { result, posts: calls.filter((c) => c.method === "POST") };
  };

  it("approves the head he saw", async () => {
    const { result, posts } = await run({});
    assert.deepEqual(result, { url: "https://github.com/review/1" });
    assert.deepEqual(posts[0]?.body, { commit_id: HEAD, event: "APPROVE", body: "/draft" });
  });

  const refusals: [string, Record<string, unknown>, RegExp][] = [
    ["a moved head", { head: { sha: MOVED } }, /head moved to dddddddddddd.*nothing was sent/],
    ["a closed PR", { state: "closed" }, /PR is closed/],
    ["a merged PR", { state: "closed", merged_at: "2026-01-01T00:00:00Z" }, /PR is merged/],
  ];
  for (const [name, fresh, re] of refusals) {
    it(`sends nothing on ${name}`, async () => {
      const { result, posts } = await run(fresh);
      assert.match("error" in result ? result.error : "", re);
      assert.equal(posts.length, 0);
    });
  }
});

describe("loadFileLines and loadRangeFiles", () => {
  it("decodes a file's lines at a commit, path segments escaped", async () => {
    const text = "fn a() {}\r\n// é ✓\n";
    const content = Buffer.from(text, "utf8").toString("base64").replace(/(.{20})/g, "$1\n");
    const { fetchImpl, calls } = scriptedFetch((_m, url) =>
      url.includes("/contents/") ? { body: { type: "file", encoding: "base64", size: text.length, content } } : undefined,
    );
    const lines = await loadFileLines(new GitHub(token, fetchImpl), ref, "src/a b#.rs", HEAD);
    assert.deepEqual(lines, ["fn a() {}", "// é ✓"]);
    assert.equal(calls[0]?.url, `${API}/repos/jmarrero-forge/widget/contents/src/a%20b%23.rs?ref=${HEAD}`);
  });

  it("refuses what it can't show", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ type: "dir" }, /not a file/],
      [{ type: "file", encoding: "none", size: 5_000_000, content: "" }, /too large/],
    ];
    for (const [body, re] of cases) {
      const { fetchImpl } = scriptedFetch(() => ({ body }));
      await assert.rejects(loadFileLines(new GitHub(token, fetchImpl), ref, "x", HEAD), re);
    }
    await assert.rejects(loadFileLines(new GitHub(token, scriptedFetch(() => undefined).fetchImpl), ref, "x", "main"), /not a commit id/);
    await assert.rejects(loadFileLines(new GitHub(token, scriptedFetch(() => undefined).fetchImpl), ref, "a/../../../user", HEAD), /not a repository path/);
    await assert.rejects(loadRangeFiles(new GitHub(token, scriptedFetch(() => undefined).fetchImpl), ref, "main", HEAD), /not a commit range/);
  });

  it("lists a range's files from a compare", async () => {
    const { fetchImpl, calls } = scriptedFetch((_m, url) =>
      url.includes("/compare/") ? { body: { files: [{ filename: "a.rs", sha: "9".repeat(40), status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n a\n+b" }] } } : undefined,
    );
    const files = await loadRangeFiles(new GitHub(token, fetchImpl), ref, MOVED, HEAD);
    assert.deepEqual(files.map((f) => [f.filename, f.sha]), [["a.rs", "9".repeat(40)]]);
    assert.match(calls[0]?.url ?? "", new RegExp(`/compare/${MOVED}\\.\\.\\.${HEAD}`));
  });
});

describe("submitReview with line comments", () => {
  it("posts earlier commits' comments first, then the head's review, and says what went out on failure", async () => {
    const reviews = composeReviews("approve", "", HEAD, {
      comments: [
        { path: "a.rs", line: 2, side: "RIGHT", body: "old", commit: MOVED },
        { path: "a.rs", line: 3, side: "RIGHT", body: "new", commit: HEAD },
      ],
    });
    const run = async (failAt: number) => {
      let n = 0;
      const { fetchImpl, calls } = scriptedFetch((method, url) => {
        if (method === "GET" && url === PULL) return { body: pull() };
        if (method === "POST" && url === `${PULL}/reviews`) return n++ === failAt ? { status: 422, body: { message: "Line could not be resolved" } } : { body: { html_url: `https://github.com/review/${n}` } };
        return undefined;
      });
      const sent: number[] = [];
      const out = await submitReview(new GitHub(token, fetchImpl), ref, reviews, (i) => sent.push(i)).then((u) => u, (e: Error) => e.message);
      return { out, sent, posts: calls.filter((c) => c.method === "POST").map((c) => (c.body as { commit_id: string }).commit_id) };
    };
    assert.deepEqual(await run(-1), { out: "https://github.com/review/2", sent: [0, 1], posts: [MOVED, HEAD] });
    const failed = await run(1);
    assert.deepEqual(failed.sent, [0]);
    assert.match(failed.out, /Line could not be resolved.*the comments on 1 earlier commit went out, the rest didn't/);
    assert.match((await run(0)).out, /nothing was sent/);
  });
});
