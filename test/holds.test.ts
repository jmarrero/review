import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import type { RawComment } from "../src/github/heartbeat.ts";
import { assembleHolds, findHolds, holdAsks, HOLDS_MARKER, loadHolds, parseHolds, parseNeedsYou } from "../src/github/holds.ts";
import { usagePath } from "../src/github/usage.ts";
import { compressedHolds, fixture, holdsComment, rawAsk, rawNeedsYou, REAL_NEEDS_YOU_AT, REAL_NEEDS_YOU_KEYS, realNeedsYouSnapshot, scriptedFetch } from "./helpers.ts";

const AT = "2026-10-26T00:00:00Z";
/** As agent-board's pass renders it (pass/holds.rs). */
const body = (json: unknown) => `${HOLDS_MARKER}\nHolds as of ${AT}. Written by \`agent-board pass\`; the review app reads the JSON below.\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;
const wip = { item: null, url: null, epic: false, kind: "wip", reason: "2 of 2 runs active", operator: false, priority: null, question: null };
const human = { item: "jmarrero-forge/tracker#446", url: "https://github.com/jmarrero-forge/tracker/issues/446", epic: false, kind: "needs-human", reason: "labelled needs-human", operator: true, priority: "P0", question: "Ship it?" };
const snapshot = (holds: unknown[] = [wip, human], over: Record<string, unknown> = {}) => ({ schema: "agent-board/holds/v1", at: AT, holds, ...over });
const comment = (json: unknown, login = "jmarrero-bot"): RawComment => ({ user: { login }, body: body(json) });

describe("parseHolds", () => {
  for (const truncated of [0, 1]) it(`reconciles hold identities and details, respecting truncated=${truncated}`, () => {
    const raw = fixture<Record<string, unknown>>("needs-you-259.json");
    raw.truncated = truncated;
    const list = parseHolds(body(raw))!.needsYou;
    assert.ok(list && typeof list === "object");
    const expected = truncated ? ["jmarrero-forge/agent-board#728"] : [];
    assert.deepEqual(list.items.map((a) => a.key), expected);
    assert.deepEqual(list.identities!.map((i) => i.key), expected);
    assert.equal(list.excludedHolds, truncated ? 1 : 2);
  });

  it("reads a snapshot as the pass publishes it", () => assert.deepEqual(parseHolds(body(snapshot())), { at: AT, holds: [wip, human] }));
  // name, the snapshot: each is no holds at all, not the entries that parse.
  const refused: [string, unknown][] = [
    ["another schema", snapshot(undefined, { schema: "agent-board/pass-holds/v1" })],
    ["no time", snapshot(undefined, { at: "yesterday" })],
    ["holds not a list", snapshot(undefined, { holds: {} })],
    ["a key missing", snapshot([wip, { ...human, question: undefined }])],
    ["an item that is no reference", snapshot([{ ...human, item: "tracker#446" }])],
    ["a link to another item", snapshot([{ ...human, url: "https://github.com/jmarrero-forge/tracker/issues/447" }])],
    ["a link off github.com", snapshot([{ ...human, url: "javascript:alert(1)" }])],
    ["a link without an item", snapshot([{ ...wip, url: "https://github.com/jmarrero-forge/tracker/issues/446" }])],
    ["operator not a boolean", snapshot([{ ...human, operator: "yes" }])],
    ["a priority the board has not", snapshot([{ ...human, priority: "urgent" }])],
    ["a kind that is no word", snapshot([{ ...human, kind: "<b>" }])],
    ["an entry not an object", snapshot([wip, null])],
  ];
  for (const [name, json] of refused) it(`refuses ${name}`, () => assert.equal(parseHolds(body(json)), undefined));
  it("refuses a body without the marker first", () => assert.equal(parseHolds(`hi\n${body(snapshot())}`), undefined));
  const wipSummary = { wip: { limit: 4, in_flight: 2 }, pass: { mode: "preview", candidates: 3, started: 1, live_epics: null } };
  it("reads the pass's WIP and summary, nulls kept", () => assert.deepEqual(parseHolds(body(snapshot(undefined, wipSummary))), { at: AT, wip: { limit: 4, inFlight: 2 }, pass: { mode: "preview", candidates: 3, started: 1, liveEpics: null }, holds: [wip, human] }));
  // name, the snapshot's wip and pass: each left out, the holds kept.
  const malformed: [string, Record<string, unknown>][] = [
    ["a limit not a count", { wip: { limit: "4", in_flight: 2 } }],
    ["in flight missing", { wip: { limit: 4 } }],
    ["a negative start", { pass: { ...wipSummary.pass, started: -1 } }],
    ["a mode that is no word", { pass: { ...wipSummary.pass, mode: "<b>" } }],
    ["candidates missing", { pass: { mode: "preview", started: 1, live_epics: null } }],
  ];
  for (const [name, edit] of malformed) it(`leaves out ${name}, and keeps the holds`, () => {
    const parsed = parseHolds(body(snapshot(undefined, { ...wipSummary, ...edit })));
    assert.equal(parsed?.holds.length, 2);
    for (const key of Object.keys(edit) as ("wip" | "pass")[]) assert.equal(parsed?.[key], undefined);
  });
});

describe("the recorded comments", () => {
  it("replays the approved 3 Nov publication unchanged: 12 ordered asks, no observed groups", async () => {
    const raw = realNeedsYouSnapshot();
    assert.equal(raw.at, REAL_NEEDS_YOU_AT);
    assert.equal(raw.needs_you.count, 12);
    assert.equal(raw.needs_you.items.length, 12);
    assert.equal(raw.needs_you.requests.length, 12);
    assert.ok(raw.needs_you.items.every((a) => !("group" in a)));
    const replay = await findHolds([comment(raw)]);
    assert.ok(replay);
    const l = replay.needsYou;
    assert.ok(l && typeof l === "object", String(l));
    assert.deepEqual(l.items.map((a) => a.key), REAL_NEEDS_YOU_KEYS);
    assert.deepEqual([l.validatedAt, l.changedAt, l.complete, l.omitted, l.refused], [REAL_NEEDS_YOU_AT, REAL_NEEDS_YOU_AT, false, 85, 0]);
    assert.deepEqual(l.sources, { epics: "complete", items: "partial", reviews: "complete", proposals: "complete", digest: "partial" });
    for (const [i, a] of l.items.entries()) {
      const [repository, number] = REAL_NEEDS_YOU_KEYS[i]!.split("#");
      assert.deepEqual(a.action, { type: "issue", repository, number: Number(number) });
      assert.equal(a.group, undefined);
      assert.equal(a.carried, false);
      assert.equal("target" in a, false);
      assert.equal(a.requestsUnreadable, undefined);
      assert.equal(a.requests?.length, 1);
      assert.equal(a.requests![0]!.forge, "github.com");
      assert.deepEqual(a.requests![0]!.actions.map((x) => [x.kind, x.supported]), [["promote", false], ["merge-or-enqueue", false], ["reply", false], ["close", false]]);
    }
  });

  // As agent-board's pass/holds.rs renders them: compact, one entry a line; the older without wip and pass.
  const [older, newer] = fixture<RawComment[]>("holds-comments.json");
  it("reads a comment from before wip and pass without them", async () => {
    const holds = await findHolds([older!]);
    assert.deepEqual([holds?.at, holds?.holds.length, holds?.wip, holds?.pass], ["2026-10-25T09:00:00Z", 3, undefined, undefined]);
  });
  it("reads the current one with them", async () => {
    const holds = await findHolds([older!, newer!]);
    assert.deepEqual([holds?.wip, holds?.pass], [{ limit: 4, inFlight: 4 }, { mode: "actions", candidates: 7, started: 1, liveEpics: 2 }]);
    assert.deepEqual(holds?.holds.map((h) => h.kind), ["wip", "epic-unplanned", "needs-human"]);
  });
});

describe("findHolds", () => {
  // name, the issue's comments oldest first, the reasons of the holds found (undefined for none)
  const cases: [string, RawComment[], string[] | undefined][] = [
    ["the bot's comment", [comment(snapshot())], ["2 of 2 runs active", "labelled needs-human"]],
    ["not someone else's copy", [comment(snapshot(), "mallory")], undefined],
    ["the newest of the bot's", [comment(snapshot([wip])), comment(snapshot([human])), comment(snapshot([]), "mallory")], ["labelled needs-human"]],
    ["nothing, not an older one, when the newest doesn't parse", [comment(snapshot()), comment(snapshot([{ ...human, epic: null }]))], undefined],
    ["not the usage comment", [{ user: { login: "jmarrero-bot" }, body: "<!-- bot-usage v1 -->\n" }], undefined],
  ];
  for (const [name, comments, want] of cases) it(name, async () => assert.deepEqual((await findHolds(comments))?.holds.map((h) => h.reason), want));
});

describe("assembleHolds", () => {
  // A snapshot longer than one comment, as agent-board publishes it compressed (agent-board#774), in small parts.
  const plain = body(snapshot([wip, ...Array.from({ length: 40 }, (_, n) => ({ ...human, item: `jmarrero-forge/tracker#${n + 1}`, url: `https://github.com/jmarrero-forge/tracker/issues/${n + 1}`, reason: `held ${n} `.repeat(20) }))]));
  const next = "2026-10-26T00:10:00Z";
  const [first, ...rest] = compressedHolds(plain, AT, 400);
  const [, ...newer] = compressedHolds(plain.replaceAll(AT, next), next, 400);
  const usage = { user: { login: "jmarrero-bot" }, body: "<!-- bot-usage v1 -->\n" };
  it("splits the fixture into several parts", () => assert.ok(rest.length >= 2, String(rest.length)));
  // name, the issue's comments oldest first, whether the plain comment is assembled
  const cases: [string, RawComment[], boolean][] = [
    ["its parts in order", [usage, first!, ...rest], true],
    ["its parts in any order, among another snapshot's", [...[...rest].reverse(), ...newer, first!], true],
    ["not with a part missing", [first!, ...rest.slice(1)], false],
    ["not from another snapshot's parts", [first!, ...newer], false],
    ["not from parts someone else wrote", [first!, ...rest.map((c) => ({ ...c, user: { login: "mallory" } }))], false],
    ["not a corrupt piece", [first!, { ...rest[0]!, body: rest[0]!.body.replace("```text\n", "```text\nAAAA") }, ...rest.slice(1)], false],
    ["not a header counting past agent-board's bound", [{ ...first!, body: first!.body.replace(/"parts":\d+/, '"parts":5') }, ...rest], false],
  ];
  for (const [name, comments, whole] of cases) it(name, async () => assert.equal(await assembleHolds(comments), whole ? plain : undefined));
  it("reads a plain comment as it is", async () => assert.equal(await assembleHolds([comment(snapshot())]), body(snapshot())));
  it("finds the holds it encodes", async () => assert.equal((await findHolds([first!, ...rest]))?.holds.length, 41));
  it("refuses a piece that inflates past the bound", async () => {
    const [bomb] = compressedHolds(`${HOLDS_MARKER}\n${"x".repeat(9_000_000)}`, AT);
    assert.equal(await assembleHolds([bomb!]), undefined);
  });
});

