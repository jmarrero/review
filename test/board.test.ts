import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  answeredPending,
  type AskFacts,
  askKind,
  askProblem,
  type AskScope,
  assigneeLogins,
  blockedBy,
  type CommentFacts,
  fieldIds,
  isAsk,
  isQuestion,
  type Item,
  labelNames,
  missingTriageFields,
  openItems,
  parseApiIssueUrl,
  parseIssueUrl,
  questionOf,
  queueItems,
} from "../src/github/board.ts";
import { fields, rawBoardItem, rawItems } from "./helpers.ts";

describe("fieldIds", () => {
  it("maps the fields the app reads", () => {
    assert.deepEqual(fieldIds(fields()), [102, 104, 103, 105, 106, 107]);
  });
  it("names a missing field", () => {
    assert.throws(() => fieldIds(fields().filter((f) => f.name !== "Why")), /no field named "Why"/);
  });
  it("adds the triage fields the board has, and names those it lacks", () => {
    const more = [...fields(), { id: 110, name: "Verdict" }, { id: 111, name: "Theme" }];
    assert.deepEqual(fieldIds(more), [102, 104, 103, 105, 106, 107, 111, 110]);
    assert.deepEqual(missingTriageFields(more), ["Verdict target"]);
    assert.deepEqual(missingTriageFields(fields()), ["Theme", "Verdict", "Verdict target"]);
  });
});

describe("openItems", () => {
  it("keeps every unarchived item that isn't Done, those without a Status too", () => {
    const raw = [
      rawBoardItem(1, { Status: "Todo" }),
      rawBoardItem(2, { Status: "Done" }),
      rawBoardItem(3, {}),
      { ...rawBoardItem(4, { Status: "Draft" }), archived_at: "2026-01-01T00:00:00Z" },
    ];
    assert.deepEqual(openItems(raw).map((i) => i.id), [1, 3]);
  });
});

describe("parseIssueUrl", () => {
  const cases: [string, ReturnType<typeof parseIssueUrl>][] = [
    ["https://github.com/o/r/issues/12", { owner: "o", repo: "r", number: 12 }],
    ["https://github.com/o-x/r.y_z/pull/3", { owner: "o-x", repo: "r.y_z", number: 3 }],
    ["https://github.com/o/r/pull/3/files", undefined],
    ["https://evil.example/o/r/issues/1", undefined],
    ["http://github.com/o/r/issues/1", undefined],
  ];
  for (const [url, want] of cases) it(url, () => assert.deepEqual(parseIssueUrl(url), want));
});

describe("parseApiIssueUrl", () => {
  const cases: [string, ReturnType<typeof parseApiIssueUrl>][] = [
    ["https://api.github.com/repos/jmarrero-forge/tracker/issues/20", { owner: "jmarrero-forge", repo: "tracker", number: 20 }],
    ["https://github.com/jmarrero-forge/tracker/issues/20", undefined],
    ["https://api.github.com/repos/o/r/pulls/2", undefined],
  ];
  for (const [url, want] of cases) it(url, () => assert.deepEqual(parseApiIssueUrl(url), want));
});

describe("assigneeLogins", () => {
  it("takes logins, skipping empty ones", () => {
    assert.deepEqual(assigneeLogins([{ login: "jmarrero" }, null, {}]), ["jmarrero"]);
    assert.deepEqual(assigneeLogins(null), []);
  });
});

describe("labelNames", () => {
  it("takes objects and strings, skipping nameless ones", () => {
    assert.deepEqual(labelNames([{ name: "question" }, "bug", {}, { name: "" }]), ["question", "bug"]);
    assert.deepEqual(labelNames(undefined), []);
  });
});

