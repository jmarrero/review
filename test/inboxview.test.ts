import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDocument } from "../src/github/decisiondocument.ts";
import { askCard, type Card, documentCard, publishedCards, publishedNote } from "../src/github/inbox.ts";
import { CARD_CHANGED_NOTE, CARD_GONE_NOTE, CARD_STALE_CLASS, CARD_UNAVAILABLE_CLASS, fillInbox as drawInbox, holdsDraft, INBOX_PAGE, type InboxHooks } from "../src/github/inboxview.ts";
import { ACTION_CONFIG, loadOffer } from "../src/github/actions.ts";
import { GitHub } from "../src/github/api.ts";
import { CHAT_CONFIG } from "../src/github/chatconfig.ts";
import { ITEM_CHAT_EVENT } from "../src/github/chatitem.ts";
import { proposalCard } from "../src/github/actionsview.ts";
import { type Ask, HOLDS_MARKER, parseHolds, parseNeedsYou } from "../src/github/holds.ts";
import { answerForm } from "../src/github/view.ts";
import { createRenderer } from "../src/markdown.ts";
import { fixture, installDom, rawAsk, rawNeedsYou, REAL_NEEDS_YOU_AT, REAL_NEEDS_YOU_KEYS, realNeedsYouSnapshot } from "./helpers.ts";

const win = installDom();
const render = createRenderer(win as unknown as Parameters<typeof createRenderer>[0]);

// Existing action tests inspect the cards; cold-load laziness is tested separately.
function fillInbox(...args: Parameters<typeof drawInbox>): number {
  const count = drawInbox(...args);
  for (const fold of args[0].querySelectorAll<HTMLDetailsElement>(".card-full")) { fold.open = true; fold.dispatchEvent(new win.Event("toggle")); }
  return count;
}

const sent: string[] = [];
const hooks: InboxHooks = {
  now: Date.parse("2026-10-25T12:00:00Z"),
  render,
  mayAct: true,
  // As main.ts's: the target's question read, with the form that answers it.
  answerBody: async (a) => answerForm({ owner: "o", repo: "r", number: a.action.number }, { options: [{ letter: "A", text: "left", recommended: false }] }, false, async () => "https://github.com/o/r/issues/1#issuecomment-1", `card-${a.key}-`, 2),
  answerEntry: async (entry, letter, reply) => { sent.push(`${entry.id} ${letter} ${reply}`); },
};

/** The open entry `id` of a document, as a card, with `extra` added to its text. */
function entry(id: string, extra = ""): Card {
  return documentCard(parseDocument(`### ${id} Pick one\n${extra}- [ ] A) This\n- [ ] B) That\nReply:\n`)[0]!, undefined)!;
}

/** The published asks of `raw`, as parsed. */
function asks(...raw: Record<string, unknown>[]): Ask[] {
  const l = parseNeedsYou(rawNeedsYou(raw, "2026-10-25T11:30:00Z"));
  assert.ok(typeof l === "object", String(l));
  return l.items;
}

/** A hold the pass lists, answered in place. */
const question = (n = 1): Card => askCard(asks(rawAsk(n, { ask: "Which way?" }))[0]!);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const cardOf = (list: HTMLElement, key: string) => list.querySelector<HTMLElement>(`[data-key="${key}"]`);
const keys = (list: HTMLElement) => [...list.children].map((c) => c.getAttribute("data-key"));

/** Type into a card's form as he would, without sending. */
const drafts: [string, (card: HTMLElement) => void][] = [
  ["a picked option", (card) => { card.querySelector<HTMLInputElement>("input[type=radio]")!.checked = true; }],
  ["a reply", (card) => { card.querySelector<HTMLInputElement>("input[type=text]")!.value = "not yet"; }],
];

