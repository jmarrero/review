import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHub } from "../src/github/api.ts";
import { DECISIONS_CONFIG, MAX_ABOUT, answerDocument, answerShownEntry, parseDocument, readDocument, readMarks, sendDocumentEdit } from "../src/github/decisiondocument.ts";
import recorded from "./fixtures/decision-about.json" with { type: "json" };

const body = "### D12 Enable scheduler? (P0, blocks example/work#3)\nContext.\n- [ ] A) Yes ← recommended: ready\n- [ ] B) Wait\n\nReply:\n\n### D13 Another?\n- [ ] A) Yes\n- [ ] B) No\nReply:\n\n## Done\n### D1 Old\nOutcome: kept\n";
const path = "/repos/example/private/issues/8";

test("site configuration has no document and retains legacy questions", () => {
  // jmarrero-forge has no operator decisions document yet.
  assert.equal(DECISIONS_CONFIG.document, null);
  assert.equal(DECISIONS_CONFIG.legacyQuestions, true);
});

test("an answer ticks one option and fills the reply through the viewer's client, leaving other entries", async () => {
  let written = "";
  const gh = new GitHub(async () => "viewer-token", async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer viewer-token");
    if (init?.method === "PATCH") written = JSON.parse(String(init.body)).body;
    return new Response(JSON.stringify({ body }), { status: 200 });
  });
  await sendDocumentEdit(gh, path, body, (b) => answerDocument(b, "D12", "B", "Not today"));
  assert.match(written, /\[x\] B\) Wait/);
  assert.match(written, /Reply: Not today/);
  assert.equal(written.slice(written.indexOf("### D13")), body.slice(body.indexOf("### D13")));
});

test("concurrent edit refuses PATCH", async () => {
  let calls = 0;
  const gh = new GitHub(async () => "token", async () => {
    calls++;
    return new Response(JSON.stringify({ body: body + "other edit" }));
  });
  await assert.rejects(sendDocumentEdit(gh, path, body, (b) => answerDocument(b, "D12", "A", "yes")), /changed, reload/);
  assert.equal(calls, 1);
});

test("reject ambiguous ids, answered entries, done edits and multiline replies", () => {
  assert.throws(() => parseDocument(body + "### D12 duplicate\n"), /Duplicate/);
  assert.throws(() => answerDocument(body, "D1", "A", ""));
  assert.throws(() => answerDocument(body, "D12", "C", ""));
  assert.throws(() => answerDocument(body, "D12", "A", "x\n### D9 Inject"));
  assert.throws(() => answerDocument(body.replace("[ ]", "[x]"), "D12", "A", ""));
});

test("fenced examples stay untouched and duplicate option letters are refused", () => {
  const example = "```md\n### D99 Example\n- [ ] A) Example\nReply: example\n```\n";
  const source = body.replace("Context.\n", "Context.\n" + example);
  assert.equal(parseDocument(source)[0]!.options.length, 2);
  assert.ok(answerDocument(source, "D12", "A", "ok").includes(example));
  assert.throws(() => parseDocument(body.replace("B) Wait", "A) Wait")), /Duplicate option/);
});

// The shapes of D15 (asked for a step the bot answered on 17 Oct) and D19
// (a PR since closed unmerged), with GitHub's answers in the fixture.
const about = "### D15 Create the workflow-checker ruleset\nAbout: example/work#15, asked 2026-10-15\n- [ ] A) Create it\nReply:\n\n### D19 Merge with a bypass?\nAbout: example/actions#86\n- [ ] A) Merge\n- [ ] B) Close\nReply:\n\n### D21 Land it\nAbout: example/actions#90\n- [ ] Tell people\nReply:\n\n### D22 Still open\nAbout: example/work#20, asked 2026-10-19T09:30Z\n- [ ] A) Yes\nReply:\n\n### D23 Nothing named\n- [ ] A) Yes\nReply:\n\n## Done\n### D1 Old\nAbout: example/gone#1\n";

function recordedGitHub(document: string, requests: string[] = []): GitHub {
  return new GitHub(async () => "token", async (url) => {
    const at = new URL(String(url));
    const key = decodeURIComponent(at.pathname + at.search);
    requests.push(key);
    if (key === "/repos/example/private/issues/8") return new Response(JSON.stringify({ body: document }));
    const found = (recorded as Record<string, unknown>)[key];
    return found === undefined ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(found));
  });
}