/** The example in agent-board's docs/pass.md, verbatim. */
const DOC_EXAMPLE = `{"schema":"agent-board/needs-you/v2","complete":true,"validated_at":"2026-10-30T09:30:00Z","changed_at":"2026-10-30T09:00:00Z","sources":{"epics":"complete","items":"complete","reviews":"complete","proposals":"complete","digest":"off"},"summaries":"complete","omitted":0,"count":2,"items":[
{"key":"jmarrero-forge/tracker#446","item":"jmarrero-forge/tracker#446","source":"items","kind":"needs-human","priority":"P0","waiting_since":"2026-10-29T18:24:18Z","ask":"Ship 1.0 today?","recommendation":"Yes, CI is green.","target":"https://github.com/jmarrero-forge/tracker/issues/446","head":null,"action":{"type":"issue","repository":"jmarrero-forge/tracker","number":446},"source_ref":{"type":"hold","repository":"jmarrero-forge/tracker","number":446}},
{"key":"jmarrero-forge/bot-ops#5/comment-21","item":"jmarrero-forge/bot-ops#5","source":"proposals","kind":"operator-action","priority":null,"waiting_since":"2026-10-20T00:00:00Z","ask":"Label tracker#3","recommendation":"Because.","target":"https://github.com/jmarrero-forge/bot-ops/issues/5#issuecomment-21","head":null,"action":{"type":"operator_action","repository":"jmarrero-forge/bot-ops","number":5,"comment":21},"source_ref":{"type":"comment","repository":"jmarrero-forge/bot-ops","number":5,"comment":21}}]}`;

