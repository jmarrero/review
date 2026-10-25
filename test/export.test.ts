import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { Item } from "../src/github/board.ts";
import { ALL } from "../src/github/filter.ts";
import { type ForgePr, VERDICT_LABEL } from "../src/github/forge.ts";
import { type ActionVerb, age, APP_URL, entryJson, printable, queueJson, queueText, SCHEMA, suggestedAction } from "../src/github/export.ts";
import type { Entry } from "../src/github/queue.ts";
import { type Io, run } from "../src/cli/queue.ts";
import { fields, rawItems, scriptedFetch } from "./helpers.ts";

const NOW = new Date("2026-01-20T00:00:00Z");
const TRACKER = "https://github.com/jmarrero-forge/tracker/issues";
const UP = "https://github.com/example-upstream/widget";

function item(nodeId: string, over: Partial<Item> = {}): Item {
  return { id: 0, nodeId, kind: "draft", title: nodeId, body: "", why: "", branch: [], gist: [], labels: [], assignees: [], status: "Needs human", ...over };
}

/** An ask in the tracker, as the bot opens them: by it, assigned to him. */
function ask(nodeId: string, number: number, label: string, body: string, over: Partial<Item> = {}): Item {
  return item(nodeId, {
    kind: "issue",
    url: `${TRACKER}/${number}`,
    ref: { owner: "jmarrero-forge", repo: "tracker", number },
    state: "open",
    labels: [label],
    author: "jmarrero-bot",
    assignees: ["jmarrero"],
    body,
    ...over,
  });
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

const meta = (policy?: string) =>
  `Text\n\n<!-- bot-meta -->\n---\n- Upstream: \`example-upstream/widget\`, base \`main\`\n${policy ? `- Contribution policy: \`${policy}\`\n` : ""}<!-- /bot-meta -->`;

const itemEntry = (i: Item, over: Partial<Entry> = {}): Entry => ({
  key: `item:${i.nodeId}`,
  kind: "item",
  title: i.title,
  where: i.ref ? `${i.ref.owner}/${i.ref.repo}#${i.ref.number}` : "draft item",
  href: `#item/${i.nodeId}`,
  item: i,
  ...over,
});

const prEntry = (p: ForgePr, over: Partial<Entry> = {}): Entry => ({
  key: `pr:${p.ref.owner}/${p.ref.repo}#${p.ref.number}`,
  kind: "pr",
  title: p.title,
  where: `${p.ref.owner}/${p.ref.repo}#${p.ref.number}`,
  href: `#pr/${p.ref.owner}/${p.ref.repo}/${p.ref.number}`,
  pr: p,
  since: p.createdAt,
  ...over,
});

const question = ask("PVTI_q", 21, "question", `Blocks: ${UP}/issues/7\nQ: Keep the old flag?\nOptions:\nA) Keep it\nB) Drop it\nRecommended: A, it is in use\n`, { priority: "P0" });
const review = ask("PVTI_r", 22, "review", `Blocks: \`${UP}/issues/7\`\nAsk: Re-approve widget#50\nReview: \`${UP}/pull/50\` at ${"a".repeat(40)}\n`);
const epic = item("PVTI_epic", { kind: "issue", url: `${UP}/issues/7`, ref: { owner: "example-upstream", repo: "widget", number: 7 }, state: "open", why: "ship it", priority: "P1" });

/**
 * A ranked queue with one entry per action verb, as buildEntries would
 * hand it over: the PRs' verdicts and turns, an item with nested asks, a
 * gist, an answered question and a bot bug.
 */
function fixtureQueue(): Entry[] {
  return [
    itemEntry(epic, {
      priority: "P1",
      rankPriority: "P0",
      since: "2026-01-05T00:00:00Z",
      children: [itemEntry(question, { kind: "question", priority: "P0" }), itemEntry(review, { kind: "review" })],
    }),
    prEntry(pr("jmarrero-forge", "widget", 5, { body: meta() }), { verdict: { state: "approved", url: "https://github.com/r/1" } }),
    prEntry(pr("jmarrero-forge", "widget", 6, { body: meta("human-text") }), { verdict: { state: "approved" } }),
    prEntry(pr("jmarrero-forge", "bootc", 3), { verdict: { state: "approved-older" } }),
    prEntry(pr("example-upstream", "widget", 60, { draft: false }), {
      wait: { onBot: false, reasons: ["rerun"], failed: ["ci / arm"], runs: [{ url: `${UP}/actions/runs/777`, owner: "example-upstream", repo: "widget", id: "777" }] },
    }),
    itemEntry(item("PVTI_gist", { status: "Draft", gist: ["https://gist.github.com/x/1"] }), { since: "2026-01-19T12:00:00Z" }),
    itemEntry(item("PVTI_bug"), { bug: true }),
    itemEntry(ask("PVTI_other", 23, "question", "Q: Elsewhere?\n", { assignees: [] }), { kind: "question" }),
    prEntry(pr("example-upstream", "widget", 61, { draft: false }), { verdict: { state: "changes-requested" }, wait: { onBot: true, reasons: [] } }),
    itemEntry(ask("PVTI_done", 24, "question", "Q: Done?\nOptions:\nA) yes\nB) no\n", { state: "closed" }), { kind: "question", settled: true }),
  ];
}

