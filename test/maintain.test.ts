import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHub } from "../src/github/api.ts";
import { type ApproveItem, approveSelected } from "../src/github/maintain.ts";
import { approveGroup } from "../src/github/maintainview.ts";
import { installDom, scriptedFetch } from "./helpers.ts";

/** The digest's approvals as the pass lists them (agent-board's fixtures/pass/maintain-digest.md). */
const approve = (): ApproveItem[] => [
  { pr: { owner: "up", repo: "proj", number: 7 }, head: "1".repeat(40), reason: "Dependency bump, lockfile only; all checks green at this head." },
  { pr: { owner: "up", repo: "proj", number: 8 }, head: "2".repeat(40), reason: "Typo fix in docs; all checks green at this head." },
];

test("Approve selected approves at the assessed head, and skips a PR whose head moved or that closed", async () => {
  const items = approve();
  const closed = { ...items[0]!, pr: { ...items[0]!.pr, number: 70 } };
  const f = scriptedFetch((m, url) => {
    if (url.endsWith("/user")) return { body: { login: "jmarrero" } };
    if (m === "GET" && url.endsWith("/reviews?per_page=100")) return { body: [] };
    if (m === "GET" && url.endsWith("/pulls/7")) return { body: { state: "open", head: { sha: "1".repeat(40) } } };
    if (m === "GET" && url.endsWith("/pulls/8")) return { body: { state: "open", head: { sha: "9".repeat(40) } } };
    if (m === "GET" && url.endsWith("/pulls/70")) return { body: { state: "closed", head: { sha: "1".repeat(40) } } };
    if (m === "POST" && url.endsWith("/pulls/7/reviews")) return { body: {} };
    return undefined;
  });
  const gh = new GitHub(async () => "t", f.fetchImpl);
  const rs = await approveSelected(gh, [...items, closed]);
  assert.deepEqual(rs.map((r) => [r.pr.number, r.status]), [[7, "approved"], [8, "skipped"], [70, "skipped"]]);
  assert.match(rs[1]!.note!, /head moved to 999999999999/);
  const posts = f.calls.filter((call) => call.method === "POST" && !call.url.endsWith("/graphql"));
  assert.deepEqual(posts.map((p) => [p.url, p.body]), [["https://api.github.com/repos/up/proj/pulls/7/reviews", { event: "APPROVE", commit_id: "1".repeat(40) }]]);
  // A fresh card shares the write receipt even while GitHub's reviews lag.
  const before = f.calls.length;
  const again = await approveSelected(gh, [approve()[0]!]);
  assert.equal(again[0]!.status, "already-approved");
  assert.deepEqual(f.calls.slice(before).map((c) => c.method), ["GET"]);
  installDom();
  const el = approveGroup(items, (picked) => approveSelected(gh, picked));
  assert.equal(el.querySelector<HTMLInputElement>("input")!.checked, false);
  assert.match(el.textContent!, /Done at HEAD/);
});

test("the inbox approval group selects every candidate not yet approved", () => {
  installDom();
  assert.equal(approveGroup(approve(), async () => []).querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked").length, 2);
});