describe("queueItems", () => {
  const items = queueItems(rawItems());
  const byId = new Map(items.map((i) => [i.nodeId, i]));

  it("keeps unarchived Needs human and Draft items only, in board order", () => {
    assert.deepEqual(
      items.map((i) => i.nodeId),
      [
        "PVTI_synthetic_upstream_pr",
        "PVTI_synthetic_draft",
        "PVTI_synthetic_home_issue",
        "PVTI_synthetic_redacted",
        "PVTI_synthetic_epic",
        "PVTI_synthetic_question",
        "PVTI_synthetic_upstream_question",
        "PVTI_synthetic_closed_question",
        "PVTI_synthetic_upstream_issue",
        "PVTI_synthetic_review_ask",
        "PVTI_synthetic_chore_ask",
      ],
    );
  });

  it("parses a PR item", () => {
    const pr = byId.get("PVTI_synthetic_upstream_pr");
    assert.equal(pr?.kind, "pr");
    assert.deepEqual(pr?.ref, { owner: "example-upstream", repo: "widget", number: 42 });
    assert.equal(pr?.priority, "P1");
    assert.equal(pr?.org, "other");
    assert.equal(pr?.state, "open");
    assert.match(pr?.why ?? "", /^CI is red/);
  });

  it("keeps only https URLs from Branch", () => {
    assert.deepEqual(byId.get("PVTI_synthetic_upstream_pr")?.branch, ["https://github.com/example-forge/widget/pull/3"]);
  });

  it("parses a draft item", () => {
    const d = byId.get("PVTI_synthetic_draft");
    assert.equal(d?.kind, "draft");
    assert.equal(d?.url, undefined);
    assert.deepEqual(d?.gist, ["https://gist.github.com/jmarrero-bot/0123abcd"]);
  });

  it("parses a tracker question and its parent", () => {
    const q = byId.get("PVTI_synthetic_question");
    assert.deepEqual(q?.labels, ["question"]);
    assert.equal(q?.comments, 2);
    assert.deepEqual(q?.parent, { owner: "jmarrero-forge", repo: "tracker", number: 20 });
    assert.equal(q?.subIssues, undefined);
    assert.deepEqual(byId.get("PVTI_synthetic_epic")?.subIssues, { total: 3, completed: 1, percent_completed: 33 });
  });

  it("survives an item it can't see", () => {
    const r = byId.get("PVTI_synthetic_redacted");
    assert.equal(r?.kind, "unknown");
    assert.equal(r?.title, "(no title or no access)");
    assert.equal(r?.ref, undefined);
  });
});