describe("parseNeedsYou", () => {
  it("reads the list agent-board documents", () => {
    const l = parseNeedsYou(JSON.parse(DOC_EXAMPLE));
    assert.ok(typeof l === "object");
    assert.deepEqual([l.complete, l.validatedAt, l.changedAt, l.summaries, l.omitted, l.refused], [true, "2026-10-30T09:30:00Z", "2026-10-30T09:00:00Z", "complete", 0, 0]);
    assert.deepEqual(l.items[0], { key: "jmarrero-forge/tracker#446", item: "jmarrero-forge/tracker#446", source: "items", kind: "needs-human", priority: "P0", waitingSince: "2026-10-29T18:24:18Z", ask: "Ship 1.0 today?", recommendation: "Yes, CI is green.", action: { type: "issue", repository: "jmarrero-forge/tracker", number: 446 }, carried: false });
    assert.deepEqual(l.items[1]!.action, { type: "operator_action", repository: "jmarrero-forge/bot-ops", number: 5, comment: 21 });
  });

  it("reads it from the hold comment, and an older one without it as no list", async () => {
    const at = "2026-10-30T09:30:00Z";
    assert.equal(typeof (await findHolds([holdsComment(at, rawNeedsYou([rawAsk(1)], at))]))?.needsYou, "object");
    assert.equal((await findHolds([holdsComment(at)]))?.needsYou, undefined);
  });

  // name, the list: each says why it can't be used, rather than a list
  const unusable: [string, unknown, RegExp][] = [
    ["v1, which had only the holds", { ...JSON.parse(DOC_EXAMPLE), schema: "agent-board/needs-you/v1" }, /schema "agent-board\/needs-you\/v1" is not/],
    ["a later schema", { ...JSON.parse(DOC_EXAMPLE), schema: "agent-board/needs-you/v3" }, /is not agent-board\/needs-you\/v2/],
    ["no validated_at", { ...JSON.parse(DOC_EXAMPLE), validated_at: "now" }, /malformed/],
    ["no sources", { ...JSON.parse(DOC_EXAMPLE), sources: {} }, /malformed/],
    ["items not a list", { ...JSON.parse(DOC_EXAMPLE), items: {} }, /malformed/],
    ["not an object", [], /not an object/],
  ];
  for (const [name, raw, why] of unusable) it(`can't use ${name}`, () => assert.match(String(parseNeedsYou(raw)), why));

  // name, an edit to one ask: it is left out, the others kept, and the list is not complete
  const refused: [string, Record<string, unknown>][] = [
    ["an action type it doesn't know", { action: { type: "merge_everything", repository: "o/r", number: 1 } }],
    ["a repository that climbs", { action: { type: "issue", repository: "o/..", number: 1 } }],
    ["an approval without its head", { action: { type: "approve_pull_request", repository: "o/r", number: 1 } }],
    ["a short head", { action: { type: "approve_pull_request", repository: "o/r", number: 1, head: "abc1234" } }],
    ["a proposal without its comment", { action: { type: "operator_action", repository: "o/r", number: 1 } }],
    ["a key that is no key", { key: "<b>" }],
    ["no ask", { ask: "" }],
    ["a priority the board has not", { priority: "urgent" }],
    ["a group without its representative first", { group: { reason: "drafts", numbers: [3, 2] } }],
    ["a group of no PRs", { group: { reason: "drafts", numbers: [] } }],
    ["a group without a reason", { group: { numbers: [2, 3] } }],
    ...[null, {}, { reason: "drafts", numbers: [] }, { reason: "", numbers: [2] },
      ...[0, -1, 1.5, "3", Number.MAX_SAFE_INTEGER + 1].map((n) => ({ reason: "drafts", numbers: [2, n] })),
      { reason: "drafts", numbers: [2, 2] }, { reason: "drafts", numbers: [3] },
      { reason: "drafts", numbers: Array.from({ length: 101 }, (_, i) => i + 1) },
    ].map((group): [string, Record<string, unknown>] => [`malformed group ${JSON.stringify(group)}`, { group, action: { type: "pull_request", repository: "o/r", number: 2 } }]),
    ["an issue group", { group: { reason: "drafts", numbers: [2] } }],
  ];
  for (const [name, edit] of refused) it(`leaves out ${name}`, () => {
    const l = parseNeedsYou(rawNeedsYou([rawAsk(1), rawAsk(2, edit)], "2026-10-30T09:30:00Z"));
    assert.ok(typeof l === "object");
    assert.deepEqual([l.items.map((a) => a.key), l.refused, l.complete], [["jmarrero-forge/tracker#1"], 1, false]);
  });

  it("joins well-formed request descriptors and keeps malformed ones read-only", () => {
    const action = (kind: string, supported = false) => ({ kind, supported, reason: `${kind}?` });
    const request = (n: number, over: Record<string, unknown> = {}) => ({ key: `jmarrero-forge/tracker#${n}`, forge: "github.com", quality: "decision", actions: [action("reply")], ...over });
    const l = parseNeedsYou(rawNeedsYou([rawAsk(1), rawAsk(2), rawAsk(3), rawAsk(4)], "2026-10-30T09:30:00Z", { requests: [
      request(1), request(1, { forge: "https://forgejo.example/git", actions: [action("close")] }),
      request(2, { quality: "fine" }), request(3, { actions: [{ kind: "reply", supported: "yes", reason: "r" }] }), request(9),
    ] }));
    assert.ok(typeof l === "object" && !l.complete);
    assert.deepEqual(l.items.map((a) => a.requests?.map((r) => [r.forge, r.actions.map((x) => x.kind)])), [[["github.com", ["reply"]], ["https://forgejo.example/git", ["close"]]], undefined, undefined, undefined]);
    assert.deepEqual(l.items.map((a) => a.requestsUnreadable), [undefined, true, true, true]);
  });

  it("never keeps the published target: links are made from the action", () => {
    const l = parseNeedsYou(rawNeedsYou([rawAsk(1, { target: "javascript:alert(1)" })], "2026-10-30T09:30:00Z"));
    assert.ok(typeof l === "object" && l.items.length === 1 && !("target" in l.items[0]!));
  });

  it("cuts an ask to its first line and 500 characters", () => {
    const l = parseNeedsYou(rawNeedsYou([rawAsk(1, { ask: `${"x".repeat(600)}\nmore` })], "2026-10-30T09:30:00Z"));
    assert.ok(typeof l === "object");
    assert.equal(l.items[0]!.ask, "x".repeat(500));
  });
});

