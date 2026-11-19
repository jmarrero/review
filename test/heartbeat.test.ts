import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import { findHeartbeat, HEARTBEAT_MARKER, heartbeatPath, isStale, loadHeartbeat, parseHeartbeat, type RawComment } from "../src/github/heartbeat.ts";
import { fixture, scriptedFetch } from "./helpers.ts";

const MIN = 60_000;
// The fixture's second comment is what bin/bot-heartbeat publish
// --dry-run wrote for a sample heartbeat; the first is someone else's
// copy of it, pointing elsewhere.
const comments = () => fixture<RawComment[]>("heartbeat-comments.json");
const body = (json: unknown) => `${HEARTBEAT_MARKER}\ntext\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;
const valid = () => ({
  schema: "bot-heartbeat/v1",
  updated_at: "2026-09-28T15:05:00Z",
  coordinator: { session: "s-1", loop_state: "sleeping" },
  workers: [{ name: "w", item_url: "https://github.com/o/r/pull/3", started_at: "2026-09-28T15:00:00Z", status: "testing" }],
});

describe("findHeartbeat", () => {
  it("reads the bot's comment as bot-heartbeat writes it, not a copy by someone else", () => {
    const hb = findHeartbeat(comments());
    assert.ok(hb);
    assert.deepEqual(hb, {
      updatedAt: "2026-09-28T15:05:00Z",
      session: "929c7a64-b3fd-49bd-933c-b7259b1253bd",
      loopState: "sleeping",
      nextWakeAt: "2026-09-28T15:25:00Z",
      workers: [
        { name: "ops-v2", itemUrl: "https://github.com/jmarrero-forge/review/pull/16", itemRef: "jmarrero-forge/review#16", startedAt: "2026-09-28T14:40:00Z", status: "testing", devspace: "selinux-3327" },
        { name: "bootc-2482", itemUrl: "https://github.com/bootc-dev/bootc/issues/2482", itemRef: "bootc-dev/bootc#2482", startedAt: "2026-09-28T15:01:30Z", status: "starting" },
      ],
      skipped: 0,
      commentUrl: "https://github.com/jmarrero-forge/tracker/issues/176#issuecomment-2",
    });
  });
  it("finds nothing among others' comments", () => assert.equal(findHeartbeat(comments().slice(0, 1)), undefined));
});

describe("parseHeartbeat", () => {
  type Edit = (j: ReturnType<typeof valid>) => unknown;
  const cases: [string, string | undefined, number | undefined][] = [
    ["valid", body(valid()), 1],
    ["no marker", body(valid()).replace(HEARTBEAT_MARKER, ""), undefined],
    ["no fence", `${HEARTBEAT_MARKER}\n{}`, undefined],
    ["broken JSON", `${HEARTBEAT_MARKER}\n\`\`\`json\n{\n\`\`\``, undefined],
    ["no body", undefined, undefined],
  ];
  for (const [what, text, workers] of cases) it(what, () => assert.equal(parseHeartbeat(text)?.workers.length, workers));

  const edits: [string, Edit, number | undefined, number?][] = [
    ["another schema", (j) => ({ ...j, schema: "bot-heartbeat/v2" }), undefined],
    ["no session", (j) => ({ ...j, coordinator: { loop_state: "sleeping" } }), undefined],
    ["bad updated_at", (j) => ({ ...j, updated_at: "now" }), undefined],
    ["workers not a list", (j) => ({ ...j, workers: {} }), undefined],
    ["a newer loop state, shown as is", (j) => ({ ...j, coordinator: { ...j.coordinator, loop_state: "compacting" } }), 1],
    ["a javascript: item", (j) => ({ ...j, workers: [{ ...j.workers[0], item_url: "javascript:alert(1)" }] }), 0, 1],
    ["an item off github.com", (j) => ({ ...j, workers: [{ ...j.workers[0], item_url: "https://evil.example/o/r/pull/3" }] }), 0, 1],
    ["markup in a name", (j) => ({ ...j, workers: [{ ...j.workers[0], name: "<img src=x>" }] }), 0, 1],
    ["a bad devspace is dropped, the worker kept", (j) => ({ ...j, workers: [{ ...j.workers[0], devspace: "A B" }] }), 1],
    ["too many workers", (j) => ({ ...j, workers: Array.from({ length: 40 }, () => j.workers[0]) }), 32, 8],
  ];
  for (const [what, edit, workers, skipped] of edits) {
    it(what, () => {
      const hb = parseHeartbeat(body(edit(valid())));
      assert.equal(hb?.workers.length, workers);
      if (skipped !== undefined) assert.equal(hb?.skipped, skipped);
    });
  }
  it("keeps no devspace it can't trust", () => {
    const j = valid();
    assert.equal(parseHeartbeat(body({ ...j, workers: [{ ...j.workers[0], devspace: "A B" }] }))?.workers[0]?.devspace, undefined);
  });
});

describe("isStale", () => {
  const at = Date.parse("2026-09-28T15:00:00Z");
  const hb = (over: Partial<NonNullable<ReturnType<typeof parseHeartbeat>>> = {}) => ({ updatedAt: "2026-09-28T15:00:00Z", session: "s", loopState: "polling", workers: [], skipped: 0, ...over });
  const cases: [string, ReturnType<typeof hb>, number, boolean][] = [
    ["fresh", hb(), at + 5 * MIN, false],
    ["15 minutes is the limit", hb(), at + 15 * MIN, false],
    ["older", hb(), at + 16 * MIN, true],
    ["asleep until later", hb({ loopState: "sleeping", nextWakeAt: "2026-09-28T15:30:00Z" }), at + 25 * MIN, false],
    ["within the grace after waking", hb({ loopState: "sleeping", nextWakeAt: "2026-09-28T15:30:00Z" }), at + 34 * MIN, false],
    ["past the grace", hb({ loopState: "sleeping", nextWakeAt: "2026-09-28T15:30:00Z" }), at + 36 * MIN, true],
    ["stopped is not stale", hb({ loopState: "stopped" }), at + 600 * MIN, false],
  ];
  for (const [what, h, now, want] of cases) it(what, () => assert.equal(isStale(h, now), want));
});

describe("loadHeartbeat", () => {
  it("reads the comments conditionally, and says when there is no heartbeat", async () => {
    let list: RawComment[] = [];
    const { fetchImpl, calls } = scriptedFetch((_m, url, headers) => {
      if (!url.endsWith(heartbeatPath)) return undefined;
      const etag = `"${list.length}"`;
      return headers["If-None-Match"] === etag ? { status: 304 } : { body: list, headers: { etag } };
    });
    const gh = new GitHub(async () => "t", fetchImpl);
    assert.equal(await loadHeartbeat(gh), null);
    list = comments();
    assert.equal((await loadHeartbeat(gh))?.workers.length, 2);
    assert.equal((await loadHeartbeat(gh))?.workers.length, 2);
    assert.deepEqual(calls.map((c) => c.headers["If-None-Match"]), [undefined, '"0"', '"2"']);
    assert.equal(new URL(calls[0]?.url ?? "").pathname, "/repos/jmarrero-forge/tracker/issues/1/comments");
  });
});
