import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type DocumentEntry, type Mark, parseDocument } from "../src/github/decisiondocument.ts";
import { type Ask, type NeedsYou, parseNeedsYou } from "../src/github/holds.ts";
import { askCard, askHref, type Card, documentCard, inboxCards, NEEDS_YOU_MAX_AGE_MS, type Published, publishedCards, publishedNote, sendCard } from "../src/github/inbox.ts";
import type { DraftIssue } from "../src/github/reviewdrafts.ts";
import { rawAsk, rawNeedsYou } from "./helpers.ts";

const NOW = Date.parse("2026-10-25T12:00:00Z");
const HOUR = 3_600_000;
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();
const HEAD = "a".repeat(40);

/** What a predicate made of a case: absent (the thing left), or the card waiting on him or answered. */
type Outcome = "absent" | "present" | "answered";
const outcome = (c: Card | undefined): Outcome => (c === undefined ? "absent" : c.answered ? "answered" : "present");

/** A list as parsed, of the raw asks given. */
function list(items: unknown[], over: Record<string, unknown> = {}, confirmed = at(0.1)): NeedsYou {
  const l = parseNeedsYou(rawNeedsYou(items, confirmed, over));
  assert.ok(typeof l === "object", String(l));
  return l;
}
const asks = (...items: unknown[]): Ask[] => list(items).items;
const pr = (n: number, type: string, over: Record<string, unknown> = {}) => rawAsk(n, { item: `up/proj#${n}`, key: `up/proj#${n}`, source: "reviews", kind: "review-approve", action: { type, repository: "up/proj", number: n, ...(type === "approve_pull_request" || type === "review_pull_request" ? { head: HEAD } : {}) }, ...over });

describe("published ask cards", () => {
  // the action type, the card's kind, its link on GitHub and in the app
  const cases: [string, Record<string, unknown>, string, string, string][] = [
    ["a hold on an issue is answered", rawAsk(7), "answer", "https://github.com/jmarrero-forge/tracker/issues/7", "#issue/jmarrero-forge/tracker/7"],
    ["a PR's needs-human is answered on the PR", pr(3, "pull_request", { kind: "review-needs-human" }), "answer", "https://github.com/up/proj/pull/3", "#pr/up/proj/3"],
    ["an approval at a head is approved in place", pr(4, "approve_pull_request"), "approve", "https://github.com/up/proj/pull/4", "#pr/up/proj/4"],
    ["a broker review wait the review job withheld is approved in place", pr(2, "approve_pull_request", { item: "jmarrero-bot/praxis-credential-broker#2", key: "jmarrero-bot/praxis-credential-broker#2", kind: "review-withheld", action: { type: "approve_pull_request", repository: "jmarrero-bot/praxis-credential-broker", number: 2, head: HEAD } }), "approve", "https://github.com/jmarrero-bot/praxis-credential-broker/pull/2", "#pr/jmarrero-bot/praxis-credential-broker/2"],
    ["a closer look opens the PR pane", pr(9, "review_pull_request", { kind: "digest-closer", key: "up/proj#9/digest" }), "open", "https://github.com/up/proj/pull/9", "#pr/up/proj/9"],
    ["a proposal is its own Do card, linked to its comment", rawAsk(5, { key: "jmarrero-forge/tracker#5/comment-21", source: "proposals", kind: "operator-action", action: { type: "operator_action", repository: "jmarrero-forge/tracker", number: 5, comment: 21 } }), "do", "https://github.com/jmarrero-forge/tracker/issues/5#issuecomment-21", "#issue/jmarrero-forge/tracker/5"],
  ];
  for (const [name, raw, kind, url, href] of cases) it(name, () => {
    const c = askCard(asks(raw)[0]!);
    assert.deepEqual([c.kind, c.url, "ask" in c && askHref(c.ask.action)], [kind, url, href]);
  });

  it("shows the recommendation, a carried ask and the pass's Priority", () => {
    const c = askCard(asks(rawAsk(7, { recommendation: "Yes, CI is green.", carried: true, priority: "P0" }))[0]!);
    assert.deepEqual([c.title, c.priority, c.note], ["Ask 7?", "P0", "Recommendation: Yes, CI is green. Carried over: the pass did not read its source again."]);
  });

  it("keeps the pass's order and count, with each proposal its own card and the digest's approvals one group where the first ranks", () => {
    const proposal = (comment: number) => rawAsk(5, { key: `jmarrero-forge/tracker#5/comment-${comment}`, kind: "operator-action", action: { type: "operator_action", repository: "jmarrero-forge/tracker", number: 5, comment } });
    const digest = (n: number) => pr(n, "approve_pull_request", { key: `up/proj#${n}/digest`, kind: "digest-approve", recommendation: `Bump ${n}.` });
    const cards = publishedCards(asks(rawAsk(1), digest(7), proposal(21), proposal(22), digest(8), rawAsk(2)));
    assert.deepEqual(cards.map((c) => c.key), ["jmarrero-forge/tracker#1", "digest", "jmarrero-forge/tracker#5/comment-21", "jmarrero-forge/tracker#5/comment-22", "jmarrero-forge/tracker#2"]);
    const group = cards[1]!;
    assert.ok(group.kind === "digest");
    assert.deepEqual(group.items.map((i) => [i.pr.number, i.head, i.reason]), [[7, HEAD, "Bump 7."], [8, HEAD, "Bump 8."]]);
  });
});

