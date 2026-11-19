// Taking over a forge PR's text: the pure helpers, and saveMine against a
// fake GitHub that keeps commits and a branch in memory, so the tests see
// exactly what would be written and in which order.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import {
  changes,
  editProblems,
  type GitCommit,
  HUMAN_TEXT_LINE,
  identityProblem,
  joinBody,
  hasGeneratedBy,
  LLMS_TRAILER,
  type MineEdit,
  mineRefusal,
  normalizeMessage,
  orderCommits,
  PROMOTE_GAP_MS,
  PUSH_EVENT_TRIES,
  PUSH_EVENT_WAIT_MS,
  saveMine,
  splitBody,
  workflowScopeProblem,
} from "../src/github/mine.ts";
import type { PrDetail } from "../src/github/prs.ts";
import type { Recorded } from "./helpers.ts";

const API = "https://api.github.com";
const REPO = "jmarrero-forge/widget";
const BRANCH = "bot/fix";
const BASE = "0".repeat(40);
const TREE1 = "a".repeat(40);
const TREE2 = "b".repeat(40);
const META = "<!-- bot-meta -->\n---\n\n- Upstream: `up/widget`, base `main`\n- Board item: `PVTI_x`\n<!-- /bot-meta -->";
const BODY = `Fix the widget.\n\n${LLMS_TRAILER}\n\n${META}`;
const ME = { name: "Joseph Marrero Corchado", email: "jmarrero@redhat.com" };
const BOT = { name: "Joseph Marrero Corchado (automation)", email: "jmarrero+bot@gmail.com", date: "2026-09-01T10:00:00Z" };

const sha = (s: string) => createHash("sha1").update(s).digest("hex");

function gitCommit(message: string, tree: string, parent: string): GitCommit {
  const c = { tree: { sha: tree }, parents: [{ sha: parent }], author: BOT, committer: BOT, message };
  return { sha: sha(JSON.stringify(c)), ...c };
}

const C1 = gitCommit("widget: Add a knob\n\nGenerated-by: AI", TREE1, BASE);
const C2 = gitCommit("widget: Use the knob\n\nBecause.\n\nGenerated-by: AI", TREE2, C1.sha);

function detail(over: Partial<PrDetail> = {}): PrDetail {
  return {
    ref: { owner: "jmarrero-forge", repo: "widget", number: 7 },
    url: `https://github.com/${REPO}/pull/7`,
    updatedAt: "2026-09-01T10:00:00Z",
    title: "widget: Use a knob",
    body: BODY,
    author: "jmarrero-bot",
    state: "open",
    draft: true,
    head: C2.sha,
    headRef: BRANCH,
    headRepo: REPO,
    baseRef: "main",
    parent: "up/widget",
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    commitCount: 2,
    commits: [C1, C2].map((c) => ({ sha: c.sha, parent: c.parents[0]?.sha as string, url: "https://github.com/c", message: c.message, author: "jmarrero-bot" })),
    files: [],
    checks: [],
    verdict: { state: "none" },
    guide: { state: "none" },
    consistent: true,
    warnings: [],
    ...over,
  };
}

const edit = (over: Partial<MineEdit> = {}): MineEdit => ({
  title: "widget: Make the knob configurable",
  body: "Mine now.",
  messages: new Map([
    [C1.sha, "widget: Add a knob\n\nMy words."],
    [C2.sha, "widget: Use the knob"],
  ]),
  ...over,
});

interface FakeOpts {
  /** What POST git/commits returns instead of the commit asked for. */
  tamper?: (c: GitCommit) => GitCommit;
  /** The branch moves to this just before the ref update. */
  raceTo?: string;
  pull?: Record<string, unknown>;
  /** Reads of the PR's events before the push shows there; never, if negative. */
  eventAfter?: number;
  /** The comment's created_at. */
  commentAt?: string;
  /** The body becomes this right after the branch moves. */
  bodyAfterPush?: string;
}

const PUSHED_AT = "2026-09-29T12:00:03Z";

