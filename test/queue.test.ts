import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Item, NO_PRIORITY } from "../src/github/board.ts";
import type { ForgePr, Verdict } from "../src/github/forge.ts";
import { buildEntries, effectivePriority, type Entry, groupRanked, ON_BOT_GROUP, onBot, priorityRank, rankEntries, SETTLED_GROUP, staleItems } from "../src/github/queue.ts";
import type { PrWait } from "../src/github/waiting.ts";

function item(nodeId: string, over: Partial<Item> = {}): Item {
  return { id: 0, nodeId, kind: "draft", title: nodeId, body: "", why: "", branch: [], gist: [], labels: [], assignees: [], status: "Needs human", ...over };
}

const TRACKER = "https://github.com/jmarrero-forge/tracker/issues";

/** A tracker issue on the board. */
function tracked(nodeId: string, number: number, over: Partial<Item> = {}): Item {
  return item(nodeId, { kind: "issue", url: `${TRACKER}/${number}`, ref: { owner: "jmarrero-forge", repo: "tracker", number }, state: "open", ...over });
}

/** A question issue in the tracker blocking `blocks`. */
function question(nodeId: string, number: number, blocks: string, over: Partial<Item> = {}): Item {
  return tracked(nodeId, number, { labels: ["question"], body: `Blocks: ${blocks}\nQ: which?\nOptions:\nA) this\nB) that\n`, ...over });
}

function pr(owner: string, repo: string, number: number, over: Partial<ForgePr> = {}): ForgePr {
  return {
    ref: { owner, repo, number },
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    title: `${repo} #${number}`,
    body: "",
    author: "jmarrero-bot",
    createdAt: "2026-01-10T00:00:00Z",
    updatedAt: "2026-01-11T00:00:00Z",
    draft: true,
    ...over,
  };
}

const meta = (item: string) =>
  `Text\n\n<!-- bot-meta -->\n---\n- Upstream: \`up/r\`, base \`main\`\n- Board item: \`${item}\`\n<!-- /bot-meta -->`;

describe("priorityRank", () => {
  const cases: [string | undefined, number][] = [["P0", 0], ["P2", 2], ["P3", 3], ["P9", 4], [undefined, 5]];
  for (const [p, want] of cases) it(String(p), () => assert.equal(priorityRank(p), want));
});

describe("rankEntries", () => {
  it("puts P0 first, then the oldest, undated last, then by key", () => {
    const e = (key: string, priority?: string, since?: string): Entry => ({
      key, kind: "chore", title: key, where: "", href: "#",
      ...(priority ? { priority } : {}),
      ...(since ? { since } : {}),
    });
    const ranked = rankEntries([
      e("new-p1", "P1", "2026-03-01T00:00:00Z"),
      e("none", undefined, "2020-01-01T00:00:00Z"),
      e("old-p1", "P1", "2026-01-01T00:00:00Z"),
      e("undated-p1", "P1"),
      e("bad-date-p1", "P1", "yesterday"),
      e("p0", "P0", "2026-06-01T00:00:00Z"),
      e("odd", "P7", "2026-01-01T00:00:00Z"),
    ]);
    assert.deepEqual(ranked.map((x) => x.key), ["p0", "old-p1", "new-p1", "bad-date-p1", "undated-p1", "odd", "none"]);
    assert.deepEqual(groupRanked(ranked).map((g) => [g.priority, g.entries.length]), [["P0", 1], ["P1", 4], ["P7", 1], ["No priority", 1]]);
  });

  it("puts settled entries last, under their own heading", () => {
    const e = (key: string, priority: string, settled: boolean): Entry => ({ key, kind: "question", title: key, where: "", href: "#", priority, settled });
    const ranked = rankEntries([e("done-p0", "P0", true), e("p2", "P2", false), e("p1", "P1", false), e("done-p1", "P1", true)]);
    assert.deepEqual(ranked.map((x) => x.key), ["p1", "p2", "done-p0", "done-p1"]);
    assert.deepEqual(groupRanked(ranked).map((g) => [g.priority, g.entries.length]), [["P1", 1], ["P2", 1], [SETTLED_GROUP, 2]]);
  });
});