describe("fillInbox", () => {
  it("replays all 12 published asks unchanged at publication time, with typed links and limitations", () => {
    const raw = realNeedsYouSnapshot();
    const snapshot = parseHolds(`${HOLDS_MARKER}\n\n\`\`\`json\n${JSON.stringify(raw)}\n\`\`\``)!;
    const l = snapshot.needsYou;
    assert.ok(l && typeof l === "object", String(l));
    const now = Date.parse(REAL_NEEDS_YOU_AT);
    const box = document.createElement("div");
    const list = document.createElement("div");
    box.append(list);
    // A non-operator can inspect, never answer/release/approve. The ordinary
    // operator answer path remains covered by maincards.test.ts and chat.test.ts.
    const replayHooks = { ...hooks, now, mayAct: false };
    const cards = publishedCards(l.items);
    assert.deepEqual(cards.map((c) => [c.key, c.kind]), REAL_NEEDS_YOU_KEYS.map((key) => [key, "answer"]));
    assert.equal(fillInbox(list, cards, replayHooks), 12);
    assert.deepEqual(keys(list), REAL_NEEDS_YOU_KEYS.slice(0, INBOX_PAGE));
    for (let page = 0; page < 2; page++) box.querySelector<HTMLButtonElement>(".inbox-more")!.click();
    assert.equal(box.querySelector(".inbox-more"), null);
    assert.deepEqual(keys(list), REAL_NEEDS_YOU_KEYS);
    for (const [i, card] of [...list.children].entries()) {
      const key = REAL_NEEDS_YOU_KEYS[i]!;
      assert.equal(card.querySelector(".title a")?.getAttribute("href"), `https://github.com/${key.replace("#", "/issues/")}`);
      assert.equal(card.querySelector("a.action")?.getAttribute("href"), `#issue/${key.replace("#", "/")}`);
      assert.equal(card.querySelector("form, .c-approve, .members"), null);
      assert.equal(card.querySelector(".not-offered summary")?.textContent, "Not offered here: promote, merge or enqueue, close");
      assert.match(card.querySelector(".not-offered")!.textContent!, /Only the poll may merge\/enqueue/);
      assert.match(card.querySelector(".not-offered")!.textContent!, /no checked close endpoint/);
    }
    const note = publishedNote({ asks: l.items, list: l, unavailable: false, checkedAt: now }, now);
    assert.equal(note.settled, false);
    assert.match(note.text, /Incomplete \(items partial, digest partial, 85 past the pass's cap\)/);
    assert.doesNotMatch(note.text, /may have stopped|unreadable here|All caught up/);
  });

  for (const [name, numbers, carried] of [
    ["multi-member", [2110, 2111, 2112], false],
    ["one-member", [2110], false],
    ["carried", [2110, 2112], true],
  ] as const) it(`constructed contract case derived from publication: ${name}, exact links and no representative writes`, () => {
    const raw = realNeedsYouSnapshot();
    Object.assign(raw.needs_you.items[0]!, {
      target: "https://untrusted.invalid/", carried,
      action: { type: "approve_pull_request", repository: "jmarrero-forge/agentic-job", number: 2110, head: "a".repeat(40) },
      kind: "digest-approve", group: { reason: "Constructed drafts", numbers },
    });
    const l = parseNeedsYou(raw.needs_you);
    assert.ok(typeof l === "object");
    assert.equal(l.refused, 0);
    let writes = 0;
    const reads: string[] = [];
    const list = document.createElement("div");
    const cards = publishedCards(l.items);
    assert.equal(cards[0]!.kind, "open", "never a representative or digest approval");
    fillInbox(list, cards, { ...hooks, now: Date.parse(REAL_NEEDS_YOU_AT),
      answerBody: async (a) => { reads.push(a.key); return document.createElement("div"); },
      approve: async () => { writes++; throw new Error("No group writes"); },
      approveDigest: async () => { writes++; return []; },
      chatItem: () => ({ ref: REAL_NEEDS_YOU_KEYS[0]!, title: "Constructed group" }),
    });
    const card = list.firstElementChild!;
    assert.deepEqual([...card.querySelectorAll(".member summary a")].map((a) => a.getAttribute("href")), numbers.map((n) => `#pr/jmarrero-forge/agentic-job/${n}`));
    assert.equal(card.querySelector("form, .primary, .c-answer, .c-approve, [href*='untrusted']"), null);
    assert.match(card.textContent!, /Inspect each member; no group writes/);
    if (carried) assert.match(card.textContent!, /Carried over/);
    if (CHAT_CONFIG) assert.ok(card.querySelector(".item-chat"), "retain chat, not an answer control");
    assert.deepEqual(reads, REAL_NEEDS_YOU_KEYS.slice(1, INBOX_PAGE), "only ordinary asks read an answer target");
    assert.equal(writes, 0);
  });

  for (const malformed of [false, true]) it(`constructed ${malformed ? "malformed" : "valid"} group retires a retained form instead of answering its representative`, async () => {
    const raw = realNeedsYouSnapshot();
    const initial = parseNeedsYou(raw.needs_you);
    assert.ok(typeof initial === "object");
    const list = document.createElement("div");
    const replayHooks = { ...hooks, now: Date.parse(REAL_NEEDS_YOU_AT) };
    fillInbox(list, publishedCards(initial.items), replayHooks);
    await settle();
    const card = list.firstElementChild!;
    const form = card.querySelector("form")!;
    form.querySelector("textarea")!.value = "Unsent";
    let submits = 0;
    form.addEventListener("submit", () => { submits++; });
    Object.assign(raw.needs_you.items[0]!, { action: { type: "pull_request", repository: "jmarrero-forge/agentic-job", number: 2110 }, group: { reason: "Constructed group", numbers: malformed ? [2110, 0] : [2110, 2111] } });
    const l = parseNeedsYou(raw.needs_you);
    assert.ok(typeof l === "object");
    assert.equal(l.refused, malformed ? 1 : 0);
    assert.deepEqual(l.items.map((a) => a.key), REAL_NEEDS_YOU_KEYS.slice(malformed ? 1 : 0));
    assert.equal(fillInbox(list, publishedCards(l.items), replayHooks), malformed ? 11 : 12);
    if (malformed) {
      assert.equal(form.querySelector("button")!.disabled, true);
      assert.equal(card.querySelector("a[href]"), null);
      form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
      assert.equal(submits, 0, "retained handlers cannot send or release");
      assert.equal(form.querySelector("textarea")!.value, "Unsent");
      assert.match(publishedNote({ asks: l.items, list: l, unavailable: false, checkedAt: replayHooks.now }, replayHooks.now).text, /1 unreadable here/);
    } else {
      assert.notEqual(list.firstElementChild, card, "valid membership replaces the old representative form");
      assert.equal(list.firstElementChild!.querySelector("form, textarea"), null);
      assert.deepEqual([...list.firstElementChild!.querySelectorAll(".member summary a")].map((a) => a.getAttribute("href")), ["#pr/jmarrero-forge/agentic-job/2110", "#pr/jmarrero-forge/agentic-job/2111"]);
    }
  });

  it("replays constructed contract group shapes as exact inspect-only membership, retaining chat", () => {
    // Contract-shaped replay, not a claim of authorized live acceptance.
    const replay = fixture<{ cases: { numbers: number[]; carried?: boolean }[] }>("needs-you-groups.json");
    for (const row of replay.cases) {
      const [a] = asks(rawAsk(row.numbers[0]!, { carried: row.carried ?? false, target: "https://untrusted.invalid/", action: { type: "pull_request", repository: "example/project", number: row.numbers[0]! }, group: { reason: "drafts to inspect/promote", numbers: row.numbers } }));
      let reads = 0;
      const list = document.createElement("div");
      fillInbox(list, publishedCards([a!]), { ...hooks,
        answerBody: async () => { reads++; throw new Error("No representative answer"); },
        chatItem: () => ({ ref: `example/project#${row.numbers[0]}`, title: "Redacted" }),
      });
      assert.equal(reads, 0);
      assert.deepEqual([...list.querySelectorAll(".member summary a")].map((a) => a.getAttribute("href")), row.numbers.map((n) => `#pr/example/project/${n}`));
      assert.match(list.textContent!, /Inspect each member/);
      assert.equal(list.querySelector("form, .c-answer, .c-approve"), null);
      assert.equal(list.querySelector("[href*='untrusted']"), null);
      if (CHAT_CONFIG) {
        let ref = "";
        list.addEventListener(ITEM_CHAT_EVENT, (ev) => { ref = (ev as CustomEvent).detail.ref; });
        list.querySelector<HTMLButtonElement>(".item-chat")!.click();
        assert.equal(ref, `example/project#${row.numbers[0]}`);
      }
      if (row.carried) assert.match(list.textContent!, /Carried over/);
    }
  });

  it("redraws changed membership and revokes a representative's unsent answer", async () => {
    const list = document.createElement("div");
    const q = question();
    fillInbox(list, [q], hooks);
    await settle();
    list.querySelector("textarea")!.value = "not sent";
    const grouped = (numbers: number[]) => askCard({ ...(q as Card & { kind: "answer" }).ask, action: { type: "pull_request", repository: "o/r", number: 1 }, group: { reason: "drafts", numbers } });
    fillInbox(list, [grouped([1, 2])], hooks);
    assert.equal(list.querySelector("form"), null);
    assert.equal(list.querySelectorAll(".member").length, 2);
    fillInbox(list, [grouped([1, 3, 4])], hooks);
    assert.equal(list.querySelectorAll(".member").length, 3);
    assert.equal(list.querySelector("[href='#pr/o/r/2']"), null);
  });

  it("keeps an in-flight single approval's eventual outcome visible beside new membership", async () => {
    let finish!: (url: string) => void;
    const a = asks(rawAsk(1, { action: { type: "approve_pull_request", repository: "o/r", number: 1, head: "a".repeat(40) } }))[0]!;
    const list = document.createElement("div");
    win.confirm = () => true;
    const pending = { ...hooks, approve: async () => ({ pr: { owner: "o", repo: "r", number: 1 }, status: "approved" as const, url: await new Promise<string>((resolve) => { finish = resolve; }) }) };
    fillInbox(list, [askCard(a)], pending);
    list.querySelector<HTMLButtonElement>(".primary")!.click();
    fillInbox(list, [askCard({ ...a, group: { reason: "drafts", numbers: [1, 2] } })], pending);
    assert.match(list.textContent!, /Prior write:.*Sending/);
    finish("https://github.com/o/r/pull/1#pullrequestreview-1");
    await settle();
    assert.match(list.textContent!, /Approved:/);
    assert.equal(list.querySelectorAll(".member summary a").length, 2);
    fillInbox(list, [askCard({ ...a, group: { reason: "drafts", numbers: [1, 3] } })], pending);
    assert.match(list.textContent!, /Approved:/);
    assert.deepEqual([...list.querySelectorAll(".member summary a")].map((a) => a.getAttribute("href")), ["#pr/o/r/1", "#pr/o/r/3"]);
  });

  it("keeps a rejected single approval's outcome beside new membership without a retry", async () => {
    let fail!: (e: Error) => void;
    const a = asks(rawAsk(1, { action: { type: "approve_pull_request", repository: "o/r", number: 1, head: "a".repeat(40) } }))[0]!;
    const list = document.createElement("div");
    win.confirm = () => true;
    const pending = { ...hooks, approve: async () => { await new Promise<never>((_, reject) => { fail = reject; }); throw new Error("unreachable"); } };
    fillInbox(list, [askCard(a)], pending);
    list.querySelector<HTMLButtonElement>(".primary")!.click();
    fillInbox(list, [askCard({ ...a, group: { reason: "drafts", numbers: [1, 2] } })], pending);
    fail(new Error("Ask left or grouped"));
    await settle();
    assert.match(list.textContent!, /Prior write:.*Not sent: Ask left or grouped/);
    assert.equal(list.querySelector(".prior-write button"), null);
  });

  it("refuses a malformed group visibly instead of falling back to Answer", () => {
    const l = parseNeedsYou(rawNeedsYou([rawAsk(1, { group: { reason: "drafts", numbers: [1, 0] } })], "2026-10-25T11:30:00Z"));
    assert.ok(typeof l === "object");
    assert.deepEqual(publishedCards(l.items), []);
    const note = publishedNote({ asks: l.items, list: l, unavailable: false, checkedAt: hooks.now }, hooks.now);
    assert.equal(note.settled, false);
    assert.match(note.text, /Incomplete.*1 unreadable here/);
  });

  it("does not fold published groups into digest approvals even when tagged digest-approve", () => {
    const a = asks(rawAsk(1, { kind: "digest-approve", action: { type: "approve_pull_request", repository: "o/r", number: 1, head: "a".repeat(40) }, group: { reason: "drafts", numbers: [1, 2] } }))[0]!;
    assert.equal(publishedCards([a])[0]!.kind, "open");
  });

  it("draws three proposals the pass lists on one issue as separate cards with title, why and Run", async () => {
    const config = ACTION_CONFIG;
    assert.ok(config);
    const comments = [1, 2, 3].map((n) => ({ id: `IC_${n}`, databaseId: n, updatedAt: "2026-10-29T12:00:00Z", author: { login: "jmarrero-bot" }, editor: null, lastEditedAt: null,
      body: `\`\`\`agent-board-action\n${JSON.stringify({ schema: "agent-board/operator-action/v1", title: `Decision ${n}`, why: `Reason ${n}`, actions: [{ type: "add_label", repo: "jmarrero-forge/tracker", number: 1013, label: `choice-${n}` }] })}\n\`\`\`` }));
    const gh = new GitHub(async () => "t", async (url) => {
      if (url.endsWith("/graphql")) return Response.json({ data: { repository: { issue: { state: "OPEN", comments: { nodes: comments, pageInfo: { hasNextPage: false } } } } } });
      if (url.endsWith("/issues/1013")) return Response.json({ title: "Epic decisions", state: "open", labels: [] });
      throw new Error(`Unexpected read: ${url}`);
    });
    const proposal = (n: number) => rawAsk(1013, { key: `jmarrero-forge/tracker#1013/comment-${n}`, source: "proposals", kind: "operator-action", ask: `Decision ${n}`, action: { type: "operator_action", repository: "jmarrero-forge/tracker", number: 1013, comment: n } });
    const list = document.createElement("div");
    // As main.ts's offerBody: each card reads its own proposal again.
    fillInbox(list, publishedCards(asks(proposal(1), proposal(2), proposal(3))), { ...hooks, offerBody: async (a) => proposalCard(gh, config, await loadOffer(gh, config, a.action), () => false, () => {}) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const n of [1, 2, 3]) {
      const card = cardOf(list, `jmarrero-forge/tracker#1013/comment-${n}`)!;
      assert.match(card.textContent!, new RegExp(`Reason ${n}`));
      const run = [...card.querySelectorAll("button")].filter((b) => b.textContent === "Run as yourself");
      assert.equal(run.length, 1);
      assert.equal(run[0]!.disabled, false);
    }
  });

  it("leaves an unchanged card as the node it is, and redraws a changed one with nothing typed", () => {
    const list = document.createElement("div");
    fillInbox(list, [entry("D1"), entry("D2")], hooks);
    const [d1, d2] = [cardOf(list, "document:D1"), cardOf(list, "document:D2")];
    fillInbox(list, [entry("D1"), entry("D2", "Context changed.\n")], hooks);
    assert.equal(cardOf(list, "document:D1"), d1);
    assert.notEqual(cardOf(list, "document:D2"), d2);
    assert.match(cardOf(list, "document:D2")!.textContent!, /Context changed/);
  });

  for (const [what, type] of drafts) {
    it(`never redraws a changed card holding ${what}; r does`, () => {
      const list = document.createElement("div");
      fillInbox(list, [entry("D1")], hooks);
      const card = cardOf(list, "document:D1")!;
      type(card);
      assert.ok(holdsDraft(card));
      fillInbox(list, [entry("D1", "Context changed.\n")], hooks);
      assert.equal(cardOf(list, "document:D1"), card);
      assert.ok(card.classList.contains(CARD_STALE_CLASS));
      assert.equal(card.querySelector("[role=status].card-stale-note")?.textContent, CARD_CHANGED_NOTE);
      assert.doesNotMatch(card.textContent!, /Context changed/);
      fillInbox(list, [entry("D1", "Context changed.\n")], hooks, true);
      assert.notEqual(cardOf(list, "document:D1"), card);
      assert.match(cardOf(list, "document:D1")!.textContent!, /Context changed/);
    });

    it(`keeps a card holding ${what} once its thing left, until it is cleared`, () => {
      const list = document.createElement("div");
      fillInbox(list, [entry("D1"), entry("D2")], hooks);
      const card = cardOf(list, "document:D1")!;
      type(card);
      fillInbox(list, [entry("D2")], hooks);
      assert.equal(cardOf(list, "document:D1"), card);
      assert.equal(card.querySelector(".card-stale-note")?.textContent, CARD_GONE_NOTE);
      for (const input of card.querySelectorAll<HTMLInputElement>("input")) {
        input.checked = false;
        input.value = "";
      }
      fillInbox(list, [entry("D2")], hooks);
      assert.equal(cardOf(list, "document:D1"), null);
    });
  }

  it("keeps a half-written answer without counting a departed ask as outstanding", async () => {
    const list = document.createElement("div");
    const q = question();
    assert.equal(fillInbox(list, [q, question(2)], hooks), 2);
    await settle();
    const card = cardOf(list, "jmarrero-forge/tracker#1")!;
    card.querySelector("textarea")!.value = "Left, because";
    assert.equal(fillInbox(list, [{ ...q, title: "Which way now?" }, question(2)], hooks), 2);
    assert.equal(cardOf(list, "jmarrero-forge/tracker#1"), card);
    assert.equal(card.querySelector("textarea")!.value, "Left, because");
    // The pass dropped it: retain his text, not the outstanding decision.
    assert.equal(fillInbox(list, [question(2)], hooks), 1);
    assert.equal(card.querySelector(".card-stale-note")?.textContent, CARD_GONE_NOTE);
    assert.equal(fillInbox(list, [question(2)], hooks, true), 1, "r drops it");
  });

  it("marks a card from a list that can't be read now", () => {
    const list = document.createElement("div");
    fillInbox(list, publishedCards(asks(rawAsk(1)), true), hooks);
    const card = cardOf(list, "jmarrero-forge/tracker#1")!;
    assert.ok(card.classList.contains(CARD_UNAVAILABLE_CLASS));
    assert.match(card.textContent!, /Unavailable: from the last list read/);
  });

  it("offers the pass's head without a drawing-time read", async () => {
    const head = "a".repeat(40);
    const approval = askCard(asks(rawAsk(4, { key: "up/proj#4", item: "up/proj#4", kind: "review-approve", action: { type: "approve_pull_request", repository: "up/proj", number: 4, head } }))[0]!);
    const list = document.createElement("div");
    fillInbox(list, [approval], { ...hooks, approve: async () => ({ pr: { owner: "up", repo: "proj", number: 4 }, status: "approved", url: "https://github.com/up/proj/pull/4#pullrequestreview-1" }) });
    await settle();
    assert.equal(list.querySelector("button")?.textContent, "Approve aaaaaaa");
  });

  it("doesn't redraw or move a card whose empty field has the focus", () => {
    const list = document.createElement("div");
    document.body.append(list);
    fillInbox(list, [entry("D1"), entry("D2")], hooks);
    const card = cardOf(list, "document:D2")!;
    const reply = card.querySelector<HTMLInputElement>("input[type=text]")!;
    reply.focus();
    fillInbox(list, [entry("D2", "Context changed.\n"), entry("D1", "Also changed.\n")], hooks);
    assert.equal(cardOf(list, "document:D2"), card);
    assert.equal(document.activeElement, reply);
    // D1 moved, around it.
    assert.deepEqual(keys(list), ["document:D2", "document:D1"]);
    assert.match(cardOf(list, "document:D1")!.textContent!, /Also changed/);
    list.remove();
  });

  it("places new cards around a kept draft without moving it", () => {
    const list = document.createElement("div");
    fillInbox(list, [entry("D2")], hooks);
    const card = cardOf(list, "document:D2")!;
    type(card);
    fillInbox(list, [entry("D1"), entry("D2"), entry("D3")], hooks);
    assert.deepEqual(keys(list), ["document:D1", "document:D2", "document:D3"]);
    assert.equal(cardOf(list, "document:D2"), card);
    function type(c: HTMLElement) { c.querySelector<HTMLInputElement>("input[type=text]")!.value = "x"; }
  });

  it("redraws a card once its form was sent", async () => {
    const list = document.createElement("div");
    fillInbox(list, [entry("D1")], hooks);
    const card = cardOf(list, "document:D1")!;
    card.querySelector<HTMLInputElement>("input[value=B]")!.checked = true;
    card.querySelector<HTMLInputElement>("input[type=text]")!.value = "later";
    card.querySelector("form")!.dispatchEvent(new win.Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(sent, ["D1 B later"]);
    assert.ok(!holdsDraft(card));
    const answered = documentCard(parseDocument("### D1 Pick one\n- [ ] A) This\n- [x] B) That\nReply: later\n")[0]!, undefined)!;
    fillInbox(list, [answered], hooks);
    assert.notEqual(cardOf(list, "document:D1"), card);
    assert.ok(cardOf(list, "document:D1")!.classList.contains("card-done"));
    assert.equal(cardOf(list, "document:D1")!.querySelector("form"), null);
  });

  it("draws the first page of cards, reading only their proposals, and the rest on Show more", () => {
    const read: number[] = [];
    const offerBody = async (a: Ask) => {
      read.push(a.action.comment!);
      return document.createElement("section");
    };
    const raw = Array.from({ length: INBOX_PAGE + 2 }, (_, i) => rawAsk(9, { key: `jmarrero-forge/tracker#9/comment-${i + 1}`, kind: "operator-action", action: { type: "operator_action", repository: "jmarrero-forge/tracker", number: 9, comment: i + 1 } }));
    const box = document.createElement("div");
    const list = document.createElement("div");
    box.append(list);
    assert.equal(fillInbox(list, publishedCards(asks(...raw)), { ...hooks, offerBody }), INBOX_PAGE + 2);
    assert.deepEqual([keys(list).length, read], [INBOX_PAGE, Array.from({ length: INBOX_PAGE }, (_, i) => i + 1)]);
    const more = box.querySelector<HTMLButtonElement>(".inbox-more")!;
    assert.equal(more.textContent, `Show 2 more · ${INBOX_PAGE} of ${INBOX_PAGE + 2} shown`);
    more.click();
    assert.deepEqual([keys(list).length, read.length, box.querySelector(".inbox-more")], [INBOX_PAGE + 2, INBOX_PAGE, null], "new cards do not inspect themselves");
    for (const fold of list.querySelectorAll<HTMLDetailsElement>(".card-full")) { fold.open = true; fold.dispatchEvent(new win.Event("toggle")); }
    assert.equal(read.length, INBOX_PAGE + 2);
  });
});

describe("card layout at phone and desktop widths (no layout engine)", () => {
  for (const width of [390, 1280]) it(`puts a card's actions on one row at ${width}px`, async () => {
    Object.defineProperty(win, "innerWidth", { value: width, configurable: true });
    const list = document.createElement("div");
    const link = askCard(asks(rawAsk(3, { key: "up/proj#3/digest", item: "up/proj#3", kind: "digest-stale", action: { type: "close_pull_request", repository: "up/proj", number: 3 } }))[0]!);
    fillInbox(list, [question(), link], hooks);
    await settle();
    for (const card of list.children) {
      assert.ok(card.querySelectorAll(".actions").length <= 1, "at most one action row");
      assert.equal(card.querySelector(".item-chat"), null, "no dead Chat control");
      assert.ok(card.querySelector("button[type=submit], a.action"));
    }
  });
});