describe("holdAsks", () => {
  it("lists the operator's holds on items, in the snapshot's order, and nothing else", () => {
    const holds = parseHolds(body(snapshot([wip, { ...human, operator: false, item: "jmarrero-forge/tracker#1", url: "https://github.com/jmarrero-forge/tracker/issues/1" }, human])))!;
    assert.deepEqual(holdAsks(holds).map((a) => [a.key, a.ask, a.priority, a.action]), [["jmarrero-forge/tracker#446", "Ship it?", "P0", { type: "issue", repository: "jmarrero-forge/tracker", number: 446 }]]);
  });
});

describe("loadHolds", () => {
  it("reads the usage issue's comments once, and no item's comments", async () => {
    const { fetchImpl, calls } = scriptedFetch((_m, url) => (url.endsWith(usagePath) ? { body: [comment(snapshot())] } : undefined));
    assert.equal((await loadHolds(new GitHub(async () => "t", fetchImpl)))?.holds.length, 2);
    assert.equal(calls.length, 1);
  });

  for (const status of [403, 404, 500]) it(`throws on HTTP ${status}, for the inbox to say`, async () => {
    const { fetchImpl } = scriptedFetch((_m, url) => (url.endsWith(usagePath) ? { status, body: { message: "Not Found" } } : undefined));
    await assert.rejects(loadHolds(new GitHub(async () => "t", fetchImpl)));
  });
});