/** The backticked field names in the rows of a docs/queue-json.md section's table. */
function documentedFields(section: string): string[] {
  const doc = readFileSync(new URL("../docs/queue-json.md", import.meta.url), "utf8");
  const body = doc.split(/^## /m).find((s) => s.startsWith(section));
  assert.ok(body, section);
  return [...body.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1] as string);
}

describe("queueJson", () => {
  const doc = queueJson(fixtureQueue(), { scope: "composefs", priority: "P0" }, NOW, ["couldn't read the forge"]);

  it("writes the top level docs/queue-json.md describes", () => {
    const want = documentedFields("Top level");
    const have = Object.entries(doc).flatMap(([k, v]) => (k === "counts" ? Object.keys(v).map((c) => `counts.${c}`) : [k]));
    assert.deepEqual(have.sort(), [...want].sort());
    assert.equal(doc.schema, SCHEMA);
    assert.equal(doc.generatedAt, "2026-01-20T00:00:00.000Z");
    assert.equal(doc.filter, "composefs+P0");
    assert.deepEqual(doc.warnings, ["couldn't read the forge"]);
  });

  it("writes only documented entry fields, the required ones always", () => {
    const documented = documentedFields("Entries");
    const optional = ["verdict", "wait", "blocks", "why", "gists", "question", "ask"];
    const rows = doc.entries.flatMap((e) => [e, ...e.asks]);
    for (const e of rows) {
      for (const k of Object.keys(e)) assert.ok(documented.includes(k), `${e.key}: ${k} isn't documented`);
      for (const k of documented.filter((d) => !optional.includes(d))) assert.ok(k in e, `${e.key}: no ${k}`);
    }
    // Every optional field shows up somewhere in the fixture.
    for (const k of optional.filter((o) => o !== "blocks")) assert.ok(rows.some((e) => k in e), k);
  });

  it("writes only documented verdict states", () => {
    const docs = readFileSync(new URL("../docs/queue-json.md", import.meta.url), "utf8");
    const row = docs.split("\n").find((l) => l.startsWith("| `verdict` |")) ?? "";
    const states = new Set([...row.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]));
    for (const s of Object.keys(VERDICT_LABEL)) assert.ok(states.has(s), `${s} isn't documented`);
    assert.ok(doc.entries.some((e) => e.verdict?.state === "approved"));
  });

  it("names every verb the docs list, and no other", () => {
    const docs = readFileSync(new URL("../docs/queue-json.md", import.meta.url), "utf8");
    const listed = [...docs.matchAll(/^- `([a-z-]+)`:/gm)].map((m) => m[1]);
    const verbs = doc.entries.flatMap((e) => [e, ...e.asks]).map((e) => e.action.verb);
    const all: ActionVerb[] = ["review", "answer", "rerun", "comment", "read", "see-asks", "wait", "act-on-github", "report-bug"];
    assert.deepEqual([...listed].sort(), [...all].sort());
    assert.deepEqual([...new Set(verbs)].sort(), [...all].sort());
  });

  it("counts rows that need him, nested asks included", () => {
    // 10 entries, 2 nested asks; wait (2) and see-asks (1) aren't open.
    assert.deepEqual(doc.counts, { entries: 10, rows: 12, open: 9 });
  });

  it("is plain JSON, copied rather than shared", () => {
    const entries = fixtureQueue();
    const out = queueJson(entries, ALL, NOW);
    assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
    out.entries[5]!.gists!.push("changed");
    out.entries[4]!.wait!.reasons.push("resign");
    assert.deepEqual(entries[5]?.item?.gist, ["https://gist.github.com/x/1"]);
    assert.deepEqual(entries[4]?.wait?.reasons, ["rerun"]);
    assert.deepEqual(out.warnings, []);
    assert.deepEqual(queueJson([], ALL, NOW).counts, { entries: 0, rows: 0, open: 0 });
  });
});