describe("buildEntries", () => {
  const verdicts = (pairs: [string, Verdict["state"]][]) => new Map(pairs.map(([k, state]) => [k, { state }]));

  it("ages and ranks a board item by its last move, an ask by its creation", () => {
    const items = [
      // Filed in July, moved to Needs human yesterday: it hasn't waited 14 weeks.
      tracked("PVTI_epic", 30, { priority: "P1", createdAt: "2026-07-01T00:00:00Z", movedAt: "2026-10-20T00:00:00Z" }),
      tracked("PVTI_mid", 31, { priority: "P1", createdAt: "2026-10-10T00:00:00Z", movedAt: "2026-10-12T00:00:00Z" }),
      // Never age an item by its issue: no board timestamp is age unknown.
      tracked("PVTI_nodate", 32, { priority: "P1", createdAt: "2026-06-01T00:00:00Z" }),
      question("PVTI_ask", 33, "https://github.com/elsewhere/r/issues/1", { priority: "P1", createdAt: "2026-10-15T00:00:00Z", movedAt: "2026-10-21T00:00:00Z" }),
    ];
    const entries = buildEntries(items, [], new Map());
    assert.deepEqual(
      entries.map((e) => [e.key, e.since]),
      [
        ["item:PVTI_mid", "2026-10-12T00:00:00Z"],
        ["item:PVTI_ask", "2026-10-15T00:00:00Z"],
        ["item:PVTI_epic", "2026-10-20T00:00:00Z"],
        ["item:PVTI_nodate", undefined],
      ],
    );
  });

  it("merges board items and forge PRs into one ranked list", () => {
    const items = [
      question("PVTI_q", 2, "https://github.com/elsewhere/r/issues/1", { priority: "P1", createdAt: "2026-01-05T00:00:00Z" }),
      item("PVTI_chore", { why: "Please rerun the job", priority: "P0", movedAt: "2026-02-01T00:00:00Z" }),
      item("PVTI_trackmeta", { status: "Draft", priority: "P0", branch: [] }),
      item("PVTI_trackbranch", { status: "Draft", priority: "P2", branch: ["https://github.com/jmarrero-forge/b/pull/2"] }),
      item("PVTI_stale", { status: "Draft", priority: "P0", branch: ["https://github.com/jmarrero-forge/c/pull/9"] }),
      item("PVTI_gist", { status: "Draft", priority: "P1", gist: ["https://gist.github.com/x/1"], movedAt: "2026-01-01T00:00:00Z" }),
      item("PVTI_todo", { status: "Todo", priority: "P0" }),
    ];
    const prs = [
      pr("jmarrero-forge", "a", 1, { body: meta("PVTI_trackmeta"), createdAt: "2026-01-20T00:00:00Z" }),
      pr("jmarrero-forge", "b", 2),
      pr("jmarrero-forge", "untracked", 3),
    ];
    const entries = buildEntries(items, prs, verdicts([]));
    assert.deepEqual(
      entries.map((e) => [e.key, e.kind, e.priority ?? "-"]),
      [
        ["pr:jmarrero-forge/a#1", "pr", "P0"],
        ["item:PVTI_chore", "item", "P0"],
        ["item:PVTI_gist", "item", "P1"],
        ["item:PVTI_q", "question", "P1"],
        ["pr:jmarrero-forge/b#2", "pr", "P2"],
        ["pr:jmarrero-forge/untracked#3", "pr", "-"],
      ],
    );
    const first = entries[0];
    assert.equal(first?.href, "#pr/jmarrero-forge/a/1");
    assert.equal(first?.item?.nodeId, "PVTI_trackmeta");
    assert.equal(entries.find((e) => e.kind === "question")?.href, "#item/PVTI_q");
  });

  it("keeps a PR while it waits on him, lists it apart while it waits on the bot, and drops it and its Draft item otherwise", () => {
    const items = [item("PVTI_t", { status: "Draft", priority: "P0", branch: ["https://github.com/jmarrero-forge/a/pull/1"] })];
    // verdict, whether the bot replied since, listed, on the bot
    const cases: [Verdict["state"], boolean, boolean, boolean][] = [
      ["none", false, true, false],
      ["approved-older", false, true, false],
      ["changes-requested-older", false, true, false],
      ["approved", false, false, false],
      ["changes-requested", false, true, true],
      ["changes-requested", true, true, false],
      ["promoted", false, true, false],
    ];
    for (const [state, replied, listed, bot] of cases) {
      const name = `${state}, replied: ${replied}`;
      const entries = buildEntries(items, [pr("jmarrero-forge", "a", 1)], verdicts([["jmarrero-forge/a#1", state]]), true, new Set(), {
        replied: new Set(replied ? ["jmarrero-forge/a#1"] : []),
      });
      assert.deepEqual(entries.map((e) => e.key), listed ? ["pr:jmarrero-forge/a#1"] : [], name);
      if (!listed) continue;
      assert.equal(entries[0]?.verdict?.state, state);
      assert.equal(onBot(entries[0] as Entry), bot, name);
      assert.deepEqual(groupRanked(entries).map((g) => g.priority), [bot ? ON_BOT_GROUP : "P0"], name);
    }
  });

  it("keeps a Needs human item about a forge PR as its own entry", () => {
    const items = [item("PVTI_nh", { branch: ["https://github.com/jmarrero-forge/a/pull/1"], why: "Please look" })];
    const keys = buildEntries(items, [pr("jmarrero-forge", "a", 1)], verdicts([])).map((e) => e.key);
    assert.deepEqual(keys.sort(), ["item:PVTI_nh", "pr:jmarrero-forge/a#1"]);
  });

  it("takes ask kinds from tracker issues' labels only", () => {
    const items = [
      question("PVTI_q", 1, `${TRACKER}/9`),
      tracked("PVTI_rev", 3, { labels: ["review"], body: `Blocks: ${TRACKER}/9` }),
      tracked("PVTI_do", 4, { labels: ["chore"], body: `Blocks: ${TRACKER}/9` }),
      tracked("PVTI_both", 5, { labels: ["chore", "review"] }),
      tracked("PVTI_plain", 2, { why: "Options:\nA) x\nB) y" }),
      item("PVTI_upstream", { kind: "pr", ref: { owner: "up", repo: "r", number: 1 }, labels: ["question"] }),
      item("PVTI_draft", { body: "Options:\nA) x\nB) y" }),
    ];
    assert.deepEqual(
      buildEntries(items, [], verdicts([])).map((e) => [e.key, e.kind]).sort(),
      [
        ["item:PVTI_both", "item"],
        ["item:PVTI_do", "chore"],
        ["item:PVTI_draft", "item"],
        ["item:PVTI_plain", "item"],
        ["item:PVTI_q", "question"],
        ["item:PVTI_rev", "review"],
        ["item:PVTI_upstream", "item"],
      ],
    );
  });

  it("nests every kind of ask under the item it blocks, and flags Needs human items left without one", () => {
    const upstream = "https://github.com/example-upstream/widget/issues/7";
    const items = [
      item("PVTI_up", { kind: "issue", url: upstream, ref: { owner: "example-upstream", repo: "widget", number: 7 }, priority: "P1" }),
      tracked("PVTI_rev", 24, { labels: ["review"], body: `Blocks: \`${upstream}\`` }),
      tracked("PVTI_do", 25, { labels: ["chore"], body: `Blocks: \`${upstream}\`` }),
      item("PVTI_lonely", { kind: "issue", ref: { owner: "example-upstream", repo: "widget", number: 8 } }),
      item("PVTI_gist", { status: "Draft", gist: ["https://gist.github.com/x/1"] }),
      // Only a closed ask left: still a bug.
      item("PVTI_stale", { kind: "issue", ref: { owner: "example-upstream", repo: "widget", number: 9 } }),
      tracked("PVTI_old", 26, { labels: ["chore"], state: "closed", body: "Blocks: `https://github.com/example-upstream/widget/issues/9`" }),
    ];
    const entries = buildEntries(items, [], verdicts([]));
    assert.deepEqual(
      entries.map((e) => [e.key, e.children?.map((c) => c.kind) ?? [], e.bug ?? false]),
      [
        ["item:PVTI_up", ["chore", "review"], false],
        ["item:PVTI_gist", [], false],
        ["item:PVTI_lonely", [], true],
        ["item:PVTI_stale", ["chore"], true],
      ],
    );
  });

  it("settles questions he answered or the bot closed", () => {
    const items = [
      question("PVTI_open", 1, `${TRACKER}/9`, { priority: "P2" }),
      question("PVTI_answered", 2, `${TRACKER}/9`, { priority: "P0" }),
      question("PVTI_closed", 3, `${TRACKER}/9`, { priority: "P0", state: "closed" }),
    ];
    const entries = buildEntries(items, [], verdicts([]), true, new Set(["PVTI_answered"]));
    assert.deepEqual(entries.map((e) => [e.key, e.settled ?? false]), [
      ["item:PVTI_open", false],
      ["item:PVTI_answered", true],
      ["item:PVTI_closed", true],
    ]);
  });

  it("nests a question under the listed item it blocks", () => {
    const upstream = "https://github.com/example-upstream/widget/pull/42";
    const items = [
      tracked("PVTI_epic", 20, { priority: "P2" }),
      // A sub-issue of the epic, whatever its Blocks: line says.
      question("PVTI_sub", 21, "https://github.com/o/r/issues/1", { parent: { owner: "jmarrero-forge", repo: "tracker", number: 20 }, priority: "P0" }),
      question("PVTI_sub2", 25, `${TRACKER}/20`, { priority: "P1" }),
      item("PVTI_up", { kind: "pr", url: upstream, ref: { owner: "example-upstream", repo: "widget", number: 42 }, priority: "P1" }),
      question("PVTI_upq", 22, upstream),
      // The blocked item isn't in the queue: top-level, noting it.
      question("PVTI_lone", 23, `${TRACKER}/99`, { priority: "P3" }),
      // Questions don't nest under questions.
      question("PVTI_qq", 24, `${TRACKER}/23`, { priority: "P3" }),
    ];
    const entries = buildEntries(items, [], verdicts([]));
    const shape = (es: readonly Entry[]): unknown[] => es.map((e) => (e.children ? [e.key, shape(e.children)] : e.key));
    // The P2 epic ranks as P0 by its P0 sub-issue question.
    assert.deepEqual(shape(entries), [
      ["item:PVTI_epic", ["item:PVTI_sub", "item:PVTI_sub2"]],
      ["item:PVTI_up", ["item:PVTI_upq"]],
      "item:PVTI_lone",
      "item:PVTI_qq",
    ]);
    assert.equal(entries.find((e) => e.key === "item:PVTI_lone")?.blocks, "jmarrero-forge/tracker#99");
    assert.equal(entries.find((e) => e.key === "item:PVTI_qq")?.blocks, "jmarrero-forge/tracker#23");
    assert.equal(entries.find((e) => e.key === "item:PVTI_up")?.blocks, undefined);
  });

  it("nests a question blocking a tracker issue under the forge PR that folded in its Draft item", () => {
    const items = [
      tracked("PVTI_task", 30, { status: "Draft", priority: "P2", branch: ["https://github.com/jmarrero-forge/a/pull/1"] }),
      question("PVTI_sub", 31, `${TRACKER}/30`, { parent: { owner: "jmarrero-forge", repo: "tracker", number: 30 } }),
      question("PVTI_blocks", 32, `${TRACKER}/30`),
      // Needs human, so not folded into its forge PR: its question nests
      // under its own entry, not the PR's.
      tracked("PVTI_nh", 40),
      question("PVTI_nhq", 41, `${TRACKER}/40`, { parent: { owner: "jmarrero-forge", repo: "tracker", number: 40 } }),
    ];
    const prs = [pr("jmarrero-forge", "a", 1), pr("jmarrero-forge", "b", 2, { body: meta("PVTI_nh") })];
    const entries = buildEntries(items, prs, verdicts([]));
    assert.deepEqual(entries.map((e) => [e.key, e.item?.nodeId, e.children?.map((c) => c.key)]), [
      ["pr:jmarrero-forge/a#1", "PVTI_task", ["item:PVTI_blocks", "item:PVTI_sub"]],
      ["pr:jmarrero-forge/b#2", "PVTI_nh", undefined],
      ["item:PVTI_nh", "PVTI_nh", ["item:PVTI_nhq"]],
    ]);
  });

  it("ranks a parent by its most urgent open question, keeping its own priority", () => {
    const items = [
      tracked("PVTI_parent", 20, { priority: "P2", createdAt: "2026-01-01T00:00:00Z" }),
      question("PVTI_p0", 21, `${TRACKER}/20`, { priority: "P0" }),
      question("PVTI_p3", 22, `${TRACKER}/20`, { priority: "P3" }),
      tracked("PVTI_p1", 23, { priority: "P1" }),
      tracked("PVTI_quiet", 24, { priority: "P3" }),
      question("PVTI_answered_p0", 25, `${TRACKER}/24`, { priority: "P0" }),
    ];
    const entries = buildEntries(items, [], verdicts([]), true, new Set(["PVTI_answered_p0"]));
    assert.deepEqual(entries.map((e) => [e.key, e.priority, effectivePriority(e)]), [
      ["item:PVTI_parent", "P2", "P0"],
      ["item:PVTI_p1", "P1", "P1"],
      // An answered question doesn't raise its parent.
      ["item:PVTI_quiet", "P3", "P3"],
    ]);
    assert.deepEqual(groupRanked(entries).map((g) => [g.priority, g.entries.length]), [["P0", 1], ["P1", 1], ["P3", 1]]);
  });

  it("nests a question blocking a forge PR under the PR", () => {
    const items = [question("PVTI_q", 1, "https://github.com/jmarrero-forge/a/pull/1")];
    const entries = buildEntries(items, [pr("jmarrero-forge", "a", 1)], verdicts([]));
    assert.deepEqual(entries.map((e) => [e.key, e.children?.map((c) => c.key)]), [["pr:jmarrero-forge/a#1", ["item:PVTI_q"]]]);
  });

  it("drops no forge-only Draft item before the forge was read", () => {
    const items = [item("PVTI_f", { status: "Draft", branch: ["https://github.com/jmarrero-forge/a/pull/1"] })];
    assert.deepEqual(buildEntries(items, [], verdicts([])).length, 0);
    assert.deepEqual(buildEntries(items, [], verdicts([]), false).map((e) => [e.key, e.kind]), [["item:PVTI_f", "item"]]);
  });

  it("keeps a Draft item whose Branch is not only forge PRs", () => {
    const items = [item("PVTI_up", { status: "Draft", branch: ["https://github.com/up/r/compare/main...jmarrero-bot:bot/x"] })];
    assert.deepEqual(buildEntries(items, [], verdicts([])).map((e) => e.kind), ["item"]);
  });

  describe("the bot's PRs other than the forge's drafts", () => {
    const UP = "https://github.com/bootc-dev/bootc/pull";
    const up = (n: number, over: Partial<ForgePr> = {}) => pr("bootc-dev", "bootc", n, { draft: false, createdAt: `2026-02-0${n % 10}T00:00:00Z`, ...over });
    const wait = (reasons: PrWait["reasons"], onBotToo = false): PrWait => ({ reasons, onBot: onBotToo });

    it("lists each as classified, ranked by the board item holding it in Branch, those waiting on the bot last", () => {
      const items = [
        // Needs human about #3: folded into its PR, its question nested there.
        item("PVTI_nh3", { priority: "P1", branch: [`${UP}/3`] }),
        question("PVTI_q3", 30, "https://github.com/jmarrero-bot/homegit/pull/9", { priority: "P1" }),
        tracked("PVTI_t5", 5, { priority: "P2", branch: [`${UP}/5`] }),
        question("PVTI_q5", 31, `${TRACKER}/5`, { priority: "P2" }),
      ];
      const linked = [item("PVTI_ir1", { status: "In Review", priority: "P0", org: "bootc-dev", branch: [`${UP}/1`] })];
      const others = [
        { pr: up(1), wait: wait(["resign"]) },
        { pr: up(2), wait: wait(["rerun"]) },
        { pr: up(3), wait: wait(["review-requested"]) },
        { pr: pr("jmarrero-bot", "homegit", 9, { draft: false }), wait: wait([], true) },
        { pr: up(4, { title: "no item" }), wait: wait(["updated"]) },
      ];
      const entries = buildEntries(items, [], verdicts([]), true, new Set(), { others, linked });
      assert.deepEqual(
        entries.map((e) => [e.key, e.priority ?? "-", e.wait?.reasons.join(","), e.children?.map((c) => c.key)]),
        [
          ["pr:bootc-dev/bootc#1", "P0", "resign", undefined],
          ["pr:bootc-dev/bootc#3", "P1", "review-requested", undefined],
          // A question about a PR waiting on the bot isn't nested under it: it is his.
          ["item:PVTI_q3", "P1", undefined, undefined],
          ["item:PVTI_t5", "P2", undefined, ["item:PVTI_q5"]],
          ["pr:bootc-dev/bootc#2", "-", "rerun", undefined],
          ["pr:bootc-dev/bootc#4", "-", "updated", undefined],
          ["pr:jmarrero-bot/homegit#9", "-", "", undefined],
        ],
      );
      const byKey = new Map(entries.map((e) => [e.key, e]));
      assert.equal(byKey.get("pr:bootc-dev/bootc#3")?.item?.nodeId, "PVTI_nh3");
      assert.equal(byKey.get("pr:bootc-dev/bootc#1")?.item?.nodeId, "PVTI_ir1", "an In Review item ranks its PR");
      assert.ok(!entries.some((e) => e.key === "item:PVTI_nh3"), "a Needs human item whose PR waits on him isn't listed twice");
      assert.ok(!entries.some((e) => e.bug), "nor flagged as left without an ask");
      assert.deepEqual(groupRanked(entries).map((g) => g.priority), ["P0", "P1", "P2", NO_PRIORITY, ON_BOT_GROUP]);
    });

    it("keeps an ask about a PR under the PR's entry", () => {
      const items = [
        item("PVTI_nh", { priority: "P1", branch: [`${UP}/7`] }),
        tracked("PVTI_rev", 40, { labels: ["review"], body: `Blocks: ${UP}/7\nAsk: Re-approve\n` }),
      ];
      const entries = buildEntries(items, [], verdicts([]), true, new Set(), { others: [{ pr: up(7), wait: wait(["resign"]) }] });
      assert.deepEqual(entries.map((e) => [e.key, e.children?.map((c) => c.key)]), [["pr:bootc-dev/bootc#7", ["item:PVTI_rev"]]]);
    });

    it("leaves a Needs human item whose PR waits on the bot as its own entry", () => {
      const items = [item("PVTI_nh", { priority: "P1", branch: [`${UP}/7`] })];
      const entries = buildEntries(items, [], verdicts([]), true, new Set(), { others: [{ pr: up(7), wait: wait([], true) }] });
      assert.deepEqual(entries.map((e) => [e.key, e.bug === true]), [["item:PVTI_nh", true], ["pr:bootc-dev/bootc#7", false]]);
    });

    it("never lists a forge PR twice", () => {
      const forge = pr("jmarrero-forge", "a", 1);
      const entries = buildEntries([], [forge], verdicts([]), true, new Set(), { others: [{ pr: forge, wait: wait(["review-requested"]) }] });
      assert.deepEqual(entries.map((e) => e.key), ["pr:jmarrero-forge/a#1"]);
    });
  });
});

