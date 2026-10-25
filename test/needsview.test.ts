// The rows of "Needs you": the action each asks for, the inline answer,
// and untrusted text staying text.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Answer, formatAnswer } from "../src/answer.ts";
import { type Item } from "../src/github/board.ts";
import { ALL_PRIORITIES, buildNeeds, filterNeeds, type Need, priorityChips } from "../src/github/needs.ts";
import { applyPriority, NEED_FILTERED_CLASS, NEEDS_CHANGED_NOTE, needId, type NeedsForm, type NeedsHooks, needRow, needsHead, needsRedraw, needsSignature } from "../src/github/needsview.ts";
import { loadNeedsPriority, saveNeedsPriority } from "../src/github/store.ts";
import type { ForgePr } from "../src/github/forge.ts";
import { buildEntries, type Entry } from "../src/github/queue.ts";
import { parseDecision } from "../src/github/triage.ts";
import { createRenderer } from "../src/markdown.ts";
import { installDom } from "./helpers.ts";

const win = installDom();
const render = createRenderer(win as unknown as Parameters<typeof createRenderer>[0]);
const TRACKER = "https://github.com/jmarrero-forge/tracker/issues";
const EVIL = "<img src=x onerror=alert(1)><script>alert(2)</script>[x](javascript:alert(3))";
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, " ").trim() ?? "";

function tracked(nodeId: string, number: number, over: Partial<Item> = {}): Item {
  return {
    id: 0, nodeId, kind: "issue", title: nodeId, body: "", why: "", branch: [], gist: [], labels: [], status: "Needs human",
    url: `${TRACKER}/${number}`, ref: { owner: "jmarrero-forge", repo: "tracker", number }, state: "open", author: "jmarrero-bot", assignees: ["jmarrero"], ...over,
  };
}

const hooks = (sent: [string, Answer][] = [], login: string | undefined = "jmarrero"): NeedsHooks => ({
  login,
  now: Date.parse("2026-02-01T00:00:00Z"),
  render,
  labelOf: () => undefined,
  send: async (n, a) => (sent.push([n.key, a]), "https://github.com/c/1"),
});

const BODY = "Blocks: https://github.com/jmarrero-forge/tracker/issues/9\nQ: Which prefix?\nOptions:\nA) this\nB) that\nRecommended: A, because it is safer\n";
const first = (items: Item[]): Need => buildNeeds({ entries: buildEntries(items, [], new Map(), true) })[0] as Need;

describe("needsRedraw", () => {
  const typed: NeedsForm = { sent: false, text: "my answer", picked: false };
  const picked: NeedsForm = { sent: false, text: "", picked: true };
  const policy = (forms: readonly NeedsForm[], over: Partial<Parameters<typeof needsRedraw>[0]> = {}) => needsRedraw({
    signature: "new", previousSignature: "old", forms, note: undefined, force: false, ...over,
  });

  it("skips an unchanged signature before checking drafts, keeping the notice", () => {
    for (const note of [undefined, NEEDS_CHANGED_NOTE, "Another notice"]) {
      assert.deepEqual(policy([typed, picked], { signature: "old", note }), { action: "skip", note });
    }
  });

  it("defers changed rows for either typed text or a selected radio, with the guard note", () => {
    for (const form of [typed, picked]) {
      assert.deepEqual(policy([form]), { action: "defer", note: NEEDS_CHANGED_NOTE });
    }
  });

  it("redraws changed rows without a draft and clears only the guard note", () => {
    const forms: NeedsForm[] = [{ sent: false, text: " \n\t", picked: false }, { sent: true, text: "sent answer", picked: true }];
    assert.deepEqual(policy(forms, { note: NEEDS_CHANGED_NOTE }), { action: "redraw", note: undefined });
    assert.deepEqual(policy([], { note: "Another notice" }), { action: "redraw", note: "Another notice" });
  });

  it("force bypasses both the draft guard and signature equality", () => {
    for (const signature of ["old", "new"]) {
      assert.deepEqual(policy([typed, picked], { force: true, signature, note: NEEDS_CHANGED_NOTE }), { action: "redraw", note: undefined });
    }
    assert.deepEqual(policy([typed], { force: true, note: "Another notice" }), { action: "redraw", note: "Another notice" });
  });
});