test("About lines name the item an entry is about; malformed or path-like ones name none", () => {
  const entries = parseDocument(about);
  assert.deepEqual(entries.map((e) => e.about), [
    { repo: "example/work", number: 15, asked: "2026-10-15T00:00:00.000Z" },
    { repo: "example/actions", number: 86 },
    { repo: "example/actions", number: 90 },
    { repo: "example/work", number: 20, asked: "2026-10-19T09:30:00.000Z" },
    undefined,
    { repo: "example/gone", number: 1 },
  ]);
  for (const line of ["About: ../..#1", "About: example/..#1", "About: example/work#0", "About: example/work#3 or so", "About: example/work/issues#3", "About: example/work#3, asked 2026-13-45"]) {
    assert.equal(parseDocument(`### D1 X\n${line}\n`)[0]!.about?.asked, undefined, line);
    if (!line.includes("asked")) assert.equal(parseDocument(`### D1 X\n${line}\n`)[0]!.about, undefined, line);
  }
  assert.equal(parseDocument("### D1 X\n```\nAbout: example/work#3\n```\n")[0]!.about, undefined);
});

test("an answer from a form kept on the page goes out only while its entry reads as shown", () => {
  const shownBody = "### D12 Enable scheduler?\n- [ ] A) Enable\n- [ ] B) Disable\nReply:\n\n### D13 Another?\n- [ ] A) Yes\nReply:\n";
  const shown = parseDocument(shownBody)[0]!;
  // Elsewhere in the document is no matter: it builds on the body as it is now.
  const elsewhere = shownBody.replace("### D13 Another?", "### D13 Another one?");
  assert.match(answerShownEntry(elsewhere, shown, "B", "no"), /\[x\] B\) Disable[\s\S]*Reply: no[\s\S]*Another one/);
  for (const [name, now] of [
    ["the options swapped", shownBody.replace("A) Enable\n- [ ] B) Disable", "A) Disable\n- [ ] B) Enable")],
    ["the heading reworded", shownBody.replace("Enable scheduler?", "Disable scheduler?")],
    ["the entry gone", shownBody.slice(shownBody.indexOf("### D13"))],
  ] as const) assert.throws(() => answerShownEntry(now, shown, "B", "no"), /D12 changed since it was shown/, name);
});

test("agent-board's heading names the item an entry blocks as its About, unless an About line names one", () => {
  const cases: [string, unknown][] = [
    ["### D12 Enable scheduler? (P0, blocks example/work#3)\n", { repo: "example/work", number: 3 }],
    ["### D12 Enable scheduler? (blocks example/work#3)\r\n", { repo: "example/work", number: 3 }],
    ["### D12 Enable scheduler? (P0, blocks example/work#3)\nAbout: example/other#9, asked 2026-10-15\n", { repo: "example/other", number: 9, asked: "2026-10-15T00:00:00.000Z" }],
    ["### D12 Enable scheduler? (P0)\n", undefined],
    ["### D12 Enable scheduler? (P0, blocks example/work#3) later\n", undefined],
    ["### D12 Enable scheduler? (P0, blocks ../..#3)\n", undefined],
    ["### D12 Enable scheduler? (P0, blocks example/work#0)\n", undefined],
  ];
  for (const [doc, about] of cases) assert.deepEqual(parseDocument(doc)[0]!.about, about, doc);
  assert.deepEqual(parseDocument(body)[0]!.about, { repo: "example/work", number: 3 });
});

test("recorded states resolve closed and merged items, mark one answered since the ask, and leave the rest", async () => {
  const requests: string[] = [];
  const marks = await readMarks(recordedGitHub(about, requests), parseDocument(about));
  assert.deepEqual(Object.fromEntries(marks), {
    D15: { item: "example/work#15", state: "answered", comments: 1, url: "https://github.com/example/work/issues/15" },
    D19: { item: "example/actions#86", state: "closed", url: "https://github.com/example/actions/pull/86" },
    D21: { item: "example/actions#90", state: "merged", url: "https://github.com/example/actions/pull/90" },
  });
  // Done entries are not read, and a closed item needs no comment read.
  assert.ok(!requests.some((r) => r.includes("gone") || r.includes("86/comments")));
  // An open entry's item this viewer cannot read (404 here) leaves it unmarked.
  const unreadable = "### D1 X\nAbout: example/gone#1\n";
  assert.equal((await readMarks(recordedGitHub(unreadable), parseDocument(unreadable))).size, 0);
});

test("resolve is off unless configured, and a bounded number of items is read", async () => {
  const requests: string[] = [];
  assert.equal((await readDocument(recordedGitHub(about, requests), { repo: "example/private", number: 8 })).marks.size, 0);
  assert.equal(requests.length, 1);
  assert.equal((await readDocument(recordedGitHub(about), { repo: "example/private", number: 8, resolve: true })).marks.size, 3);

  const many = Array.from({ length: MAX_ABOUT + 5 }, (_, i) => `### D${i + 1} X\nAbout: example/work#${i + 1}\n`).join("");
  const read: string[] = [];
  await readMarks(recordedGitHub(many, read), parseDocument(many));
  assert.equal(read.length, MAX_ABOUT);
});