describe("entryJson", () => {
  const [epicJson, approvedJson] = fixtureQueue().map(entryJson);

  it("nests the asks with their question and Ask: line", () => {
    assert.deepEqual(epicJson, {
      key: "item:PVTI_epic",
      kind: "item",
      title: "PVTI_epic",
      where: "example-upstream/widget#7",
      priority: "P1",
      rankPriority: "P0",
      org: "example-upstream",
      since: "2026-01-05T00:00:00Z",
      settled: false,
      bug: false,
      url: `${UP}/issues/7`,
      appUrl: `${APP_URL}#item/PVTI_epic`,
      why: "ship it",
      action: { verb: "see-asks", summary: "act on its 2 open ask(s)" },
      asks: [
        {
          key: "item:PVTI_q",
          kind: "question",
          title: "PVTI_q",
          where: "jmarrero-forge/tracker#21",
          priority: "P0",
          rankPriority: "P0",
          org: null,
          since: null,
          settled: false,
          bug: false,
          url: `${TRACKER}/21`,
          appUrl: `${APP_URL}#item/PVTI_q`,
          question: {
            ask: "Keep the old flag?",
            options: [
              { letter: "A", text: "Keep it", recommended: true },
              { letter: "B", text: "Drop it", recommended: false },
            ],
            recommendation: "A, it is in use",
          },
          action: { verb: "answer", summary: "answer the question (the bot recommends A)" },
          asks: [],
        },
        {
          key: "item:PVTI_r",
          kind: "review",
          title: "PVTI_r",
          where: "jmarrero-forge/tracker#22",
          priority: null,
          rankPriority: null,
          org: null,
          since: null,
          settled: false,
          bug: false,
          url: `${TRACKER}/22`,
          appUrl: `${APP_URL}#item/PVTI_r`,
          ask: "Re-approve widget#50",
          action: { verb: "review", summary: "review example-upstream/widget#50", targets: [`${UP}/pull/50`] },
          asks: [],
        },
      ],
    });
  });

  it("labels a verdict and keeps its URL", () => {
    assert.deepEqual(approvedJson?.verdict, { state: "approved", label: "approved", url: "https://github.com/r/1" });
    assert.equal(approvedJson?.url, "https://github.com/jmarrero-forge/widget/pull/5");
  });

  it("leaves out a settled question's options, and blocks only when set", () => {
    const settled = entryJson(fixtureQueue()[9]!);
    assert.equal(settled.settled, true);
    assert.equal("question" in settled, false);
    assert.equal(entryJson(itemEntry(item("PVTI_b"), { blocks: "a/b#1" })).blocks, "a/b#1");
  });

  it("gives a draft item no URL", () => {
    const e = entryJson(fixtureQueue()[5]!);
    assert.equal(e.url, null);
    assert.equal(e.where, "draft item");
    assert.deepEqual(e.gists, ["https://gist.github.com/x/1"]);
  });
});

describe("suggestedAction", () => {
  const actions = fixtureQueue().map(suggestedAction);
  const cases: [number, string, string][] = [
    [1, "comment", "send /promote on the approved fork PR to publish it upstream"],
    [2, "read", "write your title, description and commit messages for the upstream human-text policy"],
    [3, "review", "review the commits pushed since your approval"],
    [4, "rerun", "required checks failed: rerun: ci / arm"],
    [5, "read", "read the gist and decide"],
    [6, "report-bug", "Needs human, but the bot asked nothing: tell it"],
    [8, "wait", "you requested changes; the bot acts next"],
    [9, "wait", "closed by the bot; nothing to do"],
  ];
  for (const [i, verb, summary] of cases) {
    it(`${verb}: ${summary}`, () => {
      assert.equal(actions[i]?.verb, verb);
      assert.equal(actions[i]?.summary, summary);
    });
  }

  const more: [string, Entry, string, string][] = [
    ["older change request", prEntry(pr("jmarrero-forge", "a", 1), { verdict: { state: "changes-requested-older" } }), "review", "review the push since your change request"],
    ["promoted", prEntry(pr("jmarrero-forge", "a", 2), { verdict: { state: "promoted" } }), "wait", "you sent /promote; bot-pr acts next"],
    ["unreviewed", prEntry(pr("jmarrero-forge", "a", 3), { verdict: { state: "none" } }), "review", "review the forge PR (approve to promote it upstream)"],
    ["review requested", prEntry(pr("up", "a", 4), { wait: { onBot: false, reasons: ["review-requested"] } }), "review", "review requested"],
    ["re-sign", prEntry(pr("up", "a", 5), { wait: { onBot: false, reasons: ["resign"], unsigned: ["abc1234"] } }), "review", "approve to re-sign (DCO): abc1234 lack your Signed-off-by"],
    ["answered", itemEntry(ask("PVTI_ans", 26, "question", "Q: x?\n"), { kind: "question", settled: true }), "wait", "you answered; the bot acts next"],
    ["a Draft without a gist", itemEntry(item("PVTI_d", { status: "Draft" })), "read", "read it and decide"],
    ["a chore's reruns", itemEntry(ask("PVTI_ch", 27, "chore", `Rerun: \`${UP}/actions/runs/9\`\n`), { kind: "chore" }), "rerun", "rerun the failed jobs of 1 workflow run(s)"],
  ];
  for (const [name, e, verb, summary] of more) {
    it(name, () => {
      const a = suggestedAction(e);
      assert.equal(a.verb, verb);
      assert.equal(a.summary, summary);
    });
  }

  it("names the runs to rerun", () => assert.deepEqual(actions[4]?.targets, [`${UP}/actions/runs/777`]));

  it("says why the app can't act", () => {
    assert.deepEqual(actions[7], { verb: "act-on-github", summary: "the app can't act on this; see GitHub", reason: "jmarrero-forge/tracker#23 is not assigned to jmarrero" });
    const bare: Entry = { key: "item:x", kind: "chore", title: "x", where: "item", href: "#" };
    assert.deepEqual(suggestedAction(bare), { verb: "act-on-github", summary: "open it on GitHub", reason: "no board item" });
  });

  it("falls back to a comment, saying why, on a review ask naming no PR", () => {
    const a = suggestedAction(itemEntry(ask("PVTI_c", 25, "review", "Ask: look at it\n"), { kind: "review" }));
    assert.deepEqual(a, { verb: "comment", summary: "do what the review asks, then comment", reason: "it names no PR to review (no Review: line)" });
  });
});