describe("needsSignature", () => {
  it("keeps the ask time, not the age label, so an age tick neither redraws nor claims a change", () => {
    const since = "2026-02-01T10:00:00Z";
    const entry = first([tracked("PVTI_q", 21, { labels: ["question"], body: BODY })]);
    // The concrete ask's age takes precedence over the PR/item creation age.
    const n: Need = { ...entry, since, entry: { ...entry.entry!, since: "2026-01-01T00:00:00Z" } };
    const before = { ...hooks(), now: Date.parse(since) + 10 * 60_000 };
    const after = { ...before, now: before.now + 60_000 };
    assert.equal(needRow(n, before).querySelector(".age")?.textContent, "10m");
    assert.equal(needRow(n, after).querySelector(".age")?.textContent, "11m");
    const previousSignature = needsSignature([n], before);
    const signature = needsSignature([n], after);
    assert.equal(JSON.parse(signature)[1][0].at(-1), since);
    assert.equal(signature, previousSignature);
    const forms = [{ sent: false, text: "half an answer", picked: false }];
    assert.deepEqual(needsRedraw({ signature, previousSignature, forms, note: undefined, force: false }), { action: "skip", note: undefined });
    // A new ask time is a change, and is still held back under a draft.
    const later = needsSignature([{ ...n, since: "2026-02-01T10:05:00Z" }], after);
    assert.notEqual(later, previousSignature);
    assert.deepEqual(needsRedraw({ signature: later, previousSignature, forms, note: undefined, force: false }), { action: "defer", note: NEEDS_CHANGED_NOTE });
  });

  it("uses the need's ask time for a decision without an entry", () => {
    const d = parseDecision(tracked("I_7", 7, { title: "D3: Promote?", body: BODY, labels: ["question", "decision"], createdAt: "2026-01-31T00:00:00Z" }));
    const needs = buildNeeds({ entries: [], decisions: [d] });
    const view = hooks();
    assert.equal(needRow(needs[0]!, view).querySelector(".age")?.textContent, "1d");
    assert.equal(JSON.parse(needsSignature(needs, view))[1][0].at(-1), "2026-01-31T00:00:00Z");
  });
});