/** A GitHub with one PR, its commits, and its branch, in memory. */
function fakeGitHub(opts: FakeOpts = {}) {
  const commits = new Map([C1, C2].map((c) => [c.sha, c]));
  const state = { ref: C2.sha, title: detail().title, body: BODY, comments: [] as string[], eventReads: 0 };
  const calls: Recorded[] = [];
  const route = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const path = url.slice(API.length).split("?")[0] as string;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ method, url, headers: { ...(init?.headers as Record<string, string> | undefined) }, body });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && path === `/repos/${REPO}/pulls/7`) {
      return json({ state: "open", title: state.title, body: state.body, html_url: "https://github.com/p", head: { sha: state.ref, ref: BRANCH, repo: { full_name: REPO } }, ...opts.pull });
    }
    if (method === "GET" && path === `/repos/${REPO}`) return json({ node_id: "R_widget" });
    const got = /^\/repos\/[^/]+\/[^/]+\/git\/commits\/([0-9a-f]{40})$/.exec(path);
    if (method === "GET" && got) {
      const c = commits.get(got[1] as string);
      return c ? json(c) : json({ message: "Not Found" }, 404);
    }
    if (method === "POST" && path === `/repos/${REPO}/git/commits`) {
      const b = body as { message: string; tree: string; parents: string[]; author: typeof BOT; committer: { name: string; email: string } };
      const c = {
        tree: { sha: b.tree },
        parents: b.parents.map((p) => ({ sha: p })),
        author: b.author,
        committer: { ...b.committer, date: "2026-09-29T12:00:00Z" },
        // GitHub returns the message without its final newline.
        message: b.message.trimEnd(),
      };
      let made: GitCommit = { sha: sha(JSON.stringify(c)), ...c };
      if (opts.tamper) made = opts.tamper(made);
      commits.set(made.sha, made);
      return json(made, 201);
    }
    if (method === "POST" && path === "/graphql") {
      if (opts.raceTo) state.ref = opts.raceTo;
      const v = (body as { variables: { ref: string; before: string; after: string } }).variables;
      if (v.ref !== `refs/heads/${BRANCH}` || v.before !== state.ref) return json({ errors: [{ message: "Something went wrong while executing your query." }] });
      state.ref = v.after;
      if (opts.bodyAfterPush !== undefined) state.body = opts.bodyAfterPush;
      return json({ data: { updateRefs: { clientMutationId: null } } });
    }
    if (method === "GET" && path === `/repos/${REPO}/git/ref/heads/${BRANCH}`) return json({ object: { sha: state.ref } });
    if (method === "PATCH" && path === `/repos/${REPO}/pulls/7`) {
      const b = body as { title?: string; body?: string };
      if (b.title !== undefined) state.title = b.title;
      if (b.body !== undefined) state.body = b.body;
      return json({});
    }
    if (method === "GET" && path === `/repos/${REPO}/issues/7/events`) {
      const wait = opts.eventAfter ?? 1;
      const shown = state.ref !== C2.sha && wait >= 0 && state.eventReads++ >= wait;
      const events = [{ event: "renamed", created_at: "2026-09-01T00:00:00Z" }];
      if (shown) events.push({ event: "head_ref_force_pushed", commit_id: state.ref, created_at: PUSHED_AT } as (typeof events)[number]);
      return json(events);
    }
    if (method === "POST" && path === `/repos/${REPO}/issues/7/comments`) {
      state.comments.push((body as { body: string }).body);
      return json({ html_url: "https://github.com/comment", created_at: opts.commentAt ?? "2026-09-29T12:00:05Z" }, 201);
    }
    return json({ message: `unrouted ${method} ${path}` }, 500);
  };
  const gh = new GitHub(async () => "t", route);
  return { gh, calls, commits, state };
}

