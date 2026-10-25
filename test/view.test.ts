// The views put untrusted board and issue text on screen: check that it
// lands as text or sanitized markdown, whatever it contains. And that
// each item offers the right action: an answer box only on questions,
// review and rerun actions only on those asks, and never "nothing to do"
// on a Needs human item.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { itemAction } from "../src/github/asks.ts";
import { type Item, queueItems } from "../src/github/board.ts";
import type { Context, RunStatus } from "../src/github/backend.ts";
import { createRenderer } from "../src/markdown.ts";
import { buildEntries, type Entry } from "../src/github/queue.ts";
import { age, answerState, type AnswerState, contextView, FILTERS_FOLDED_CLASS, type ItemViewHandlers, itemView, priorityList, sinceTitle, STALE_NOTE_CLASS, STATE_LABEL, tickAges } from "../src/github/view.ts";
import { h } from "../src/dom.ts";
import { installDom, rawItems } from "./helpers.ts";

const win = installDom();
const render = createRenderer(win as unknown as Parameters<typeof createRenderer>[0]);
const noSend: ItemViewHandlers = {
  send: async () => "https://github.com/x",
  comment: async () => "https://github.com/x",
  rerun: async () => "https://github.com/x",
};

const EVIL = '<img src=x onerror=alert(1)><script>alert(2)</script>[x](javascript:alert(3))';

function fixture(nodeId: string): Item {
  return queueItems(rawItems()).find((i) => i.nodeId === nodeId) as Item;
}

function evilItem(): Item {
  return {
    ...fixture("PVTI_synthetic_upstream_pr"),
    title: EVIL,
    why: EVIL,
    body: EVIL,
    org: EVIL,
    branch: ["https://ok.example/branch"],
    gist: ["javascript:alert(6)"],
    url: "javascript:alert(7)",
  };
}

function evilQuestion(): Item {
  return {
    ...fixture("PVTI_synthetic_question"),
    title: EVIL,
    body: `Blocks: javascript:alert(8)\n${EVIL}\nQ: ${EVIL}\nOptions:\nA) <b onclick=alert(4)>bold</b>\nB) javascript:alert(5)\nRecommended: A`,
  };
}