describe("needRow", () => {
  it("answers a question in its row, with its options, and sends the answer as the need", async () => {
    const sent: [string, Answer][] = [];
    const n = first([tracked("PVTI_q", 21, { labels: ["question"], body: BODY, priority: "P0", title: "Prefix?" })]);
    const row = needRow(n, hooks(sent));
    assert.equal(row.getAttribute("data-section"), "needs");
    assert.equal(row.getAttribute("data-key"), "item:PVTI_q");
    assert.equal(row.id, needId(n));
    // The question leads, in the title's place; the issue's title and one small line follow.
    assert.equal(text(row.querySelector(".title")), "Which prefix?");
    assert.equal(text(row.querySelector(".why")), "Prefix?");
    assert.equal(text(row.querySelector(".sub")), "P0tracker#21 · age unknown");
    assert.equal(row.querySelector(".sub a")?.getAttribute("href"), `${TRACKER}/21`);
    assert.equal(row.querySelector(".action"), null, "the form is the action");
    assert.equal(text(row.querySelector(".blocks")), "Blocks: tracker#9");
    assert.match(text(row), /Recommended: A, because it is safer/);
    const radios = [...row.querySelectorAll<HTMLInputElement>("input[type=radio]")];
    assert.deepEqual(radios.map((r) => r.id), ["n21-opt-A", "n21-opt-B"]);
    // Real radios, each in its label, the recommended one marked but not picked for him.
    assert.deepEqual(radios.map((r) => text(r.closest("label"))), ["A) this recommended", "B) that"]);
    assert.deepEqual(radios.map((r) => r.closest("label")?.getAttribute("for")), radios.map((r) => r.id));
    assert.deepEqual(radios.map((r) => r.checked), [false, false]);
    assert.equal(row.querySelector("textarea")?.getAttribute("rows"), "2");
    assert.equal(text(row.querySelector("button[type=submit]")), "Send answer");
    (row.querySelector("#n21-opt-B") as HTMLInputElement).checked = true;
    (row.querySelector("textarea") as HTMLTextAreaElement).value = "ship it";
    row.querySelector("form")?.dispatchEvent(new win.Event("submit", { cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(sent, [["item:PVTI_q", { text: "ship it", choice: "B" }]]);
    assert.match(text(row.querySelector(".status")), /Sent:/);
    assert.equal(row.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled, true);
  });

  // What the form hands to send() is what postAnswer formats into the comment.
  const posted = async (body: string, fill: (row: HTMLElement) => void): Promise<string[]> => {
    const sent: [string, Answer][] = [];
    const row = needRow(first([tracked("PVTI_q", 21, { labels: ["question"], body })]), hooks(sent));
    fill(row);
    row.querySelector("form")?.dispatchEvent(new win.Event("submit", { cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    return [...sent.map(([, a]) => formatAnswer(a)), text(row.querySelector(".status"))];
  };
  const pick = (letter: string) => (row: HTMLElement) => ((row.querySelector(`#n21-opt-${letter}`) as HTMLInputElement).checked = true);
  const write = (value: string) => (row: HTMLElement) => ((row.querySelector("textarea") as HTMLTextAreaElement).value = value);
  const NO_Q = `Blocks: ${TRACKER}/100\n\nOne stale PR is left.\n\nOptions:\nA) Close it.\nB) Keep it open.\n\nRecommended: A. Nothing depends on it.\n`;
  const comments: [string, string, (row: HTMLElement) => void, string[]][] = [
    ["a pick alone is the letter on a line", BODY, pick("A"), ["A\n", "Sent: https://github.com/c/1"]],
    ["a pick with a note is the letter, then the note", BODY, (r) => (pick("B")(r), write("  not yet\nsee #3 ")(r)), ["B\nnot yet\nsee #3\n", "Sent: https://github.com/c/1"]],
    ["a question without Q: offers its options too", NO_Q, pick("B"), ["B\n", "Sent: https://github.com/c/1"]],
    ["a question without options takes text", "Q: Which name?\n", write("widget"), ["widget\n", "Sent: https://github.com/c/1"]],
    ["nothing picked or written is not sent", BODY, () => {}, ["Pick an option or write an answer."]],
  ];
  for (const [name, body, fill, want] of comments) {
    it(`posts: ${name}`, async () => assert.deepEqual(await posted(body, fill), want));
  }

  it("leads with the Why's question when the body has no Q: line, as the bot writes it", () => {
    const n = first([tracked("PVTI_q", 130, { labels: ["question"], body: NO_Q, title: "Stale bot PR: close or keep?", why: "Q: close the stale PR? Rec A.", priority: "P2", org: "jmarrero-bot", createdAt: "2026-01-18T00:00:00Z" })]);
    const row = needRow(n, hooks());
    assert.equal(text(row.querySelector(".title")), "close the stale PR? Rec A.");
    assert.equal(text(row.querySelector(".why")), "Stale bot PR: close or keep?");
    assert.equal(text(row.querySelector(".sub")), "P2tracker#130 · jmarrero-bot · 2w");
    assert.equal(row.querySelectorAll("input[type=radio]").length, 2);
    assert.equal(row.getAttribute("data-priority"), "P2");
  });

  it("offers no form to anyone else, and none on what is not a question", () => {
    const q = first([tracked("PVTI_q", 21, { labels: ["question"], body: BODY })]);
    const other = needRow(q, hooks([], "someone"));
    assert.equal(other.querySelector("form"), null);
    // Why is said once over the rows (needsHead), not in each.
    assert.doesNotMatch(text(other), /Only jmarrero answers/);
    assert.equal(other.querySelector("a.action")?.textContent, "Answer");
    // A token GitHub hasn't named may be his: the form is there.
    assert.ok(needRow(q, { ...hooks(), login: undefined }).querySelector("form.answer"));
    const review = first([tracked("PVTI_r", 22, { labels: ["escalate"], body: "Ask: Look at it\n" })]);
    const row = needRow(review, hooks());
    assert.equal(row.querySelector("form"), null);
    const action = row.querySelector<HTMLAnchorElement>("a.action");
    assert.equal(action?.getAttribute("href"), `${TRACKER}/22`);
    assert.equal(action?.textContent, "Write text");
  });

  it("labels a decision with its D-number, unblocks and whole question, and dims one answered here", () => {
    const body = `Unblocks:\n- https://github.com/jmarrero-forge/bootc/pull/15\n\n${BODY}`;
    const d = parseDecision(tracked("I_7", 7, { title: "D3: Promote?", body, labels: ["question", "decision"] }));
    const n = buildNeeds({ entries: [], decisions: [d] })[0] as Need;
    const row = needRow(n, hooks());
    assert.equal(text(row.querySelector(".dec-id")), "D3");
    assert.match(text(row.querySelector("details.unblocks summary")), /Unblocks 1/);
    assert.deepEqual([...row.querySelectorAll("details.unblocks a")].map((a) => a.textContent), ["forge bootc#15"]);
    assert.match(text(row.querySelector("details.dec-body summary")), /The whole question/);
    const done = needRow({ ...n, done: true }, hooks());
    assert.ok(done.classList.contains("need-done"));
    assert.equal(done.querySelector("form"), null);
    assert.match(text(done.querySelector(".state")), /answered, waiting on the bot/);
  });

  it("puts untrusted text on screen as text", () => {
    const body = `Blocks: ${TRACKER}/9\nQ: ${EVIL}\nOptions:\nA) ${EVIL}\nB) javascript:alert(5)\n${EVIL}`;
    const n = first([tracked("PVTI_q", 21, { labels: ["question"], body, title: EVIL })]);
    const row = needRow(n, hooks());
    assert.equal(row.querySelectorAll("script, img, iframe, svg, style").length, 0, row.outerHTML);
    for (const el of row.querySelectorAll("*")) {
      for (const attr of el.getAttributeNames()) assert.ok(!/^on/i.test(attr), `${attr} on ${el.tagName}`);
      const href = el.getAttribute("href");
      if (href !== null) assert.match(href, /^(https:|#)/, `href ${href}`);
    }
    assert.ok(row.textContent?.includes("<script>alert(2)</script>"));
  });

  it("does not invent a decision for an item with no ask", () => {
    assert.equal(first([tracked("PVTI_lonely", 30)]), undefined);
  });
});

describe("needId", () => {
  it("keeps keys that differ apart", () => {
    const n = (key: string) => needId({ key } as Need);
    assert.notEqual(n("pr:a/b-c#1"), n("pr:a-b/c#1"));
    assert.match(n("pr:a/b#1"), /^need-[A-Za-z0-9_-]+$/);
  });
});

describe("the bar over the rows", () => {
  const q = (n: number, priority?: string, over: Partial<Item> = {}) => tracked(`PVTI_q${n}`, n, { labels: ["question"], body: BODY, createdAt: `2026-01-${10 + n}T00:00:00Z`, ...(priority ? { priority } : {}), ...over });
  const needs = buildNeeds({ entries: buildEntries([q(1, "P2"), q(2, "P0"), q(3, "P2"), q(4), q(5, "P1")], [], new Map(), true) });
  const chips = (root: Element) => [...root.querySelectorAll(".needs-filter button")].map((b) => `${text(b)}${b.getAttribute("aria-pressed") === "true" ? "*" : ""}`);

  it("counts the waiting rows per priority, offering P0 to P2 always and others only when used", () => {
    const summary = (list: readonly Need[], selected?: string) => priorityChips(list, selected).map((c) => `${c.priority}:${c.count}`);
    assert.deepEqual(summary(needs), ["all:5", "P0:1", "P1:1", "P2:2", "No priority:1"]);
    assert.deepEqual(summary([]), ["all:0", "P0:0", "P1:0", "P2:0"]);
    assert.deepEqual(summary(needs.map((n) => ({ ...n, done: n.priority === "P2" }))), ["all:3", "P0:1", "P1:1", "P2:0", "No priority:1"]);
    // A remembered choice nothing has any more can still be seen, and undone.
    assert.deepEqual(summary(needs.slice(0, 1), "P3"), ["all:1", "P0:1", "P1:0", "P2:0", "P3:0"]);
  });

  it("keeps the order: P0 first, then newest within a priority", () => {
    assert.deepEqual(needs.map((n) => `${n.priority ?? "-"} ${n.where.split("#")[1]}`), ["P0 2", "P1 5", "P2 3", "P2 1", "- 4"]);
    assert.deepEqual(filterNeeds(needs, "P2").map((n) => n.key), ["item:PVTI_q3", "item:PVTI_q1"]);
    assert.equal(filterNeeds(needs, ALL_PRIORITIES).length, 5);
    assert.deepEqual(filterNeeds(needs, "No priority").map((n) => n.key), ["item:PVTI_q4"]);
  });

  it("filters the rows as drawn, keeping what is written in them, and tells the page", () => {
    const picked: string[] = [];
    const view: NeedsHooks = { ...hooks(), priority: "P2", pickPriority: (p) => picked.push(p) };
    const slot = document.createElement("div");
    slot.append(needsHead(needs, view, slot), ...needs.map((n) => needRow(n, view)));
    applyPriority(slot, "P2");
    const shown = () => [...slot.querySelectorAll(".need")].filter((r) => !r.classList.contains(NEED_FILTERED_CLASS)).map((r) => r.getAttribute("data-key"));
    assert.deepEqual(chips(slot), ["All 5", "P0 1", "P1 1", "P2 2*", "None 1"]);
    assert.deepEqual(shown(), ["item:PVTI_q3", "item:PVTI_q1"]);
    assert.equal(slot.querySelector(".needs-filter")?.getAttribute("role"), "group");
    assert.equal(slot.querySelector(".needs-filter button")?.getAttribute("aria-label"), "All priorities: 5 waiting");
    const draft = slot.querySelector<HTMLTextAreaElement>(`.need:not(.${NEED_FILTERED_CLASS}) textarea`)!;
    draft.value = "half written";
    const rows = [...slot.querySelectorAll(".need")];
    (slot.querySelectorAll<HTMLButtonElement>(".needs-filter button")[1] as HTMLButtonElement).click();
    assert.deepEqual(chips(slot), ["All 5", "P0 1*", "P1 1", "P2 2", "None 1"]);
    assert.deepEqual(shown(), ["item:PVTI_q2"]);
    (slot.querySelectorAll<HTMLButtonElement>(".needs-filter button")[0] as HTMLButtonElement).click();
    assert.equal(shown().length, 5);
    assert.deepEqual(picked, ["P0", ALL_PRIORITIES]);
    assert.deepEqual([...slot.querySelectorAll(".need")], rows, "the rows are the same nodes");
    assert.equal(draft.value, "half written");
    assert.equal(slot.querySelector<HTMLElement>(".needs-none")?.hidden, true);
  });

  it("says so when nothing waits at the chosen priority", () => {
    const slot = document.createElement("div");
    const view: NeedsHooks = { ...hooks(), priority: "P1" };
    const only = needs.filter((n) => n.priority === "P2");
    slot.append(needsHead(only, view, slot), ...only.map((n) => needRow(n, view)));
    applyPriority(slot, "P1");
    assert.equal(slot.querySelectorAll(`.need.${NEED_FILTERED_CLASS}`).length, 2);
    const none = slot.querySelector<HTMLElement>(".needs-none")!;
    assert.equal(none.hidden, false);
    assert.equal(text(none), "Nothing waits on you at P1.");
  });

  it("says once who answers: nothing to jmarrero, the login to anyone else, and how to check for an unnamed token", () => {
    const who = (view: NeedsHooks) => text(needsHead(needs, view, document.createElement("div")).querySelector(".who"));
    assert.equal(who(hooks()), "");
    assert.equal(who(hooks([], "someone")), "Only jmarrero answers; you are signed in as someone.");
    let checked = 0;
    const unnamed: NeedsHooks = { ...hooks(), login: undefined, loginError: `GET /user failed <b onclick="x">`, checkLogin: () => checked++ };
    const head = needsHead(needs, unnamed, document.createElement("div"));
    assert.equal(text(head.querySelector(".who")), `GitHub hasn't confirmed whose token this is (GET /user failed <b onclick="x">). An answer is posted as the token's owner, and the bot acts only on answers from jmarrero. Check again`);
    assert.equal(head.querySelector(".who b"), null);
    head.querySelector<HTMLButtonElement>(".who button")?.click();
    assert.equal(checked, 1);
    // Nothing to answer in place: nothing to say.
    assert.equal(text(needsHead(needs.map((n) => ({ ...n, inPlace: false })), hooks([], "someone"), document.createElement("div")).querySelector(".who")), "");
  });

  it("redraws when GitHub names the token", () => {
    const unnamed = { ...hooks(), login: undefined, loginError: "offline" };
    assert.notEqual(needsSignature(needs, unnamed), needsSignature(needs, hooks()));
    assert.notEqual(needsSignature(needs, unnamed), needsSignature(needs, { ...unnamed, loginError: "timeout" }));
  });

  it("remembers the chosen priority per viewer, and survives storage that is missing, blocked or holds junk", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v), removeItem: (k: string) => void values.delete(k) };
    const g = globalThis as { localStorage?: unknown };
    const before = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    try {
      Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
      assert.equal(loadNeedsPriority(), ALL_PRIORITIES);
      for (const p of ["P0", "No priority", ALL_PRIORITIES]) {
        saveNeedsPriority(p);
        assert.equal(loadNeedsPriority(), p);
      }
      for (const junk of ['"<script>"', "{", "7", '"p0"']) {
        values.set("review.needs.priority", junk);
        assert.equal(loadNeedsPriority(), ALL_PRIORITIES, junk);
      }
      Object.defineProperty(globalThis, "localStorage", { get: () => { throw new Error("blocked"); }, configurable: true });
      saveNeedsPriority("P1");
      assert.equal(loadNeedsPriority(), ALL_PRIORITIES);
    } finally {
      if (before) Object.defineProperty(globalThis, "localStorage", before);
      else delete g.localStorage;
    }
  });
});

describe("needRow location", () => {
  const upstreamPr: ForgePr = {
    ref: { owner: "upstream", repo: "widget", number: 2500 }, url: "https://github.com/upstream/widget/pull/2500", title: "Fix the widget", body: "",
    author: "jmarrero-bot", createdAt: "2026-01-10T00:00:00Z", updatedAt: "2026-01-11T00:00:00Z", draft: false,
  };
  const reviewEntry = (item: Item | undefined): Entry => ({
    key: "pr:upstream/widget#2500", kind: "pr", pr: upstreamPr, title: upstreamPr.title, where: "upstream/widget#2500", href: "#pr/upstream/widget/2500",
    wait: { reasons: ["review-requested"], onBot: false }, ...(item ? { item } : {}),
  });
  const tag = (e: Entry) => needRow(buildNeeds({ entries: [e] })[0]!, hooks()).querySelector(".tag")!;
  const links = (el: Element) => [...el.querySelectorAll("a")].map((a) => [text(a), a.getAttribute("href")]);

  it("links a PR row to the PR, and its tracking issue as a labelled second link", () => {
    const el = tag(reviewEntry(tracked("PVTI_t", 123, { org: "upstream" })));
    assert.deepEqual(links(el), [["upstream/widget#2500", upstreamPr.url], ["tracker#123", `${TRACKER}/123`]]);
    assert.match(text(el), /^upstream\/widget#2500 · tracks tracker#123 · age unknown$/);
    // A board Org other than the PR's owner is still shown.
    assert.match(text(tag(reviewEntry(tracked("PVTI_t", 123, { org: "containers" })))), /^upstream\/widget#2500 · tracks tracker#123 · containers · /);
  });

  it("keeps the issue as the location of an escalation row", () => {
    const el = needRow(first([tracked("PVTI_e", 31, { labels: ["escalate"], org: "containers" })]), hooks()).querySelector(".tag")!;
    assert.deepEqual(links(el), [["tracker#31", `${TRACKER}/31`]]);
    assert.match(text(el), /^tracker#31 · containers · /);
  });

  it("does not repeat the PR when its board item is the PR itself", () => {
    const el = tag(reviewEntry(tracked("PVTI_s", 1, { kind: "pr", url: upstreamPr.url.toUpperCase() })));
    assert.deepEqual(links(el), [["upstream/widget#2500", upstreamPr.url]]);
  });

  it("links a PR row without a board item to the PR", () => {
    assert.deepEqual(links(tag(reviewEntry(undefined))), [["upstream/widget#2500", upstreamPr.url]]);
  });

  it("keeps the issue as the location of a question row", () => {
    const el = needRow(first([tracked("PVTI_q", 21, { labels: ["question"], body: BODY, org: "jmarrero-bot" })]), hooks()).querySelector(".tag")!;
    assert.deepEqual(links(el), [["tracker#21", `${TRACKER}/21`]]);
    assert.match(text(el), /^tracker#21 · jmarrero-bot · /);
  });
});