describe("queueText", () => {
  it("groups as the app does, with warnings and nested asks", () => {
    const text = queueText(queueJson(fixtureQueue(), ALL, NOW, ["partial"]), NOW);
    const lines = text.split("\n");
    assert.equal(lines[0], "9 open of 12 row(s) in 10 entries (filter: all)");
    assert.equal(lines[1], "warning: partial");
    assert.deepEqual(
      lines.filter((l) => l.startsWith("== ")),
      ["== P0", "== No priority", "== Changes requested, waiting on the bot", "== Answered, waiting on the bot"],
    );
    assert.ok(lines.includes(`${" ".repeat(16)}A) Keep it  (recommended)`));
    assert.ok(lines.includes(`    question jmarrero-forge/tracker#21  PVTI_q  [-, ?]`));
    assert.ok(lines.includes("item     draft item  PVTI_gist  [-, 12h]"));
    assert.ok(lines.some((l) => l.endsWith("BOT BUG")));
    assert.ok(text.endsWith("\n"));
  });

  it("says when nothing waits", () => {
    assert.equal(queueText(queueJson([], ALL, NOW), NOW), "0 open of 0 row(s) in 0 entries (filter: all)\n\nNothing waiting on you.\n");
  });

  it("keeps escape sequences in titles off the terminal", () => {
    const rlo = String.fromCharCode(0x202e);
    const e = itemEntry(item("PVTI_esc", { title: `evil\u001b[2Jtitle${rlo}` }), { bug: true });
    const text = queueText(queueJson([e], ALL, NOW), NOW);
    assert.ok(text.includes("evil?[2Jtitle?"));
    assert.ok(!text.includes("\u001b") && !text.includes(rlo));
  });
});

describe("age and printable", () => {
  it("round down to hours, then days", () => {
    assert.equal(age("2026-01-19T23:30:00Z", NOW), "now");
    assert.equal(age("2026-01-18T01:00:00Z", NOW), "47h");
    assert.equal(age("2026-01-10T00:00:00Z", NOW), "10d");
    assert.equal(age(null, NOW), "?");
  });

  it("keeps newlines, replaces other controls", () => assert.equal(printable("a\nb\tc\u0085"), "a\nb?c?"));
});

describe("the token", () => {
  // The CLI holds the token only to send it; nothing of it may reach the
  // output, warnings about a failed read included. (A warning quotes
  // GitHub's error message as is, which never holds the token.) Built
  // from parts: not a real one.
  const token = ["test", "token", "not", "secret", "4f2a"].join("-");

  it("never appears in the exported queue or its warnings", async () => {
    const { fetchImpl, calls } = scriptedFetch((method, url) => {
      if (method !== "GET") return undefined;
      if (url.includes("/fields")) return { body: fields() };
      if (url.includes("/items")) return { body: rawItems() };
      if (url.includes("/search/")) return { status: 503, body: { message: "down" } };
      return { body: [] };
    });
    let stdout = "";
    let stderr = "";
    const io: Io = { fetch: fetchImpl, token: async () => token, stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), isTty: false, now: () => NOW };
    for (const argv of [["--json"], ["--text"]]) {
      stdout = "";
      stderr = "";
      assert.equal(await run(argv, io), 0);
      assert.match(stdout, /couldn't read the forge/);
      assert.ok(!`${stdout}${stderr}`.includes(token), `${argv[0]} printed the token`);
    }
    assert.ok(calls.length > 0 && calls.every((c) => Object.values(c.headers).some((h) => h.includes(token))));
  });
});
