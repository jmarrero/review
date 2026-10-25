import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import rawConfig from "../src/github/review-draft-config.json" with { type: "json" };
import { GitHub } from "../src/github/api.ts";
import {
  dispatchFailed, draftDigest, draftsIn, excerpt, loadDraftIssues, newestDraft, parsePrRef, readPr, REVIEW_DRAFT_CONFIG, reviewDraftConfig, sendBoxState, sendDraft,
  startDraft, tickSendBox, type RawComment, type RawIssue, type ReviewDraftConfig,
} from "../src/github/reviewdrafts.ts";
import { reviewDraftsPanel } from "../src/github/reviewdraftsview.ts";
import { createRenderer } from "../src/markdown.ts";
import { installDom, scriptedFetch, type Scripted } from "./helpers.ts";

const c: ReviewDraftConfig = { tracker: "example/tracker", label: "review-draft", authors: ["bot", "op"], sendBox: "Send the newest draft as bot", workflow: "dispatch.yml", ref: "main" };
const HEAD = "a".repeat(40);
const block = (event = "REQUEST_CHANGES", head = HEAD) => [
  "```review-draft",
  'pr = "up/proj#7"',
  `head = "${head}"`,
  `event = "${event}"   # COMMENT, REQUEST_CHANGES or APPROVE`,
  "```",
  "",
  "## Review",
  "",
  "Body text.",
  "",
  "## Comments",
  "",
  "### `src/a.c:12`",
  "",
  "*Important*: fix this.",
  "",
  "### `src/b.c:3`",
  "",
  "(low) nit",
  "",
].join("\n");
const box = `- [ ] ${c.sendBox}`;
const issue = (body: string, user = "bot", comments = 0): RawIssue =>
  ({ number: 5, title: "Review draft: up/proj#7: Fix", html_url: "https://github.com/example/tracker/issues/5", body, comments, user: { login: user } });
const comment = (id: number, body: string, user = "bot"): RawComment => ({ id, html_url: `https://github.com/example/tracker/issues/5#issuecomment-${id}`, body, user: { login: user } });

test("the shipped configuration is off, and an invalid one is refused", () => {
  assert.equal(REVIEW_DRAFT_CONFIG, undefined);
  assert.equal(reviewDraftConfig(rawConfig), undefined);
  assert.deepEqual(reviewDraftConfig(c), c);
  for (const bad of [{ ...c, tracker: "x" }, { ...c, label: ".." }, { ...c, authors: [] }, { ...c, sendBox: "a\nb" }, { ...c, sendBox: "[x]" },
    { ...c, workflow: "../x.yml" }, { ...c, ref: "a b" }, { ...c, tracker: "" }]) {
    assert.throws(() => reviewDraftConfig(bad), /Invalid review draft configuration/);
  }
});

test("a draft block parses into its PR, head, event, body and comments", () => {
  const [d] = draftsIn(`Intro\n\n${block()}\n${box}\n`, c.sendBox);
  assert.equal(d?.error, undefined);
  assert.deepEqual(d?.draft, {
    pr: { owner: "up", repo: "proj", number: 7 }, head: HEAD, event: "REQUEST_CHANGES", body: "Body text.",
    comments: [{ path: "src/a.c", line: 12, body: "*Important*: fix this." }, { path: "src/b.c", line: 3, body: "(low) nit" }],
  });
  // The send box and what follows are not part of the draft.
  assert.doesNotMatch(d!.raw, /Send the newest/);
  assert.match(draftsIn(block("MERGE"), c.sendBox)[0]!.error!, /event must be/);
  assert.match(draftsIn(block("COMMENT", "abc"), c.sendBox)[0]!.error!, /head must be/);
  assert.deepEqual(draftsIn("no draft here", c.sendBox), []);
});