describe("board items that are behind GitHub", () => {
  const HOMEGIT = "https://github.com/jmarrero-bot/homegit/pull";
  const SANDBOX = "https://github.com/jmarrero-forge/jmarrero-devspace-sandbox/pull";
  /** A board item that is a PR itself, as bot-land adds the bot's own. */
  const prItem = (nodeId: string, url: string, over: Partial<Item> = {}): Item => {
    const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(url);
    return item(nodeId, { kind: "pr", url, ref: { owner: m?.[1] ?? "", repo: m?.[2] ?? "", number: Number(m?.[3]) }, state: "open", status: "Draft", priority: "P0", ...over });
  };
  const sandbox9 = pr("jmarrero-forge", "jmarrero-devspace-sandbox", 9);
  const review = (p: ForgePr, onBot = false) => ({ pr: { ...p, draft: false }, wait: { reasons: onBot ? [] : (["review-requested"] as PrWait["reasons"]), onBot } });

  // name, items, forge PRs, other PRs, the entries [key, kind, item it carries], the stale items
  const cases: [string, Item[], ForgePr[], ReturnType<typeof review>[], [string, string, string | undefined][], string[]][] = [
    [
      "a merged PR still Draft on the board is dropped, and named as stale",
      [prItem("PVTI_h77", `${HOMEGIT}/77`, { state: "merged" })],
      [],
      [],
      [],
      ["PVTI_h77"],
    ],
    [
      "a closed issue still Needs human is dropped too",
      [tracked("PVTI_done", 5, { state: "closed", why: "done" })],
      [],
      [],
      [],
      ["PVTI_done"],
    ],
    [
      "a closed ask stays, settled, and isn't stale",
      [question("PVTI_q", 6, `${TRACKER}/1`, { state: "closed" })],
      [],
      [],
      [["item:PVTI_q", "question", "PVTI_q"]],
      [],
    ],
    [
      "a forge PR on the board as itself, and in a tracker item's Branch, is one entry",
      [
        tracked("PVTI_t60", 60, { status: "Draft", priority: "P0", branch: [`${HOMEGIT}/77`, `${SANDBOX}/9`] }),
        prItem("PVTI_s9", `${SANDBOX}/9`),
        prItem("PVTI_h77", `${HOMEGIT}/77`, { state: "merged" }),
      ],
      [sandbox9],
      [],
      [["pr:jmarrero-forge/jmarrero-devspace-sandbox#9", "pr", "PVTI_t60"]],
      ["PVTI_h77"],
    ],
    [
      "a forge PR on the board only as itself takes its priority from it",
      [prItem("PVTI_s9", `${SANDBOX}/9`, { priority: "P1" })],
      [sandbox9],
      [],
      [["pr:jmarrero-forge/jmarrero-devspace-sandbox#9", "pr", "PVTI_s9"]],
      [],
    ],
    [
      "the bot's own PR requesting his review is one entry, not also an item",
      [prItem("PVTI_p4", "https://github.com/jmarrero-bot/praxis-credential-broker/pull/4")],
      [],
      [review(pr("jmarrero-bot", "praxis-credential-broker", 4))],
      [["pr:jmarrero-bot/praxis-credential-broker#4", "pr", "PVTI_p4"]],
      [],
    ],
    [
      "so is one whose Draft tracker item holds it in Branch",
      [tracked("PVTI_t1", 1, { status: "Draft", branch: [`${HOMEGIT}/80`] })],
      [],
      [review(pr("jmarrero-bot", "homegit", 80))],
      [["pr:jmarrero-bot/homegit#80", "pr", "PVTI_t1"]],
      [],
    ],
    [
      "a closed tracker item folded into its open PR's row is shown there, not named as stale",
      [tracked("PVTI_t2", 2, { status: "Draft", state: "closed", branch: [`${SANDBOX}/9`] })],
      [sandbox9],
      [],
      [["pr:jmarrero-forge/jmarrero-devspace-sandbox#9", "pr", "PVTI_t2"]],
      [],
    ],
    [
      "Branch URLs match whatever their case",
      [tracked("PVTI_t3", 3, { status: "Draft", branch: [`${SANDBOX.toUpperCase().replace("HTTPS://GITHUB.COM", "https://github.com")}/9`] })],
      [sandbox9],
      [],
      [["pr:jmarrero-forge/jmarrero-devspace-sandbox#9", "pr", "PVTI_t3"]],
      [],
    ],
    [
      "a Draft tracker item holding the bot's PR isn't listed apart while the PR waits on the bot",
      [tracked("PVTI_t1", 1, { status: "Draft", branch: [`${HOMEGIT}/80`] })],
      [],
      [review(pr("jmarrero-bot", "homegit", 80), true)],
      [["pr:jmarrero-bot/homegit#80", "pr", "PVTI_t1"]],
      [],
    ],
    [
      "a question about a PR on the board as itself nests under the PR's row",
      [
        prItem("PVTI_p4", "https://github.com/jmarrero-bot/praxis-credential-broker/pull/4", { status: "Needs human" }),
        question("PVTI_q4", 7, "https://github.com/jmarrero-bot/praxis-credential-broker/pull/4"),
      ],
      [],
      [review(pr("jmarrero-bot", "praxis-credential-broker", 4))],
      [["pr:jmarrero-bot/praxis-credential-broker#4", "pr", "PVTI_p4"]],
      [],
    ],
  ];
  for (const [name, items, prs, others, want, stale] of cases) {
    it(name, () => {
      const entries = buildEntries(items, prs, new Map(), true, new Set(), { others });
      assert.deepEqual(entries.map((e) => [e.key, e.kind, e.item?.nodeId]), want);
      assert.deepEqual(staleItems(items, entries).map((i) => i.nodeId), stale);
    });
  }

  it("drops a forge PR he approved together with its own Draft item", () => {
    const entries = buildEntries([prItem("PVTI_s9", `${SANDBOX}/9`)], [sandbox9], new Map([["jmarrero-forge/jmarrero-devspace-sandbox#9", { state: "approved" as const }]]));
    assert.deepEqual(entries, []);
  });

  it("keeps a Needs human PR item whose PR waits on the bot, flagged as the bot's bug", () => {
    const items = [prItem("PVTI_p4", "https://github.com/jmarrero-bot/praxis-credential-broker/pull/4", { status: "Needs human" })];
    const entries = buildEntries(items, [], new Map(), true, new Set(), { others: [review(pr("jmarrero-bot", "praxis-credential-broker", 4), true)] });
    assert.deepEqual(entries.map((e) => [e.key, e.bug === true]), [["item:PVTI_p4", true], ["pr:jmarrero-bot/praxis-credential-broker#4", false]]);
  });
});