const writes = (calls: readonly Recorded[]) => calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url.slice(API.length)}`);
const noSleep = async () => {};

describe("text helpers", () => {
  it("finds Generated-by lines", () => {
    const cases: [string, boolean][] = [
      ["Subject\r\n\r\nGenerated-by: AI\r\n", true],
      [`Why.\n\n${LLMS_TRAILER}`, true],
      ["  generated-by: someone", true],
      ["Mentions Generated-by: inline", false],
      ["Mine", false],
    ];
    for (const [text, want] of cases) assert.equal(hasGeneratedBy(text), want, text);
  });

  it("splits the body at bot-meta and joins it back unchanged", () => {
    const parts = splitBody(BODY);
    assert.equal(parts.meta, META);
    assert.equal(parts.text, `Fix the widget.\n\n${LLMS_TRAILER}`);
    assert.equal(joinBody(parts), BODY);
    assert.equal(joinBody({ text: "Mine\r\n", meta: META }), `Mine\n\n${META}`);
    assert.deepEqual(splitBody("No meta\n"), { text: "No meta", meta: "" });
    assert.equal(joinBody({ text: "", meta: META }), META);
  });

  it("normalizes messages to one trailing newline", () => {
    assert.equal(normalizeMessage("a\r\n\r\nb\n\n\n"), "a\n\nb\n");
    assert.equal(normalizeMessage("  \n"), "");
  });

  it("checks identities", () => {
    assert.equal(identityProblem(ME), undefined);
    assert.match(identityProblem({ name: "", email: ME.email }) ?? "", /name is empty/);
    assert.match(identityProblem({ name: "A <b>", email: ME.email }) ?? "", /can't contain/);
    assert.match(identityProblem({ name: "A", email: "nope" }) ?? "", /not an email/);
  });
});

describe("mineRefusal", () => {
  const cases: [string, Partial<PrDetail>, RegExp | undefined][] = [
    ["a forge PR by the bot", {}, undefined],
    ["a closed PR", { state: "closed" }, /is closed/],
    ["a repository that isn't a fork", { parent: "" }, /is not a fork/],
    ["another org", { ref: { owner: "bootc-dev", repo: "widget", number: 7 } }, /only PRs in jmarrero-forge/],
    ["someone else's PR", { author: "someone" }, /only jmarrero-bot's/],
    ["a branch in another repository", { headRepo: "someone/widget" }, /branch is in someone\/widget/],
    ["a non-bot branch", { headRef: "main" }, /not a bot\/ branch/],
    ["no bot-meta", { body: "Plain" }, /no bot-meta/],
    ["a stale commit list", { consistent: false }, /still updating/],
    ["more commits than listed", { commitCount: 300 }, /300 commits/],
  ];
  for (const [what, over, want] of cases) {
    it(what, () => {
      const got = mineRefusal(detail(over));
      if (want) assert.match(got ?? "", want);
      else assert.equal(got, undefined);
    });
  }
});

describe("orderCommits", () => {
  it("orders by parents, oldest first, whatever the listing order", () => {
    assert.deepEqual(orderCommits([C2, C1], C2.sha).map((c) => c.sha), [C1.sha, C2.sha]);
  });
  it("refuses merges and commits off the line", () => {
    const merge = { ...C2, parents: [{ sha: C1.sha }, { sha: BASE }] };
    assert.throws(() => orderCommits([C1, merge], C2.sha), /2 parents/);
    const stray = gitCommit("stray", TREE1, BASE);
    assert.throws(() => orderCommits([C1, C2, stray], C2.sha), /only 2 of the PR's 3/);
  });
});

describe("edit checks", () => {
  it("lists every change, unchanged ones too", () => {
    const list = changes(detail(), edit({ title: detail().title }));
    assert.deepEqual(list.map((c) => [c.what, c.changed]), [
      ["Title", false],
      ["Description", true],
      [`Commit ${C1.sha.slice(0, 10)}`, true],
      [`Commit ${C2.sha.slice(0, 10)}`, true],
    ]);
  });
  it("owns up to whitespace-only body changes", () => {
    // The body's text as is, but with CRLF: saved as LF, so it is written.
    const d = detail({ body: `Mine now.\r\n\r\n${META}` });
    const [, body] = changes(d, edit());
    assert.equal(body?.before, body?.after);
    assert.equal(body?.changed, true);
  });
  it("refuses what promote would", () => {
    const bad = edit({ title: " ", body: `Mine\n${LLMS_TRAILER}`, messages: new Map([[C1.sha, "\n\nno subject"]]) });
    const problems = editProblems(detail(), bad, false);
    // C2 keeps the bot's message, Generated-by and all.
    assert.deepEqual(problems.map((p) => p.replace(/[0-9a-f]{10}/, "C")), [
      "the title is empty",
      "the description still has a Generated-by line: the text must be yours",
      "commit C has no subject line",
      "commit C still has a Generated-by line: the text must be yours",
    ]);
  });
  it("needs a title he set when promoting", () => {
    const same = edit({ title: detail().title });
    assert.deepEqual(editProblems(detail(), same, false), []);
    assert.match(editProblems(detail(), same, true).join(), /title is the bot's/);
  });
  it("needs the workflow scope for workflow changes, when the scopes are known", () => {
    const wf = detail({ files: [{ filename: ".github/workflows/ci.yml", status: "modified", additions: 1, deletions: 0 }] });
    assert.match(workflowScopeProblem(wf, "public_repo, read:project") ?? "", /workflow scope/);
    assert.equal(workflowScopeProblem(wf, "public_repo, workflow"), undefined);
    assert.equal(workflowScopeProblem(wf, undefined), undefined);
    assert.equal(workflowScopeProblem(detail(), "public_repo"), undefined);
  });
});

describe("saveMine", () => {
  it("rewrites the commits on the same trees, moves the branch by CAS, sets the text, then comments", async () => {
    const f = fakeGitHub();
    const slept: number[] = [];
    const steps: string[] = [];
    const r = await saveMine(f.gh, detail(), edit(), {
      committer: ME,
      ownText: true,
      promote: true,
      progress: (s) => steps.push(s),
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    assert.deepEqual(writes(f.calls), [
      `POST /repos/${REPO}/git/commits`,
      `POST /repos/${REPO}/git/commits`,
      "POST /graphql",
      `PATCH /repos/${REPO}/pulls/7`,
      `POST /repos/${REPO}/issues/7/comments`,
    ]);
    // The comment waited for the push to show on the PR: two reads of its events.
    assert.equal(f.calls.filter((c) => c.url.includes("/issues/7/events")).length, 2);
    const [n1, n2] = f.calls.filter((c) => c.url.endsWith("/git/commits")).map((c) => c.body as Record<string, unknown>);
    assert.deepEqual(n1, { message: "widget: Add a knob\n\nMy words.\n", tree: TREE1, parents: [BASE], author: BOT, committer: ME });
    assert.equal((n2 as { tree: string }).tree, TREE2);
    const new1 = [...f.commits.values()].find((c) => c.message === "widget: Add a knob\n\nMy words.");
    assert.deepEqual((n2 as { parents: string[] }).parents, [new1?.sha]);
    // The branch moved from exactly the head he saw.
    const gql = f.calls.find((c) => c.url.endsWith("/graphql"))?.body as { query: string; variables: Record<string, string> };
    assert.match(gql.query, /updateRefs/);
    assert.deepEqual(gql.variables, { repo: "R_widget", ref: `refs/heads/${BRANCH}`, before: C2.sha, after: r.head });
    assert.equal(f.state.ref, r.head);
    assert.equal(f.commits.get(r.head)?.committer.name, ME.name);
    // The bot-meta section is kept byte for byte.
    assert.equal(f.state.title, "widget: Make the knob configurable");
    assert.equal(f.state.body, `Mine now.\n\n${META}`);
    assert.deepEqual(f.state.comments, [HUMAN_TEXT_LINE]);
    assert.equal(r.commentUrl, "https://github.com/comment");
    assert.ok(r.titleSet && r.bodySet);
    assert.deepEqual(slept, [PUSH_EVENT_WAIT_MS, PROMOTE_GAP_MS]);
    assert.equal(steps.length, 7);
  });

  it("leaves an unchanged title alone and can skip the comment", async () => {
    const f = fakeGitHub();
    const r = await saveMine(f.gh, detail(), edit({ title: detail().title }), { committer: ME, ownText: true, promote: false, sleep: noSleep });
    const patch = f.calls.find((c) => c.method === "PATCH")?.body;
    assert.deepEqual(patch, { body: `Mine now.\n\n${META}` });
    assert.equal(r.titleSet, false);
    assert.deepEqual(f.state.comments, []);
  });

  const refused: [string, FakeOpts, Partial<PrDetail>, RegExp][] = [
    ["the head moved", { pull: { head: { sha: "f".repeat(40), ref: BRANCH, repo: { full_name: REPO } } } }, {}, /head moved to ffffffffffff/],
    ["the body changed", { pull: { body: "He edited it on GitHub" } }, {}, /title or description changed/],
    ["the PR closed", { pull: { state: "closed" } }, {}, /is closed/],
    ["not a forge PR", {}, { author: "someone" }, /not taking this PR over/],
  ];
  for (const [what, opts, over, want] of refused) {
    it(`writes nothing when ${what}`, async () => {
      const f = fakeGitHub(opts);
      await assert.rejects(saveMine(f.gh, detail(over), edit(), { committer: ME, ownText: true, promote: true, sleep: noSleep }), want);
      assert.deepEqual(writes(f.calls), []);
    });
  }

  const unsaved: [string, MineEdit, { ownText?: boolean; scopes?: string; d?: Partial<PrDetail> }, RegExp][] = [
    ["without his statement that the text is his", edit(), { ownText: false }, /haven't stated that the text is yours/],
    ["with a Generated-by line left", edit({ messages: new Map([[C1.sha, "mine"]]) }), {}, /still has a Generated-by line/],
    ["with the bot's title when promoting", edit({ title: detail().title }), {}, /title is the bot's/],
    [
      "when the token lacks the workflow scope",
      edit(),
      { scopes: "public_repo", d: { files: [{ filename: ".github/workflows/ci.yml", status: "modified", additions: 1, deletions: 0 }] } },
      /workflow scope/,
    ],
  ];
  for (const [what, e, o, want] of unsaved) {
    it(`refuses ${what}, before any request`, async () => {
      const f = fakeGitHub();
      await assert.rejects(saveMine(f.gh, detail(o.d), e, { committer: ME, ownText: o.ownText ?? true, promote: true, scopes: o.scopes, sleep: noSleep }), want);
      assert.equal(f.calls.length, 0);
    });
  }

  it("doesn't overwrite a body that changed while the branch moved", async () => {
    const f = fakeGitHub({ bodyAfterPush: `Bot edit\n\n${META}` });
    await assert.rejects(saveMine(f.gh, detail(), edit(), { committer: ME, ownText: true, promote: true, sleep: noSleep }), /changed meanwhile, so yours weren't saved/);
    assert.equal(f.state.body, `Bot edit\n\n${META}`);
    assert.equal(f.calls.filter((c) => c.method === "PATCH").length, 0);
    assert.deepEqual(f.state.comments, []);
  });

  it("refuses a bad committer before reading anything", async () => {
    const f = fakeGitHub();
    await assert.rejects(saveMine(f.gh, detail(), edit(), { committer: { name: "x", email: "" }, ownText: true, promote: true, sleep: noSleep }), /not an email/);
    assert.equal(f.calls.length, 0);
  });

  it("stops before the branch when GitHub writes a different tree", async () => {
    const f = fakeGitHub({ tamper: (c) => ({ ...c, tree: { sha: "9".repeat(40) } }) });
    await assert.rejects(saveMine(f.gh, detail(), edit(), { committer: ME, ownText: true, promote: true, sleep: noSleep }), /tree 9{40} instead of a{40}; the branch was not touched/);
    assert.deepEqual(writes(f.calls), [`POST /repos/${REPO}/git/commits`]);
    assert.equal(f.state.ref, C2.sha);
  });

  it("doesn't comment when the push never shows on the PR", async () => {
    const f = fakeGitHub({ eventAfter: -1 });
    await assert.rejects(saveMine(f.gh, detail(), edit(), { committer: ME, ownText: true, promote: true, sleep: noSleep }), /hasn't shown the push on the PR yet/);
    assert.equal(f.calls.filter((c) => c.url.includes("/issues/7/events")).length, PUSH_EVENT_TRIES);
    assert.deepEqual(f.state.comments, []);
    assert.equal(f.state.title, "widget: Make the knob configurable");
  });

  it("says so when the comment isn't later than the push", async () => {
    const f = fakeGitHub({ commentAt: PUSHED_AT });
    await assert.rejects(saveMine(f.gh, detail(), edit(), { committer: ME, ownText: true, promote: true, sleep: noSleep }), /not after the push .*Comment it again/);
  });

  it("says the branch moved when the compare-and-swap loses a race, and changes nothing else", async () => {
    const f = fakeGitHub({ raceTo: "e".repeat(40) });
    await assert.rejects(saveMine(f.gh, detail(), edit(), { committer: ME, ownText: true, promote: true, sleep: noSleep }), /moved to eeeeeeeeeeee since you opened the PR; nothing was pushed/);
    assert.equal(f.state.ref, "e".repeat(40));
    assert.equal(f.state.title, detail().title);
    assert.deepEqual(f.state.comments, []);
  });
});