test("a draft with text the preview would not show is refused", () => {
  const err = (text: string) => draftsIn(text, c.sendBox)[0]!.error;
  // A malformed heading would otherwise hide its must-fix comment.
  assert.match(err(block().replace("### `src/a.c:12`", "### src/a.c:12"))!, /malformed comment heading: ### src\/a.c:12/);
  assert.match(err(block().replace("### `src/b.c:3`", "### `src/b.c`"))!, /malformed comment heading/);
  assert.match(err(block().replace("## Review", "Stray.\n\n## Review"))!, /between the draft block/);
  assert.match(err(block().replace("### `src/a.c:12`", "Stray.\n\n### `src/a.c:12`"))!, /before its first/);
  assert.match(err(block().replace("## Comments", "## Comments\n\n## Review"))!, /at most one/);
  assert.match(err(`${block()}\n## Review\n\nAgain.\n`)!, /at most one/);
  // Comments without a body are fine.
  assert.equal(draftsIn(block().replace(/## Review\n\nBody text.\n\n/, ""), c.sendBox)[0]!.draft?.comments.length, 2);
});

test("the newest draft is the last trusted one, body first then comments", () => {
  const body = `${block("COMMENT")}\n${box}\n`;
  assert.equal(newestDraft(issue(body), [], c)?.draft?.event, "COMMENT");
  assert.equal(newestDraft(issue(body), [comment(1, block("APPROVE"))], c)?.source, "1");
  // Anyone can comment on a public tracker: an untrusted comment or body holds no draft.
  assert.equal(newestDraft(issue(body), [comment(1, block("APPROVE"), "mallory")], c)?.source, "body");
  assert.equal(newestDraft(issue(body, "mallory"), [], c), undefined);
  // In the body, drafts end at the last send box, and one after it is refused rather than hidden.
  assert.equal(newestDraft(issue(`${block("COMMENT")}\n${box}\n${block("APPROVE")}`), [], c)?.error, "a draft follows the send box");
  assert.equal(newestDraft(issue(`${box}\n${block("APPROVE")}\n${box}\n`), [], c)?.draft?.event, "APPROVE");
  // A comment isn't cut at a box line.
  assert.equal(newestDraft(issue(""), [comment(3, `${block("COMMENT")}\n${box}\n${block("APPROVE")}`)], c)?.draft?.event, "APPROVE");
  // Two drafts in one comment: the later one.
  assert.equal(newestDraft(issue(""), [comment(2, `${block("COMMENT")}\n${block("APPROVE")}`)], c)?.draft?.event, "APPROVE");
});

test("the send box is found, ticked once, and refused when missing or ticked", () => {
  const body = `x\r\n${box}\r\n`;
  assert.equal(sendBoxState(body, c.sendBox), "unticked");
  const ticked = tickSendBox(body, c.sendBox);
  assert.equal(ticked, `x\r\n- [x] ${c.sendBox}\r\n`);
  assert.equal(sendBoxState(ticked, c.sendBox), "ticked");
  assert.throws(() => tickSendBox(ticked, c.sendBox), /no longer there/);
  assert.equal(sendBoxState(`- [ ] ${c.sendBox} now`, c.sendBox), "missing");
  // The box text is literal, not a pattern.
  assert.equal(sendBoxState("- [ ] Send.the.newest", { ...c, sendBox: "Send the newest" }.sendBox), "missing");
  // An approval goes under the box, replacing an older one, in the body's line endings.
  const old = "<!-- review-draft-approved: source=1 sha256=0 pr=up/proj#7 head=0 -->";
  assert.equal(tickSendBox(`x\r\n${box}\r\n${old}\r\ny`, c.sendBox, "NEW"), `x\r\n- [x] ${c.sendBox}\r\nNEW\r\ny`);
  assert.equal(tickSendBox(`${old}\n${box}`, c.sendBox, "NEW"), `- [x] ${c.sendBox}\nNEW`);
});

test("a comment's excerpt is its line on the new side and the lines above it", () => {
  const patch = "@@ -1,5 +1,6 @@\n a\n b\n-c\n+C\n+D\n d\n e";
  const e = excerpt(patch, 4);
  assert.deepEqual(e?.rows.map((r) => r.text), ["b", "c", "C", "D"]);
  assert.equal(e?.at, 3);
  assert.equal(excerpt(patch, 9), undefined);
  assert.equal(excerpt(undefined, 1), undefined);
});

test("PR refs parse from OWNER/REPO#N and PR URLs only", () => {
  assert.deepEqual(parsePrRef(" up/proj#7 "), { owner: "up", repo: "proj", number: 7 });
  assert.deepEqual(parsePrRef("https://github.com/up/proj/pull/7/files"), { owner: "up", repo: "proj", number: 7 });
  assert.equal(parsePrRef("https://github.com/up/proj/issues/7"), undefined);
  assert.equal(parsePrRef("https://evil.example/up/proj/pull/7"), undefined);
});

const files = [{ filename: "src/a.c", patch: "@@ -10,2 +10,3 @@\n x\n y\n+z" }, { filename: "src/b.c", patch: "@@ -1 +1 @@\n-q\n+r" }];
const pr = (head = HEAD) => ({ title: "Fix", html_url: "https://github.com/up/proj/pull/7", state: "open", head: { sha: head } });

test("readPr places each comment at head, and only at the draft's head", async () => {
  const draft = draftsIn(block(), c.sendBox)[0]!.draft!;
  const route = (head: string) => (_m: string, url: string): Scripted | undefined =>
    url.endsWith("/pulls/7") ? { body: pr(head) } : url.includes("/pulls/7/files") ? { body: files } : undefined;
  let f = scriptedFetch(route(HEAD));
  const at = await readPr(new GitHub(async () => "t", f.fetchImpl), draft);
  assert.deepEqual(at.excerpts.map((e) => e?.rows.at(-1)?.text), ["z", undefined]);
  f = scriptedFetch(route("b".repeat(40)));
  const moved = await readPr(new GitHub(async () => "t", f.fetchImpl), draft);
  assert.deepEqual(moved.excerpts, []);
  assert.ok(!f.calls.some((r) => r.url.includes("/files")));
});

test("Send ticks the box only while the shown draft is still the newest", async () => {
  const body = `Intro\n${box}\n`;
  const shownComments = [comment(1, block())];
  let comments = shownComments;
  let current = body;
  let prNow: { state: string; head: { sha: string } } = pr();
  const f = scriptedFetch((m, url) => {
    if (url.endsWith("/repos/up/proj/pulls/7")) return { body: prNow };
    if (url.includes("/issues?")) return { body: [issue(current, "bot", comments.length)] };
    if (url.includes("/issues/5/comments")) return { body: comments };
    if (url.endsWith("/issues/5")) return m === "PATCH" ? { body: {} } : { body: issue(current, "bot", comments.length) };
    return undefined;
  });
  const gh = new GitHub(async () => "t", f.fetchImpl);
  const [shown] = await loadDraftIssues(gh, c);
  assert.equal(shown?.found?.source, "1");

  comments = [...shownComments, comment(2, block("APPROVE"))];
  await assert.rejects(sendDraft(gh, c, shown!), /newer draft/);
  comments = shownComments;
  current = `${body}edited`;
  await assert.rejects(sendDraft(gh, c, shown!), /changed since/);
  current = body;
  // The PR is checked when Send is clicked, not only when the card was drawn.
  prNow = pr("b".repeat(40));
  await assert.rejects(sendDraft(gh, c, shown!), /head moved/);
  prNow = { ...pr(), state: "closed" };
  await assert.rejects(sendDraft(gh, c, shown!), /no longer open/);
  assert.ok(!f.calls.some((r) => r.method === "PATCH"));

  prNow = pr();
  await sendDraft(gh, c, shown!);
  const patch = f.calls.filter((r) => r.method === "PATCH");
  assert.equal(patch.length, 1);
  // The tick names the draft shown, by digest, so a sender can refuse one that arrives after it.
  const digest = createHash("sha256").update(shown!.found!.raw).digest("hex");
  assert.deepEqual(patch[0]!.body,
    { body: `Intro\n- [x] ${c.sendBox}\n<!-- review-draft-approved: source=1 sha256=${digest} pr=up/proj#7 head=${HEAD} -->\n` });
  assert.equal(await draftDigest(shown!.found!.raw), digest);
});

test("an issue with a full page of comments is refused, not read in part", async () => {
  const f = scriptedFetch((_m, url) => url.includes("/issues?") ? { body: [issue(box, "bot", 100)] } : undefined);
  const [d] = await loadDraftIssues(new GitHub(async () => "t", f.fetchImpl), c);
  assert.match(d!.refused!, /100 or more comments/);
  assert.equal(d!.found, undefined);
});

test("Draft review creates the issue as the viewer and dispatches the drafting run", async () => {
  let open: RawIssue[] = [];
  const f = scriptedFetch((m, url) => {
    if (url.endsWith("/repos/up/proj/pulls/7")) return { body: pr() };
    if (url.includes("/repos/example/tracker/issues?")) return { body: open };
    if (url.endsWith("/user")) return { body: { login: "op" } };
    if (m === "POST" && url.endsWith("/repos/example/tracker/issues")) return { status: 201, body: { number: 9, html_url: "https://github.com/example/tracker/issues/9" } };
    if (m === "POST" && url.endsWith("/actions/workflows/dispatch.yml/dispatches")) return { status: 204 };
    return undefined;
  });
  const gh = new GitHub(async () => "t", f.fetchImpl);
  assert.deepEqual(await startDraft(gh, c, "https://github.com/up/proj/pull/7"), { issue: "https://github.com/example/tracker/issues/9" });
  const created = f.calls.find((r) => r.method === "POST" && r.url.endsWith("/issues"))!.body as Record<string, unknown>;
  assert.equal(created.title, "Review draft: up/proj#7: Fix");
  assert.deepEqual(created.labels, ["review-draft"]);
  assert.deepEqual(created.assignees, ["op"]);
  assert.equal(sendBoxState(String(created.body), c.sendBox), "unticked");
  // No draft in the new body: a tick before the run drafts has nothing to send.
  assert.deepEqual(draftsIn(String(created.body), c.sendBox), []);
  const dispatched = f.calls.find((r) => r.url.endsWith("/dispatches"))!.body as { ref: string; inputs: Record<string, string> };
  assert.equal(dispatched.ref, "main");
  assert.deepEqual({ ...dispatched.inputs, task: undefined }, { task: undefined, repo: "example/tracker", item: "9", kind: "research" });
  assert.match(dispatched.inputs.task!, new RegExp(`head = "${HEAD}"`));

  // A PR with an open draft already is refused before anything is written.
  open = [issue("", "op")];
  const writes = f.calls.filter((r) => r.method === "POST").length;
  await assert.rejects(startDraft(gh, c, "up/proj#7"), /already has an open draft/);
  assert.equal(f.calls.filter((r) => r.method === "POST").length, writes);
  await assert.rejects(startDraft(gh, c, "not a pr"), /OWNER\/REPO#N/);
});

test("Draft review finds an open draft past the first page, and refuses an unread one", async () => {
  const other = (n: number): RawIssue => ({ ...issue("", "op"), number: 100 + n, title: `Review draft: up/other#${n}: X` });
  let pages: RawIssue[][] = [];
  const f = scriptedFetch((_m, url) => {
    if (url.endsWith("/repos/up/proj/pulls/7")) return { body: pr() };
    const page = /\/issues\?.*&page=(\d+)/.exec(url);
    if (page) return { body: pages[Number(page[1]) - 1] ?? [] };
    return undefined;
  });
  const gh = new GitHub(async () => "t", f.fetchImpl);
  pages = [Array.from({ length: 100 }, (_, i) => other(i)), [issue("", "op")]];
  await assert.rejects(startDraft(gh, c, "up/proj#7"), /already has an open draft/);
  pages = Array.from({ length: 10 }, () => Array.from({ length: 100 }, (_, i) => other(i)));
  await assert.rejects(startDraft(gh, c, "up/proj#7"), /More than 1000 open/);
  assert.ok(!f.calls.some((r) => r.method !== "GET"));
});

test("a failed dispatch marks the issue, and Draft review again retries it once", async () => {
  let body = "";
  let dispatchOk = false;
  const claims: RawComment[] = [];
  const sent = (): string => (f.calls.at(-1)!.body as { body: string }).body;
  const nine = (): RawIssue => ({ ...issue(body, "op"), number: 9, html_url: "https://github.com/example/tracker/issues/9" });
  const f = scriptedFetch((m, url) => {
    if (url.endsWith("/repos/up/proj/pulls/7")) return { body: pr() };
    if (url.includes("/issues/9/comments")) {
      if (m === "POST") claims.push(comment(claims.length + 1, sent(), "op"));
      return { body: m === "POST" ? claims.at(-1) : claims };
    }
    if (url.includes("/repos/example/tracker/issues?")) return { body: body ? [nine()] : [] };
    if (url.endsWith("/user")) return { body: { login: "op" } };
    if (m === "POST" && url.endsWith("/repos/example/tracker/issues")) {
      body = sent();
      return { status: 201, body: { number: 9, html_url: "https://github.com/example/tracker/issues/9" } };
    }
    if (url.endsWith("/repos/example/tracker/issues/9")) {
      if (m === "PATCH") body = sent();
      return { body: nine() };
    }
    if (url.endsWith("/dispatches")) return dispatchOk ? { status: 204 } : { status: 500, body: { message: "boom" } };
    return undefined;
  });
  const gh = new GitHub(async () => "t", f.fetchImpl);
  const first = await startDraft(gh, c, "up/proj#7");
  assert.match(first.dispatchError!, /boom/);
  assert.ok(dispatchFailed(body));
  assert.equal(sendBoxState(body, c.sendBox), "unticked");

  // Still failing: marked again, so the next try can retry too.
  const second = await startDraft(gh, c, "up/proj#7");
  assert.equal(second.retried, true);
  assert.ok(second.dispatchError && dispatchFailed(body));

  dispatchOk = true;
  assert.deepEqual(await startDraft(gh, c, "up/proj#7"), { issue: "https://github.com/example/tracker/issues/9", retried: true });
  assert.ok(!dispatchFailed(body));
  assert.equal(f.calls.filter((r) => r.method === "POST" && r.url.endsWith("/issues")).length, 1);
  assert.equal(f.calls.filter((r) => r.url.endsWith("/dispatches")).length, 3);
  // With the marker gone, a run may be under way: no further dispatch.
  await assert.rejects(startDraft(gh, c, "up/proj#7"), /already has an open draft/);
  assert.equal(f.calls.filter((r) => r.url.endsWith("/dispatches")).length, 3);
  // Each failure is a new attempt, claimed afresh.
  assert.equal(new Set(claims.map((cm) => cm.body)).size, 2);
});

/** A tracker holding issues and their comments, numbered in creation order as GitHub numbers them. */
function tracker(dispatch: () => Scripted) {
  const issues: (RawIssue & { state: string })[] = [];
  const comments = new Map<number, RawComment[]>();
  let ids = 0;
  const f = scriptedFetch((m, url) => {
    const sent = f.calls.at(-1)!.body as Record<string, string>;
    if (url.endsWith("/repos/up/proj/pulls/7")) return { body: pr() };
    if (url.endsWith("/user")) return { body: { login: "op" } };
    if (url.endsWith("/dispatches")) return dispatch();
    if (url.includes("/repos/example/tracker/issues?")) return { body: issues.filter((i) => i.state === "open") };
    if (m === "POST" && url.endsWith("/repos/example/tracker/issues")) {
      const n = issues.length + 1;
      issues.push({ ...issue(sent.body!, "op"), number: n, title: sent.title!, html_url: `https://github.com/example/tracker/issues/${n}`, state: "open" });
      return { status: 201, body: issues.at(-1) };
    }
    const n = Number(/\/issues\/(\d+)/.exec(url)?.[1]);
    const i = issues[n - 1]!;
    if (url.includes("/comments")) {
      const list = comments.get(n) ?? [];
      comments.set(n, list);
      if (m === "POST") list.push(comment(++ids, sent.body!, "op"));
      return { body: m === "POST" ? list.at(-1) : list };
    }
    if (m === "PATCH") Object.assign(i, sent);
    return { body: i };
  });
  return { issues, f, gh: new GitHub(async () => "t", f.fetchImpl) };
}

test("a failed dispatch leaves an issue edited meanwhile as it is", async () => {
  const t = tracker(() => {
    t.issues[0]!.body += "\nThe operator's note.\n";
    return { status: 500, body: { message: "boom" } };
  });
  const started = await startDraft(t.gh, c, "up/proj#7");
  assert.match(started.dispatchError!, /boom; the issue changed meanwhile, so it was not marked/);
  assert.match(t.issues[0]!.body!, /The operator's note/);
  assert.ok(!dispatchFailed(t.issues[0]!.body));
  assert.ok(!t.f.calls.some((r) => r.method === "PATCH"));
});

test("concurrent Draft reviews of one PR dispatch one run, first and on retry", async () => {
  let ok = false;
  const t = tracker(() => ok ? { status: 204 } : { status: 500, body: { message: "boom" } });
  const dispatches = () => t.f.calls.filter((r) => r.url.endsWith("/dispatches")).length;
  const both = () => Promise.allSettled([startDraft(t.gh, c, "up/proj#7"), startDraft(t.gh, c, "up/proj#7")]);

  // Both pass the duplicate check and create an issue; the later one closes itself.
  const [a, b] = await both();
  assert.equal(dispatches(), 1);
  assert.deepEqual(t.issues.map((i) => i.state), ["open", "closed"]);
  assert.equal(a.status, "fulfilled");
  assert.match(String(b.status === "rejected" && b.reason), /already has an open draft: .*issues\/1$/);
  assert.ok(dispatchFailed(t.issues[0]!.body));

  // Both read the failure marker and claim the retry; only the earlier claim dispatches.
  ok = true;
  const results = await both();
  assert.equal(dispatches(), 2);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.match(String(results.find((r) => r.status === "rejected")!.reason), /already being retried/);
  assert.ok(!dispatchFailed(t.issues[0]!.body));
});

test("the panel reads on open and renders the draft beside its hunk, with Send enabled", async () => {
  const win = installDom();
  const render = createRenderer(win as unknown as Parameters<typeof createRenderer>[0]);
  const f = scriptedFetch((_m, url) => {
    if (url.includes("/issues?")) return { body: [issue(`${block()}\n${box}\n`)] };
    if (url.includes("/issues/5/comments")) return { body: [] };
    if (url.endsWith("/pulls/7")) return { body: pr() };
    if (url.includes("/pulls/7/files")) return { body: [files[0], { filename: "src/b.c", patch: "@@ -1,3 +1,3 @@\n a\n b\n-q\n+r" }] };
    return undefined;
  });
  const panel = reviewDraftsPanel(new GitHub(async () => "t", f.fetchImpl), c, render);
  document.body.replaceChildren(panel);
  assert.equal(f.calls.length, 0);
  panel.open = true;
  panel.dispatchEvent(new win.Event("toggle"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(panel.textContent!, /Request changes/);
  assert.match(panel.textContent!, /fix this/);
  assert.equal(panel.querySelectorAll(".review-draft-hunk").length, 2);
  assert.equal(panel.querySelector<HTMLButtonElement>(".review-draft button")!.disabled, false);
  assert.equal(panel.querySelector(".review-draft-flags")!.textContent, "");
});

test("the panel flags a moved head and disables Send", async () => {
  const win = installDom();
  const render = createRenderer(win as unknown as Parameters<typeof createRenderer>[0]);
  const f = scriptedFetch((_m, url) => {
    if (url.includes("/issues?")) return { body: [issue(`${block()}\n${box}\n`)] };
    if (url.includes("/issues/5/comments")) return { body: [] };
    if (url.endsWith("/pulls/7")) return { body: pr("b".repeat(40)) };
    return undefined;
  });
  const panel = reviewDraftsPanel(new GitHub(async () => "t", f.fetchImpl), c, render);
  panel.open = true;
  panel.dispatchEvent(new win.Event("toggle"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(panel.querySelector(".review-draft-flags")!.textContent!, /head moved .*needs a redraft/);
  assert.equal(panel.querySelector<HTMLButtonElement>(".review-draft button")!.disabled, true);
});