function assertNoActiveContent(root: Element): void {
  assert.equal(root.querySelectorAll("script, img, iframe, svg, style").length, 0, root.outerHTML);
  for (const el of root.querySelectorAll("*")) {
    for (const attr of el.getAttributeNames()) assert.ok(!/^on/i.test(attr), `${attr} on ${el.tagName}`);
    const href = el.getAttribute("href");
    if (href !== null) assert.match(href, /^(https:|#)/, `href ${href}`);
  }
}

describe("answerState", () => {
  const q = fixture("PVTI_synthetic_question");
  const cases: [string, Item, string[], string[], AnswerState][] = [
    ["an open question", q, [], [], undefined],
    ["answered on GitHub", q, [], [q.nodeId], "answered"],
    ["sent from here", q, [q.nodeId], [], "answered"],
    ["closed by the bot", fixture("PVTI_synthetic_closed_question"), [], [], "done"],
    ["another item, whatever the sets say", fixture("PVTI_synthetic_home_issue"), ["PVTI_synthetic_home_issue"], ["PVTI_synthetic_home_issue"], undefined],
  ];
  for (const [name, item, sent, answered, want] of cases) {
    it(name, () => assert.equal(answerState(item, new Set(sent), new Set(answered)), want));
  }
});

describe("priorityList", () => {
  const entriesOf = (items: Item[], answered = new Set<string>()) => buildEntries(items, [], new Map(), true, answered);
  const labels = (sent: Set<string>, answered: Set<string>) => (e: Entry) => {
    const st = e.item ? answerState(e.item, sent, answered) : undefined;
    return st ? { text: STATE_LABEL[st], cls: st } : undefined;
  };
  const items = () => [evilItem(), ...queueItems(rawItems()).slice(1)];

  it("ranks by priority, nests asks and shows untrusted text as text", () => {
    const root = priorityList(entriesOf(items()), labels(new Set(), new Set()), Date.parse("2026-02-01T00:00:00Z"));
    assertNoActiveContent(root);
    assert.deepEqual(
      [...root.querySelectorAll(".group-h")].map((e) => e.textContent),
      // The P1 epic ranks as P0 by its P0 question; counts include nested rows.
      ["P0 · 3", "P1 · 5", "P2 · 1", "No priority · 1", "Answered, waiting on the bot · 1"],
    );
    assert.ok(root.textContent?.includes("<script>alert(2)</script>"));
    const hrefs = (sel: string) => [...root.querySelectorAll(sel)].map((r) => r.getAttribute("href"));
    assert.deepEqual(hrefs(".row"), [
      "#item/PVTI_synthetic_draft",
      "#item/PVTI_synthetic_epic",
      "#item/PVTI_synthetic_question",
      "#item/PVTI_synthetic_upstream_pr",
      "#item/PVTI_synthetic_upstream_question",
      "#item/PVTI_synthetic_upstream_issue",
      "#item/PVTI_synthetic_review_ask",
      "#item/PVTI_synthetic_chore_ask",
      "#item/PVTI_synthetic_redacted",
      "#item/PVTI_synthetic_home_issue",
      "#item/PVTI_synthetic_closed_question",
    ]);
    assert.deepEqual(hrefs(".row.child"), [
      "#item/PVTI_synthetic_question",
      "#item/PVTI_synthetic_upstream_question",
      "#item/PVTI_synthetic_review_ask",
      "#item/PVTI_synthetic_chore_ask",
    ]);
    // Needs human items with no open ask are flagged, and only those.
    assert.deepEqual(hrefs(".row:has(.state.bug)"), ["#item/PVTI_synthetic_draft", "#item/PVTI_synthetic_redacted", "#item/PVTI_synthetic_home_issue"]);
    const row = (id: string) => root.querySelector(`.row[href="#item/${id}"]`);
    assert.equal(row("PVTI_synthetic_question")?.querySelector(".why")?.textContent, "Which prefix?");
    assert.match(row("PVTI_synthetic_closed_question")?.querySelector(".tag")?.textContent ?? "", /blocks jmarrero-bot\/elsewhere#5/);
    assert.equal(row("PVTI_synthetic_epic")?.querySelector(".tag")?.textContent, "jmarrero-forge/tracker#20 · 1/3 sub-issues done");
    assert.equal(row("PVTI_synthetic_review_ask")?.querySelector(".why")?.textContent, "Re-approve widget#50 at its new head, then the bot signs off");
    assert.equal(row("PVTI_synthetic_chore_ask")?.querySelector(".kind")?.textContent, "do");
    assert.match(root.querySelector(".summary.queue-summary")?.textContent ?? "", /0 PRs · 2 questions · 1 reviews · 1 chores · 3 without an ask/);
  });

  it("labels answered and closed questions", () => {
    const answered = new Set(["PVTI_synthetic_question"]);
    const root = priorityList(entriesOf(items(), answered), labels(new Set(["PVTI_synthetic_home_issue"]), answered));
    const states = [...root.querySelectorAll(".row")].flatMap((r) => {
      const s = r.querySelector(".state:not(.bug)")?.textContent;
      return s ? [[r.getAttribute("href"), s]] : [];
    });
    assert.deepEqual(states, [
      ["#item/PVTI_synthetic_question", "answered, waiting on the bot"],
      ["#item/PVTI_synthetic_closed_question", "closed by the bot"],
    ]);
    assert.match(root.querySelector(".summary")?.textContent ?? "", /1 questions/);
  });

  it("filters by org, with chips linking to filter tokens", () => {
    const entries = entriesOf(items());
    const root = priorityList(entries, labels(new Set(), new Set()), Date.now(), { scope: "infra" });
    assertNoActiveContent(root);
    const chipText = (sel: string) => [...root.querySelectorAll(sel)].map((c) => `${c.getAttribute("href")} ${c.textContent}`);
    assert.deepEqual(chipText(".chip.on"), ["#infra Our infra1"]);
    assert.equal(root.querySelector(".chip.on")?.getAttribute("aria-current"), "true");
    // The Org field's untrusted value isn't an org name, so the owner counts instead.
    assert.ok(chipText(".chip.org").some((t) => t.startsWith("#org:example-upstream ")));
    assert.ok(!root.textContent?.includes("<img"));
    const hrefs = [...root.querySelectorAll(".row")].map((r) => r.getAttribute("href"));
    // Tracker issues with no Org field or target label have no org, so only the bot's own repo is infra.
    assert.deepEqual(hrefs, ["#item/PVTI_synthetic_home_issue"]);

    const none = priorityList(entries, () => undefined, Date.now(), { scope: { org: "nobody" } });
    assert.match(none.textContent ?? "", /Nothing here matches this filter/);
    assert.equal(none.querySelectorAll(".chip.preset").length, 3);
    // The chosen org stays, so it can be cleared, and the message links to everything.
    assert.equal(none.querySelector(".chip.org.on")?.getAttribute("href"), "#all");
    assert.equal(none.querySelector(".empty a")?.getAttribute("href"), "#all");
  });

  it("folds the filter bar behind a button naming the active filter, and keeps it open across re-renders", () => {
    const entries = entriesOf(items());
    const render = () => priorityList(entries, labels(new Set(), new Set()), Date.now(), { scope: "composefs", priority: "P0" });
    const root = render();
    const bar = root.querySelector(".filters");
    const toggle = root.querySelector<HTMLButtonElement>(".filters-toggle");
    assert.equal(toggle?.textContent, "Filters (active: Composefs · P0)");
    assert.ok(bar?.classList.contains(FILTERS_FOLDED_CLASS));
    assert.equal(toggle?.getAttribute("aria-expanded"), "false");
    toggle?.click();
    assert.ok(!bar?.classList.contains(FILTERS_FOLDED_CLASS));
    // The next poll re-renders the queue: it stays open until folded again.
    const again = render();
    assert.ok(!again.querySelector(".filters")?.classList.contains(FILTERS_FOLDED_CLASS));
    again.querySelector<HTMLButtonElement>(".filters-toggle")?.click();
    assert.ok(render().querySelector(".filters")?.classList.contains(FILTERS_FOLDED_CLASS));
  });

  it("keeps each filter label separate from its wrapping chips", () => {
    const root = priorityList(entriesOf(items()), labels(new Set(), new Set()));
    const rows = [...root.querySelectorAll(".filters > .chips")];
    assert.deepEqual(rows.map((row) => row.querySelector(".chips-h")?.textContent), ["Show", "Org", "Priority"]);
    for (const row of rows) {
      assert.equal(row.children.length, 2);
      assert.ok(row.querySelector(":scope > .chips-list > .chip"));
      assert.equal(row.querySelector(":scope > .chip"), null);
    }
  });

  it("lists the settled and the bot's turns too: it is the whole queue", () => {
    assert.match(priorityList([], () => undefined).textContent ?? "", /Nothing is listed/);
    const entry = (key: string, settled: boolean): Entry => ({ key, kind: "question", title: key, where: "t#1", href: `#item/${key}`, settled });
    const botTurn: Entry = { key: "pr:o/r#1", kind: "pr", title: "t", where: "o/r#1", href: "#pr/o/r/1", wait: { reasons: [], onBot: true } };
    const root = priorityList([entry("PVTI_a", true), entry("PVTI_b", false), botTurn], () => undefined);
    assert.equal(root.querySelectorAll(".row").length, 3);
    assert.deepEqual([...root.querySelectorAll(".row")].map((r) => r.getAttribute("data-section")), ["priority", "priority", "priority"]);
  });

  it("names the board items it dropped as closed, whatever else it shows", () => {
    const merged: Item = { ...fixture("PVTI_synthetic_upstream_pr"), status: "Draft", state: "merged", title: EVIL, url: "javascript:alert(8)" };
    const listed = entriesOf(items());
    for (const entries of [[], listed]) {
      const root = priorityList(entries, labels(new Set(), new Set()), Date.now(), undefined, { stale: [merged] });
      const note = root.querySelector(`.${STALE_NOTE_CLASS}`);
      assert.match(note?.querySelector("summary")?.textContent ?? "", /Not listed: 1 board item closed or merged/);
      assert.equal(note?.querySelector("a"), null, "an unsafe URL stays text");
      assert.equal(note?.querySelector("img, script"), null);
    }
    assert.equal(priorityList(listed, () => undefined).querySelector(`.${STALE_NOTE_CLASS}`), null);
  });
});

describe("age", () => {
  const now = Date.parse("2026-01-15T12:00:00Z");
  const cases: [string | undefined, string][] = [
    [undefined, ""],
    ["not a date", ""],
    ["2026-01-15T11:59:50Z", "now"],
    ["2026-01-15T11:15:00Z", "45m"],
    ["2026-01-15T02:00:00Z", "10h"],
    ["2026-01-12T12:00:00Z", "3d"],
    ["2025-12-01T12:00:00Z", "6w"],
    ["2026-01-16T00:00:00Z", "now"],
  ];
  for (const [iso, want] of cases) it(String(iso), () => assert.equal(age(iso, now), want));
});

describe("tickAges", () => {
  it("moves the By priority rows' ages on with the Needs rows', without a redraw", () => {
    const since = "2026-01-15T11:00:00Z";
    const row: Entry = { key: "k", kind: "question", title: "t", where: "w", href: "#k", priority: "P1", since };
    const root = h("div", {}, priorityList([row], () => undefined, Date.parse("2026-01-15T11:30:00Z")), h("span", { class: "age", "data-since": since }, "30m"), h("span", { class: "age", "data-since": "not a date" }, "age unknown"));
    const ages = () => [...root.querySelectorAll(".age")].map((e) => e.textContent);
    assert.deepEqual(ages(), ["30m", "30m", "age unknown"]);
    tickAges(root, Date.parse("2026-01-15T14:00:00Z"));
    assert.deepEqual(ages(), ["3h", "3h", "age unknown"]);
  });
});

describe("sinceTitle", () => {
  const at = "2026-01-15T12:00:00Z";
  const entry = (kind: Entry["kind"]): Entry => ({ key: "k", kind, title: "t", where: "w", href: "#" });
  it("calls a board item's date its last change, not a wait", () => assert.match(sinceTitle(entry("item"), at), /^board item last changed /));
  it("keeps an ask's wait", () => assert.match(sinceTitle(entry("question"), at, "asked"), /^asked /));
  it("is empty without a date", () => assert.equal(sinceTitle(entry("item"), undefined), ""));
});

describe("itemView", () => {
  const ctx: Context = {
    warnings: [EVIL],
    comments: [
      { author: "jmarrero-bot", createdAt: "2026-01-01T00:00:00Z", url: "https://github.com/c/0", body: "Asked." },
      { author: "jmarrero", createdAt: "2026-01-01T00:00:00Z", url: "https://github.com/c/1", body: "B\nfine" },
      { author: "someone", createdAt: "2026-01-02T00:00:00Z", url: "javascript:alert(8)", body: EVIL },
    ],
    gists: [
      {
        url: "https://gist.github.com/abc",
        owner: EVIL,
        files: [
          { name: "notes.md", content: EVIL, truncated: false },
          { name: "log.txt", content: EVIL, truncated: true },
        ],
      },
    ],
  };
  const ask = (key: string, kind: Entry["kind"], title: string, state = "open"): Entry => ({
    key,
    kind,
    title,
    where: "",
    href: `#item/${key}`,
    item: { ...fixture("PVTI_synthetic_review_ask"), nodeId: key, state, body: `Ask: ${title}`, labels: [kind] },
  });
  const view = (item: Item, state: AnswerState = undefined, handlers: Partial<ItemViewHandlers> = {}, asks: Entry[] = [], context: Context = ctx) =>
    itemView(
      item,
      { action: itemAction(item, asks.filter((a) => a.item?.state !== "closed").length), context, state, asks },
      render,
      { ...noSend, ...handlers },
    );

  it("renders every untrusted field safely", () => {
    for (const item of [evilItem(), evilQuestion()]) {
      const root = view(item);
      assertNoActiveContent(root);
      assert.equal(root.querySelector("h2")?.textContent, EVIL);
      assert.equal(root.querySelector("pre")?.textContent, EVIL);
    }
  });

  it("shows an upstream Needs human item's asks as actions, never nothing to do", () => {
    const item = fixture("PVTI_synthetic_upstream_pr");
    const root = view(item, undefined, {}, [ask("R", "review", "Re-approve widget#50"), ask("C", "chore", "Rerun the arm legs")]);
    assert.equal(root.querySelector("form"), null);
    assert.doesNotMatch(root.textContent ?? "", /Nothing to/);
    assert.equal(root.querySelector(".links a")?.textContent, "example-upstream/widget#42: act on GitHub");
    assert.equal(root.querySelector(".asks h3")?.textContent, "What the bot asks of you");
    assert.deepEqual(
      [...root.querySelectorAll(".asks li")].map((li) => [li.querySelector(".kind")?.textContent, li.querySelector("a")?.getAttribute("href"), li.querySelector("a")?.textContent]),
      [
        ["rev", "#item/R", "Re-approve widget#50"],
        ["do", "#item/C", "Rerun the arm legs"],
      ],
    );
    // Not an ask, so his comment there is not an answer.
    assert.equal(root.querySelectorAll(".comment.your-answer").length, 0);
  });

  it("calls a Needs human item without an open ask a bot bug", () => {
    for (const asks of [[], [ask("C", "chore", "done already", "closed")]]) {
      const root = view(fixture("PVTI_synthetic_upstream_issue"), undefined, {}, asks);
      assert.match(root.querySelector(".warn.bug")?.textContent ?? "", /^The bot left this without an ask/);
      assert.doesNotMatch(root.textContent ?? "", /Nothing to/);
      assert.match(root.textContent ?? "", /Re-approve the fix PR/);
      assert.equal(root.querySelector("form"), null);
    }
  });

  it("offers a review ask's PR in the review pane, and a comment box", () => {
    const root = view(fixture("PVTI_synthetic_review_ask"));
    const a = root.querySelector(".review-asks a");
    assert.equal(a?.getAttribute("href"), "#pr/example-upstream/widget/50");
    assert.equal(a?.textContent, `Review example-upstream/widget#50 at ${"a".repeat(12)}`);
    assert.match(root.querySelector(".ask")?.textContent ?? "", /^Ask: Re-approve widget#50/);
    assert.match(root.querySelector(".comment-ask .target")?.textContent ?? "", /comment as you on jmarrero-forge\/tracker#24/);
    assert.equal(root.querySelector(".hdr .tag")?.textContent?.includes("review"), true);
  });

  it("sends a chore comment, refusing command lines", async () => {
    const sent: string[] = [];
    const item = { ...fixture("PVTI_synthetic_chore_ask"), body: "Blocks: `https://github.com/o/r/issues/1`\nAsk: Log in and approve the key" };
    const root = view(item, undefined, {
      comment: async (t) => {
        const { formatComment } = await import("../src/answer.ts");
        formatComment(t);
        sent.push(t);
        return "https://github.com/c";
      },
    });
    win.document.body.replaceChildren(root);
    assert.equal(root.querySelector(".runs"), null);
    const submit = async (text: string) => {
      (root.querySelector(".comment-ask textarea") as HTMLTextAreaElement).value = text;
      root.querySelector(".comment-ask")?.dispatchEvent(new win.Event("submit", { cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
    };
    const status = () => root.querySelector(".comment-ask .status")?.textContent ?? "";
    await submit("done\n/ready");
    assert.match(status(), /^Not sent: .*bot command/);
    await submit("Done, approved it.");
    assert.deepEqual(sent, ["Done, approved it."]);
    assert.match(status(), /^Sent: https:\/\/github\.com\/c/);
  });

  it("says why a review it can't read falls back to a comment box", () => {
    const item = { ...fixture("PVTI_synthetic_review_ask"), body: "Ask: Re-approve\nReview: `https://github.com/o/r/pull/1` at aec657dd" };
    const root = view(item);
    assert.match(root.querySelector(".warn")?.textContent ?? "", /can't offer this review's action: can't read "Review:/);
    assert.equal(root.querySelector(".review-asks"), null);
    assert.ok(root.querySelector(".comment-ask"));
  });

  describe("a rerun chore's runs", () => {
    const RUN = "https://github.com/example-upstream/widget/actions/runs/777";
    const run = (over: Partial<RunStatus> = {}): RunStatus => ({
      run: { url: RUN, owner: "example-upstream", repo: "widget", id: "777" },
      name: "CI",
      status: "completed",
      conclusion: "failure",
      failed: [{ name: "uki (arm)", url: `${RUN}/job/2` }, { name: EVIL }],
      ...over,
    });
    function runs(r: RunStatus, rerun?: (url: string) => Promise<string>, rerunning?: (url: string) => boolean) {
      const item = fixture("PVTI_synthetic_chore_ask");
      const hooks = { ...(rerun ? { rerun } : {}), ...(rerunning ? { rerunning } : {}) };
      const frag = contextView(item, { comments: [], gists: [], warnings: [], runs: [r] }, render, hooks);
      const root = win.document.createElement("div");
      root.append(frag);
      win.document.body.replaceChildren(root);
      const button = root.querySelector(".runs button") as HTMLButtonElement;
      return { root, button, status: () => root.querySelector(".runs .status")?.textContent ?? "" };
    }

    it("lists failed jobs as text, with a rerun button", () => {
      const { root, button } = runs(run(), async () => "x");
      assertNoActiveContent(root);
      assert.deepEqual([...root.querySelectorAll(".jobs li")].map((li) => li.textContent), ["uki (arm)", EVIL]);
      assert.equal(button.disabled, false);
    });

    it("reruns only after he confirms, then shows the comment", async () => {
      const reran: string[] = [];
      const confirms: string[] = [];
      let answer = false;
      Object.assign(win, { confirm: (m: string) => (confirms.push(m), answer) });
      const { button, status } = runs(run(), async (u) => (reran.push(u), "https://github.com/jmarrero-forge/tracker/issues/25#c1"));
      button.click();
      await new Promise((r) => setTimeout(r, 0));
      assert.deepEqual(reran, []);
      assert.match(confirms[0] ?? "", /Rerun the 2 failed jobs \(uki \(arm\), .*\) of .*runs\/777\?.*your token to write to example-upstream\/widget/s);
      answer = true;
      button.click();
      await new Promise((r) => setTimeout(r, 0));
      assert.deepEqual(reran, [RUN]);
      assert.match(status(), /^Rerun started; told the bot: https:/);
      assert.equal(button.disabled, true);
    });

    it("offers no rerun for a run GitHub says can't be rerun", () => {
      const { root, button } = runs(run({ status: "in_progress", problem: "the run is in_progress, not completed" }), async () => "x");
      assert.equal(button.disabled, true);
      assert.match(root.textContent ?? "", /Can't rerun: the run is in_progress, not completed/);
    });

    it("keeps a rerun in flight disabled, even in a fresh render", async () => {
      let asked = 0;
      Object.assign(win, { confirm: () => (asked++, true) });
      const { button, status } = runs(run(), async () => "x", (u) => u === RUN);
      assert.equal(button.disabled, true);
      assert.equal(status(), "Rerunning…");
      button.click();
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(asked, 0);
    });

    it("names the run's commit, and warns when it is older than the PR's head", () => {
      const confirms: string[] = [];
      Object.assign(win, { confirm: (m: string) => (confirms.push(m), false) });
      const current = runs(run({ headSha: "1".repeat(40), prHead: "1".repeat(40) }), async () => "x");
      assert.equal(current.root.querySelector(".runs .warn"), null);
      assert.match(current.root.querySelector(".runs .tag")?.textContent ?? "", /on 111111111111/);
      current.button.click();
      assert.match(confirms[0] ?? "", /of .*runs\/777 on 111111111111\?/);
      assert.doesNotMatch(confirms[0] ?? "", /older head/);
      const old = runs(run({ headSha: "1".repeat(40), prHead: "2".repeat(40) }), async () => "x");
      assert.match(old.root.querySelector(".runs .warn")?.textContent ?? "", /This run is on 111111111111, an older head: the PR is now at 222222222222/);
      old.button.click();
      assert.match(confirms[1] ?? "", /an older head: the PR is now at 222222222222/);
    });

    it("says it may have rerun, and offers no blind retry, when unsure", async () => {
      Object.assign(win, { confirm: () => true });
      const unsure = Object.assign(new Error("the rerun request for x may or may not have gone out (Failed to fetch); check the run on GitHub before trying again"), { name: "MaybeSentError" });
      const { button, status } = runs(run(), async () => Promise.reject(unsure));
      button.click();
      await new Promise((r) => setTimeout(r, 0));
      assert.match(status(), /^Unsure whether it reran: .*check the run on GitHub/);
      assert.equal(button.disabled, true);
      const refused = runs(run(), async () => Promise.reject(new Error("POST x failed with HTTP 403")));
      refused.button.click();
      await new Promise((r) => setTimeout(r, 0));
      assert.match(refused.status(), /^Not rerun: POST x failed with HTTP 403/);
      assert.equal(refused.button.disabled, false);
    });

    it("offers no rerun without a handler", () => {
      assert.equal(runs(run()).button.disabled, true);
    });
  });

  it("offers a question's options, recommendation first, and names the issue", () => {
    const root = view(fixture("PVTI_synthetic_question"));
    const radios = [...root.querySelectorAll<HTMLInputElement>("input[type=radio]")].map((r) => r.value);
    assert.deepEqual(radios, ["A", "B"]);
    assert.equal(root.querySelector("label[for=opt-A] .rec")?.textContent, "recommended");
    assert.equal(root.querySelector("label[for=opt-B] .rec"), null);
    assert.match(root.querySelector(".target")?.textContent ?? "", /comment as you on jmarrero-forge\/tracker#21; the bot acts on it and closes the issue/);
    assert.deepEqual([...root.querySelectorAll(".links a")].map((a) => a.textContent).slice(0, 2), ["jmarrero-forge/tracker#21", "blocks"]);
    assert.equal(root.querySelector(".comment.your-answer .meta")?.textContent?.endsWith("your answer: B"), true);
  });

  it("shows a parent's sub-issue tree, linking those on the board to the app", () => {
    const epic = fixture("PVTI_synthetic_epic");
    const sub = (number: number, state: string, labels: string[] = [], title = `sub ${number}`) => ({
      ref: { owner: "jmarrero-forge", repo: "tracker", number },
      url: `https://github.com/jmarrero-forge/tracker/issues/${number}`,
      title,
      state,
      labels,
    });
    const context: Context = {
      comments: [],
      gists: [],
      warnings: [],
      subIssues: [sub(21, "open", ["question"]), { ...sub(30, "closed"), progress: { total: 2, completed: 2, percent_completed: 100 } }, sub(31, "open", [], EVIL)],
    };
    const boardHref = (r: { number: number }) => (r.number === 21 ? "#item/PVTI_synthetic_question" : undefined);
    // The epic has an open question nested under it.
    const asks: Entry[] = [{ key: "q", kind: "question", title: "q", where: "", href: "#item/q", item: fixture("PVTI_synthetic_question") }];
    const root = itemView(epic, { action: itemAction(epic, 1), context, state: undefined, asks, hooks: { boardHref } }, render, noSend);
    assertNoActiveContent(root);
    assert.match(root.querySelector(".hdr .tag")?.textContent ?? "", /1\/3 sub-issues done$/);
    assert.equal(root.querySelector(".sub-issues h3")?.textContent, "Sub-issues · 1/3 sub-issues done (33%)");
    const lis = [...root.querySelectorAll(".sub-issues li")];
    assert.deepEqual(
      lis.map((li) => [li.className, li.querySelector("a")?.getAttribute("href"), li.querySelector(".tag")?.textContent]),
      [
        ["sub-issue open", "#item/PVTI_synthetic_question", "jmarrero-forge/tracker#21 · question"],
        ["sub-issue closed", "https://github.com/jmarrero-forge/tracker/issues/30", "jmarrero-forge/tracker#30 · 2/2 sub-issues done"],
        ["sub-issue open", "https://github.com/jmarrero-forge/tracker/issues/31", "jmarrero-forge/tracker#31"],
      ],
    );
    assert.equal(lis[2]?.querySelector("a")?.textContent, EVIL);
  });

  it("warns when the question's options don't read as one per line", () => {
    const note = (item: Item) => [...view(item).querySelectorAll(".warn")].map((w) => w.textContent ?? "").filter((t) => /options can't/.test(t));
    const wrapped = { ...fixture("PVTI_synthetic_question"), body: "Q: which?\nOptions:\nA) one\nB) the second,\nwrapped" };
    assert.match(note(wrapped)[0] ?? "", /options can't all be offered: .*may be a wrapped option.*answer in your own words/);
    const lone = { ...fixture("PVTI_synthetic_question"), body: "Q: which?\nOptions:\nA) the first,\nwrapped\nB) the second" };
    assert.match(note(lone)[0] ?? "", /only one option/);
    assert.deepEqual(note(fixture("PVTI_synthetic_question")), []);
  });

  it("links the blocked item, bare or in backticks", () => {
    const blocksLink = (id: string) =>
      [...view(fixture(id)).querySelectorAll(".links a")].find((a) => a.textContent === "blocks")?.getAttribute("href");
    assert.equal(blocksLink("PVTI_synthetic_question"), "https://github.com/jmarrero-forge/tracker/issues/20");
    assert.equal(blocksLink("PVTI_synthetic_upstream_question"), "https://github.com/example-upstream/widget/pull/42");
  });

  it("shows a closed question as done, with nothing to send", () => {
    const root = view(fixture("PVTI_synthetic_closed_question"), "done");
    assert.equal(root.querySelector("form"), null);
    assert.match(root.textContent ?? "", /The bot acted on this and closed it/);
  });

  function answering(send: (a: unknown) => Promise<string>, state: AnswerState = undefined) {
    const root = view(fixture("PVTI_synthetic_question"), state, { send: send as ItemViewHandlers["send"] });
    win.document.body.replaceChildren(root);
    const submit = async (letter: string | undefined, text: string) => {
      const b = letter ? root.querySelector<HTMLInputElement>(`input[value=${letter}]`) : null;
      if (b) b.checked = true;
      const ta = root.querySelector("textarea");
      if (ta) ta.value = text;
      root.querySelector("form")?.dispatchEvent(new win.Event("submit", { cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
    };
    const button = () => root.querySelector<HTMLButtonElement>("button[type=submit]") as HTMLButtonElement;
    const status = () => root.querySelector(".status")?.textContent ?? "";
    return { root, submit, button, status };
  }

  it("sends the picked option and text, then stays disabled", async () => {
    const sent: unknown[] = [];
    const v = answering(async (a) => {
      sent.push(a);
      return "https://github.com/done";
    });
    await v.submit("B", "because");
    assert.deepEqual(sent, [{ choice: "B", text: "because" }]);
    assert.match(v.status(), /^Sent: https:\/\/github\.com\/done/);
    assert.equal(v.button().disabled, true);
  });

  it("shows a refusal and lets him fix it", async () => {
    const v = answering(async (a) => {
      const { formatAnswer } = await import("../src/answer.ts");
      formatAnswer(a as Parameters<typeof formatAnswer>[0]);
      return "https://github.com/done";
    });
    await v.submit("A", "ok\n/promote");
    assert.match(v.status(), /^Not sent: .*would be read as a bot command/);
    assert.equal(v.button().disabled, false);
  });

  it("asks before answering an answered question again", async () => {
    const sent: unknown[] = [];
    const confirms: string[] = [];
    Object.assign(win, { confirm: (m: string) => (confirms.push(m), false) });
    const v = answering(async (a) => (sent.push(a), "https://github.com/x"), "answered");
    assert.match(v.root.textContent ?? "", /You answered; it stays in the queue/);
    await v.submit("A", "");
    assert.deepEqual(sent, []);
    assert.match(confirms[0] ?? "", /already answered/);
  });
});