describe("questions", () => {
  const items = new Map(queueItems(rawItems()).map((i) => [i.nodeId, i]));
  const get = (id: string) => items.get(id) as Item;

  it("are tracker issues labelled question, open or closed", () => {
    const questions = [...items.values()].filter((i) => isQuestion(i)).map((i) => i.nodeId);
    assert.deepEqual(questions, ["PVTI_synthetic_question", "PVTI_synthetic_upstream_question", "PVTI_synthetic_closed_question"]);
    const asks = [...items.values()].filter((i) => isAsk(i)).map((i) => [i.nodeId, askKind(i)]);
    assert.deepEqual(asks.slice(3), [
      ["PVTI_synthetic_review_ask", "review"],
      ["PVTI_synthetic_chore_ask", "chore"],
    ]);
  });

  it("an ask has exactly one ask label, and is in the tracker", () => {
    const ref = { owner: "jmarrero-forge", repo: "tracker", number: 1 };
    const kind = (labels: string[], over: Partial<AskFacts> = {}) => askKind({ kind: "issue", ref, labels, ...over });
    assert.equal(kind(["chore", "infra"]), "chore");
    assert.equal(kind(["review"]), "review");
    assert.equal(kind(["review", "chore"]), undefined);
    assert.equal(kind([]), undefined);
    assert.equal(kind(["question"], { ref: { owner: "o", repo: "r", number: 1 } }), undefined);
    assert.equal(kind(["question"], { kind: "pr" }), undefined);
  });

  const tracker = { owner: "jmarrero-forge", repo: "tracker", number: 21 };
  const open: AskFacts = { kind: "issue", ref: tracker, state: "open", labels: ["question"], assignees: ["someone", "jmarrero"], author: "jmarrero-bot" };
  const sandbox: AskScope = { repo: "jmarrero-bot/review-sandbox", assignee: "jmarrero-bot", author: "jmarrero-bot" };
  const inSandbox: AskFacts = { ...open, ref: { owner: "jmarrero-bot", repo: "review-sandbox", number: 4 }, assignees: ["jmarrero-bot"] };
  const problems: [string, AskFacts, AskScope | undefined, RegExp | undefined][] = [
    ["an open question", open, undefined, undefined],
    ["not opened by the bot", { ...open, author: "someone" }, undefined, /not opened by jmarrero-bot/],
    ["with no known author", { kind: "issue", ref: tracker, state: "open", labels: ["question"], assignees: ["jmarrero"] }, undefined, /not opened by jmarrero-bot/],
    ["another ask label as well", { ...open, labels: ["question", "chore"] }, undefined, /several of the labels "question", "chore"/],
    ["any case of the repository name", { ...open, ref: { ...tracker, owner: "JMarrero-Forge" } }, undefined, undefined],
    ["not assigned to him", { ...open, assignees: ["jmarrero-bot"] }, undefined, /not assigned to jmarrero$/],
    ["assigned to nobody", { ...open, assignees: [] }, undefined, /not assigned to jmarrero$/],
    ["no issue", { kind: "draft", labels: [], assignees: [] }, undefined, /no issue/],
    ["a PR", { ...open, kind: "pr" }, undefined, /is not an issue/],
    ["an upstream issue", { ...open, ref: { owner: "example-upstream", repo: "widget", number: 1 } }, undefined, /not in jmarrero-forge\/tracker/],
    ["no label", { ...open, labels: ["bug"] }, undefined, /not labelled "question"/],
    ["closed", { ...open, state: "closed" }, undefined, /is closed/],
    ["the sandbox, overridden", inSandbox, sandbox, undefined],
    ["the sandbox, assigned to him only", { ...inSandbox, assignees: ["jmarrero"] }, sandbox, /not assigned to jmarrero-bot/],
    ["the tracker, when overridden", open, sandbox, /not in jmarrero-bot\/review-sandbox/],
  ];
  for (const [name, facts, scope, want] of problems) {
    it(`askProblem for a question: ${name}`, () => {
      const got = askProblem(facts, "question", scope);
      if (want) assert.match(got ?? "", want);
      else assert.equal(got, undefined);
    });
  }

  const askProblems: [string, AskFacts, "review" | "chore" | undefined, RegExp | undefined][] = [
    ["a review ask", { ...open, labels: ["review"] }, "review", undefined],
    ["a chore, of any kind", { ...open, labels: ["chore"] }, undefined, undefined],
    ["a chore wanted as a review", { ...open, labels: ["chore"] }, "review", /not labelled "review"/],
    ["no ask label", { ...open, labels: ["bug"] }, undefined, /has none of the labels "question", "review", "chore"/],
  ];
  for (const [name, facts, want, re] of askProblems) {
    it(`askProblem: ${name}`, () => {
      const got = askProblem(facts, want);
      if (re) assert.match(got ?? "", re);
      else assert.equal(got, undefined);
    });
  }

  it("are parsed only from question issues", () => {
    const letters = (item: Item) => questionOf(item).options.map((o) => `${o.letter}${o.recommended ? "*" : ""}`).join(" ");
    assert.equal(letters(get("PVTI_synthetic_question")), "A* B");
    // The upstream PR's Why and a legacy draft's body offer options, but aren't questions.
    assert.equal(letters({ ...get("PVTI_synthetic_upstream_pr"), why: "Options:\nA) x\nB) y" }), "");
    assert.equal(letters({ ...get("PVTI_synthetic_draft"), body: "Options:\nA) x\nB) y" }), "");
  });

  it("block their parent, else their Blocks: item", () => {
    const blocked = (id: string) => blockedBy(get(id));
    assert.deepEqual(blocked("PVTI_synthetic_question"), { owner: "jmarrero-forge", repo: "tracker", number: 20 });
    assert.deepEqual(blocked("PVTI_synthetic_upstream_question"), { owner: "example-upstream", repo: "widget", number: 42 });
    assert.deepEqual(blockedBy({ ...get("PVTI_synthetic_question"), body: "Blocks: https://github.com/o/r/issues/9" }), {
      owner: "jmarrero-forge",
      repo: "tracker",
      number: 20,
    });
    assert.equal(blocked("PVTI_synthetic_epic"), undefined);
    // Review and chore asks too, from their backticked Blocks: line.
    for (const id of ["PVTI_synthetic_review_ask", "PVTI_synthetic_chore_ask"]) {
      assert.deepEqual(blocked(id), { owner: "example-upstream", repo: "widget", number: 7 }, id);
    }
  });
});

describe("answeredPending", () => {
  const c = (author: string): CommentFacts => ({ author, createdAt: "2026-01-01T00:00:00Z" });
  const cases: [string, CommentFacts[], boolean][] = [
    ["no comments", [], false],
    ["only the bot", [c("jmarrero-bot")], false],
    ["his answer", [c("jmarrero")], true],
    ["his answer after the bot's", [c("jmarrero-bot"), c("someone"), c("jmarrero")], true],
    ["the bot replied since", [c("jmarrero"), c("jmarrero-bot")], false],
    ["someone else is not him", [c("jmarrero-bot"), c("someone")], false],
    ["answered again after a follow-up", [c("jmarrero"), c("jmarrero-bot"), c("jmarrero")], true],
  ];
  for (const [name, comments, want] of cases) it(name, () => assert.equal(answeredPending(comments), want));
});