function draft(over: Partial<DraftIssue> = {}, state?: string): DraftIssue & { issue: { state?: string } } {
  return { issue: { number: 40, title: "Review draft: upstream/widget#3: Fix", html_url: "https://github.com/jmarrero-forge/tracker/issues/40", body: "", comments: 1, user: { login: "jmarrero-bot" }, ...(state ? { state } : {}) }, box: "unticked", ...over };
}

describe("Send cards", () => {
  const cases: [string, ReturnType<typeof draft>, Outcome][] = [
    ["an open draft issue", draft(), "present"],
    ["a draft he sent, the workflow not yet run", draft({ box: "ticked" }), "answered"],
    ["a draft issue the workflow closed", draft({}, "closed"), "absent"],
    // Not readable as a draft (no draft yet, too many comments): still his to look at.
    ["a draft issue with no draft yet", draft({ refused: "100 or more comments" }), "present"],
  ];
  for (const [name, d, want] of cases) it(name, () => assert.equal(outcome(sendCard(d)), want));
});

describe("document entry cards", () => {
  const body = "### D15 Create the ruleset\nAbout: example/work#15, asked 2026-10-15\n- [ ] A) Create it\nReply:\n\n### D16 Pick one\nAbout: example/work#16\n- [x] A) This\n- [ ] B) That\nReply: done\n\n### D17 Land it (P0, blocks example/work#17)\n- [ ] A) Yes\nReply:\n\n## Done\n### D1 Old\n- [x] A) Kept\n";
  const entries = parseDocument(body);
  const entry = (id: string): DocumentEntry => entries.find((e) => e.id === id)!;
  const closed: Mark = { item: "example/work#15", state: "closed", url: "https://github.com/example/work/issues/15" };
  const merged: Mark = { item: "example/work#17", state: "merged", url: "https://github.com/example/work/pull/17" };
  const commented: Mark = { item: "example/work#15", state: "answered", comments: 2, url: "https://github.com/example/work/issues/15" };
  const cases: [string, DocumentEntry, Mark | undefined, Outcome, RegExp?][] = [
    ["an open entry", entry("D15"), undefined, "present"],
    ["an entry he answered", entry("D16"), undefined, "answered", /waiting on the bot/],
    ["an entry whose About item closed", entry("D15"), closed, "absent"],
    ["an entry whose heading's blocked item merged", entry("D17"), merged, "absent"],
    ["an entry whose item changed since the ask", entry("D15"), commented, "present", /Changed since asked: 2 comments on example\/work#15/],
    ["a mark read for another item", entry("D16"), closed, "answered"],
    ["an entry under Done", entry("D1"), undefined, "absent"],
  ];
  for (const [name, e, mark, want, note] of cases) {
    it(name, () => {
      const card = documentCard(e, mark);
      assert.equal(outcome(card), want);
      if (note) assert.match(card?.note ?? "", note);
    });
  }
});

describe("inboxCards", () => {
  it("lists the pass's asks in its order, then the document's and the drafts', then those he did", () => {
    const entries = parseDocument("### D2 Ask\n- [ ] A) Yes\nReply:\n\n### D3 Done here\n- [x] A) Yes\nReply:\n");
    const published: Published = { asks: asks(rawAsk(9, { priority: "P2" }), rawAsk(8)), unavailable: false };
    const cards = inboxCards({ published, document: { entries, marks: new Map() }, drafts: [draft()] });
    assert.deepEqual(cards.map((c) => `${c.key}${c.answered ? " (answered)" : ""}`), ["jmarrero-forge/tracker#9", "jmarrero-forge/tracker#8", "document:D2", "send:40", "document:D3 (answered)"]);
  });

  it("marks the cards of a list that can't be read now", () => {
    const cards = inboxCards({ published: { asks: asks(rawAsk(9)), unavailable: true } });
    assert.deepEqual(cards.map((c) => c.unavailable), [true]);
  });
});

describe("publishedNote", () => {
  const checked = NOW - 60_000;
  const fresh = (over: Record<string, unknown> = {}, confirmed = at(0.5)): Published => {
    const l = list([rawAsk(1)], over, confirmed);
    return { asks: l.items, list: l, checkedAt: checked, unavailable: false };
  };
  // name, what was read, whether empty may say nothing waits, what the note says
  const cases: [string, Published, boolean, RegExp][] = [
    ["nothing read yet", { asks: [], unavailable: false }, false, /^Reading the pass's needs-you list/],
    ["a complete list the pass confirmed half an hour ago", fresh(), true, /^The pass's list: confirmed 30m ago, changed 30m ago, checked on GitHub 1m ago\.$/],
    ["a partial source", fresh({ complete: false, sources: { epics: "complete", items: "complete", reviews: "complete", proposals: "partial", digest: "unread" } }), false, /Incomplete \(proposals partial, digest unread\): more may wait on you\./],
    ["asks past the pass's cap", fresh({ complete: false, omitted: 3 }), false, /Incomplete \(3 past the pass's cap\)/],
    ["a list the pass says is complete but whose count disagrees", fresh({ count: 5 }), false, /Incomplete: more may wait/],
    // A 304 a minute ago confirms the comment, not the pass: the list is as old as its validated_at.
    ["a list GitHub confirmed but the pass last confirmed two hours ago", fresh({}, at(2)), false, /confirmed 2h ago.*checked on GitHub 1m ago\. The pass has not confirmed it for over an hour/],
    ["one just past the limit", fresh({}, new Date(NOW - NEEDS_YOU_MAX_AGE_MS - 1000).toISOString()), false, /has not confirmed it/],
    ["a list from this browser's cache", { ...fresh(), checkedAt: undefined } as unknown as Published, false, /shown from this browser's cache/],
    ["summaries not all read", fresh({ summaries: "partial" }), true, /some asks show the board's question or the hold's reason/],
    ["a list kept after a failed read", { ...fresh(), unavailable: true, error: "Couldn't read the pass's snapshot: HTTP 502" }, false, /^Couldn't read the pass's snapshot: HTTP 502\. Cards from the list the pass confirmed 30m ago.*marked unavailable/],
    ["no list, the snapshot's holds shown", { asks: asks(rawAsk(1)), unavailable: false, error: "The pass's snapshot has no needs-you list" }, false, /no needs-you list\. Shown: the snapshot's own operator holds; review waits, proposals and digest asks are not listed\./],
    ["no snapshot at all", { asks: [], unavailable: false, error: "The pass has published no hold snapshot" }, false, /Holds, review waits, proposals and digest asks are not listed\./],
  ];
  for (const [name, p, settled, text] of cases) it(name, () => {
    if (p.checkedAt === undefined) delete p.checkedAt;
    const note = publishedNote(p, NOW);
    assert.equal(note.settled, settled, note.text);
    assert.match(note.text, text);
  });
});
