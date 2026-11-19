import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { run } from "../src/cli/controlplane.ts";
import type { Io } from "../src/cli/queue.ts";
import { GitHub } from "../src/github/api.ts";
import { loadPassPublications } from "../src/github/holds.ts";
import { firstPublished, inboxCards } from "../src/github/inbox.ts";
import { usagePath } from "../src/github/usage.ts";
import { compressedHolds, fixture, publishedTestHolds, scriptedFetch } from "./helpers.ts";

const API = "https://api.github.com";
// A few minutes after the Act now fixture's validation; the pass view is a day older.
const NOW = new Date("2026-11-06T12:05:00Z");

/** The pass's holds comment, carrying the Act now, pass view and repository board fixtures. */
function holdsComment(over: Record<string, unknown> = {}) {
  const needs_you = fixture<{ needs_you: unknown }>("act-now-needs-you.json").needs_you;
  const snapshot = {
    schema: "agent-board/holds/v1", at: "2026-11-06T12:00:00Z", holds: publishedTestHolds(needs_you), needs_you,
    pass_view: fixture<{ pass_view: unknown }>("pass-view.json").pass_view, dispatchable_work: fixture("dispatchable-work.json"), ...over,
  };
  return [{ user: { login: "jmarrero-bot" }, body: `<!-- agent-board-holds v1 -->\n\`\`\`json\n${JSON.stringify(snapshot)}\n\`\`\`` }];
}

type Route = Parameters<typeof scriptedFetch>[0];

/** The agent workflows' run lists: one in flight on tracker's dispatch.yml unless the route answers. */
const WORKFLOW_RUNS = /\/actions\/workflows\/(dispatch|agent)\.yml\/runs\?status=(\w+)&per_page=100$/;
const LIVE = { id: 7, display_title: "implement example/work#11 (claude)", status: "in_progress", created_at: "2026-11-06T11:00:00Z", run_started_at: "2026-11-06T11:00:00Z", repository: { full_name: "jmarrero-forge/tracker" } };

async function cli(argv: string[], comments: unknown = holdsComment(), route: Route = () => undefined) {
  const { fetchImpl, calls } = scriptedFetch((method, url, headers) => method === "GET" && url === `${API}${usagePath}` ? { body: comments }
    : route(method, url, headers) ?? (method === "GET" && WORKFLOW_RUNS.exec(url) ? { body: { total_count: 1, workflow_runs: url.includes("tracker/actions/workflows/dispatch.yml/runs?status=in_progress") ? [LIVE] : [] } } : undefined));
  let stdout = "";
  let stderr = "";
  const io: Io = { fetch: fetchImpl, token: async () => "t", stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), isTty: false, now: () => NOW };
  const status = await run(argv, io);
  return { status, stdout, stderr, calls, json: () => JSON.parse(stdout) };
}

describe("control-app", () => {
  it("help uses the new name and explains the compatibility alias without reads", async () => {
    const r = await cli(["--help"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Usage: control-app COMMAND/);
    assert.match(r.stdout, /control app's state/);
    assert.match(r.stdout, /control-plane remains an alias for one release/);
    assert.equal(r.calls.length, 0);
  });

  it("status: live agents, capacity and the last passes with no-start reasons", async () => {
    const r = await cli(["status"]);
    assert.equal(r.status, 0, r.stderr);
    const doc = r.json();
    assert.equal(doc.schema, "control-plane/v1");
    assert.equal(doc.command, "status");
    assert.equal(doc.stale, true);
    assert.deepEqual(doc.live[0], { state: "running", item: "example/work#11", kind: "implement", pool: "claude", startedAt: "2026-11-05T11:55:00Z", url: "https://github.com/example/work/issues/11", run: "https://github.com/example/runner/actions/runs/42" });
    assert.deepEqual(doc.live.slice(1).map((f: { url: string }) => f.url), ["https://github.com/example/work/pull/14", "https://github.com/example/work/pull/15"]);
    assert.deepEqual(doc.pools.map((p: { name: string }) => p.name), ["openai", "claude", "other"]);
    assert.deepEqual(doc.passes[0].noStart.map((n: { kind: string }) => n.kind), ["no-ready-work", "replan-delay", "capped", "held"]);
    assert.equal(doc.passes[1].started.length, 2);
    assert.equal(doc.snapshotAt, "2026-11-06T12:00:00Z");
    assert.deepEqual(doc.agents, [{ item: "example/work#11", kind: "implement", pool: "claude", status: "in_progress", startedAt: "2026-11-06T11:00:00Z", title: "implement example/work#11 (claude)", listedByPass: false, url: "https://github.com/example/work/issues/11", run: "https://github.com/jmarrero-forge/tracker/actions/runs/7" }]);
    // Every request was a read: the publication and the agent workflows' run lists.
    assert.deepEqual([...new Set(r.calls.map((c) => c.method))], ["GET"]);
    assert.equal(r.calls.length, 1 + 6);
  });

  it("act-now: Home's shortlist, decisions first, then ranked by what it unblocks, with links", async () => {
    const r = await cli(["act-now"]);
    assert.equal(r.status, 0, r.stderr);
    const rows = r.json().rows as { key: string; unblocks: number; url: string; mergeRefusal: string | null; fallback: boolean }[];
    assert.deepEqual(rows.map((x) => [x.key, x.unblocks]), [["o/t#10", 1], ["o/t#20", 63], ["o/t#30", 3], ["o/a#1", 1]]);
    assert.ok(rows.every((x) => x.fallback === false));
    assert.ok(rows.every((x) => x.url.startsWith("https://github.com/o/")));
  });

  it("act-now: nothing from a list past its age bound", async () => {
    const needs_you = { ...fixture<{ needs_you: Record<string, unknown> }>("act-now-needs-you.json").needs_you, validated_at: "2026-11-06T09:00:00Z" };
    const r = await cli(["act-now"], holdsComment({ needs_you }));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json().rows, []);
  });

  describe("needs-you", () => {
    const actNowList = () => fixture<{ needs_you: Record<string, unknown> & { items: { key: string }[] } }>("act-now-needs-you.json").needs_you;
    // The same snapshot, read with the same loader, as the panel would derive it.
    async function panelCards(comments: unknown) {
      const { fetchImpl } = scriptedFetch((method, url) => (method === "GET" && url === `${API}${usagePath}` ? { body: comments } : undefined));
      const { holds } = await loadPassPublications(new GitHub(async () => "t", fetchImpl));
      return inboxCards({ published: firstPublished(holds!, NOW.getTime()) }).map((c) => c.key);
    }

    for (const { name, comments, keys, listError, detailMissing } of [
      { name: "a complete list, in inventory order", comments: holdsComment(),
        keys: ["o/t#11", "o/t#2", "o/t#7", "o/t#10", "o/t#20", "o/t#30", "o/a#1", "o/a#2", "o/a#3", "o/d#1/digest", "o/ops#1"], listError: null, detailMissing: [] },
      { name: "an identity whose detail is missing, as a placeholder in its place",
        comments: holdsComment({ needs_you: { ...actNowList(), items: actNowList().items.filter((i) => i.key !== "o/t#7") } }),
        keys: ["o/t#11", "o/t#2", "o/t#7", "o/t#10", "o/t#20", "o/t#30", "o/a#1", "o/a#2", "o/a#3", "o/d#1/digest", "o/ops#1"], listError: null, detailMissing: ["o/t#7"] },
      { name: "the snapshot's own operator holds without a list", comments: holdsComment({ needs_you: undefined }),
        keys: undefined, listError: /has no needs-you list/, detailMissing: [] },
      { name: "the snapshot's own operator holds with an unusable list", comments: holdsComment({ needs_you: "garbage" }),
        keys: undefined, listError: /needs-you list can't be used/, detailMissing: [] },
    ]) {
      it(name, async () => {
        const r = await cli(["needs-you"], comments);
        assert.equal(r.status, 0, r.stderr);
        const doc = r.json();
        assert.equal(doc.command, "needs-you");
        assert.equal(doc.snapshotAt, "2026-11-06T12:00:00Z");
        const cards = doc.cards as { key: string; url: string | null; detailMissing: boolean }[];
        // The panel's derivation gives the same cards in the same order.
        assert.deepEqual(cards.map((c) => c.key), await panelCards(comments));
        if (keys) assert.deepEqual(cards.map((c) => c.key), keys);
        assert.deepEqual(cards.filter((c) => c.detailMissing).map((c) => c.key), detailMissing);
        if (listError) {
          assert.match(doc.listError, listError);
          assert.equal(doc.validatedAt, null);
          assert.ok(cards.length > 0 && cards.every((c) => c.url?.startsWith("https://github.com/")));
          assert.match(doc.note, /snapshot's own operator holds/);
        } else {
          assert.equal(doc.listError, null);
          assert.equal(doc.validatedAt, "2026-11-06T12:00:00Z");
          assert.match(doc.note, /checked on GitHub/);
          assert.equal(doc.settled, doc.complete);
        }
        assert.deepEqual([...new Set(r.calls.map((c) => c.method))], ["GET"]);
      });
    }

    it("a card names its ask, recommendation, source and link", async () => {
      const [first] = (await cli(["needs-you"])).json().cards;
      assert.deepEqual(first, {
        key: "o/t#11", kind: "answer", title: "Pick A or B for o/t#11?", where: "o/t#11 · needs-human", url: "https://github.com/o/t/issues/11", since: "2026-11-06T12:00:00Z",
        priority: "P0", note: "Carried over: the pass did not read its source again. The pass marks this request unverified-carried.", unavailable: false, item: "o/t#11", source: "items", askKind: "needs-human", recommendation: null, detailMissing: false,
      });
    });

    it("fails, naming why, without a hold snapshot", async () => {
      const r = await cli(["needs-you"], []);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /no hold snapshot/);
    });
  });

  it("repo: one repository's work, live runs and asks, case-insensitively", async () => {
    const r = await cli(["repo", "Example/Work"]);
    assert.equal(r.status, 0, r.stderr);
    const doc = r.json();
    assert.equal(doc.repository, "example/work");
    assert.equal(doc.work.count, 5);
    assert.equal(doc.work.items[0].url, "https://github.com/example/work/issues/8");
    assert.equal(doc.live.length, 3);
    assert.deepEqual(doc.asks, []);
    const unknown = (await cli(["repo", "o/t"])).json();
    assert.equal(unknown.work, null);
    assert.ok(unknown.asks.length > 0);
  });

  it("changes: passes and asks after --since", async () => {
    const r = await cli(["changes", "--since", "2026-11-05T11:52:00Z"]);
    assert.equal(r.status, 0, r.stderr);
    const doc = r.json();
    assert.deepEqual(doc.passes.map((p: { at: string }) => p.at), ["2026-11-05T12:00:00Z", "2026-11-05T11:55:00Z"]);
    assert.equal(doc.passesCovered, true);
    assert.ok(doc.asks.every((a: { waitingSince: string }) => a.waitingSince > "2026-11-05T11:52:00Z"));
    assert.equal((await cli(["changes", "--since=2026-01-01T00:00:00Z"])).json().passesCovered, false);
  });

  for (const [argv, why] of [[[], /a command is needed/], [["fold"], /unknown command/], [["repo"], /OWNER\/REPO/], [["repo", "a/b", "c"], /OWNER\/REPO/],
    [["changes"], /--since/], [["changes", "--since", "yesterday"], /--since/], [["status", "x"], /no arguments/], [["needs-you", "x"], /no arguments/],
    [["cancel", "42"], /--dry-run or --yes/], [["cancel", "42", "--dry-run", "--yes"], /--dry-run or --yes/], [["cancel", "--dry-run"], /needs one RUN/],
    [["retry", "x", "--yes"], /needs one RUN/], [["run-pass", "--yes", "now"], /no arguments/], [["run-pass", "--yes", "--kind", "fix"], /takes no --kind/],
    [["dispatch", "o/r", "--kind", "fix", "--brief", "b", "--yes"], /OWNER\/REPO#N/], [["dispatch", "o/r#1", "--brief", "b", "--yes"], /needs --kind/],
    [["dispatch", "o/r#1", "--kind", "fix", "--kind", "fix", "--brief", "b", "--yes"], /given twice/],
    [["file", "--title", "t", "--yes"], /--epic N/], [["file", "--epic", "3", "--yes"], /needs --title/]] as const) {
    it(`refuses ${JSON.stringify(argv)} as usage`, async () => {
      const r = await cli([...argv]);
      assert.equal(r.status, 2);
      assert.match(r.stderr, why);
      assert.equal(r.calls.length, 0);
    });
  }

  it("reads the pass view from a snapshot published compressed across comments (agent-board#774)", async () => {
    const [plain] = holdsComment();
    const r = await cli(["status"], compressedHolds(plain!.body, "2026-11-06T12:00:00Z", 2_000));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json(), (await cli(["status"])).json());
  });

  it("status lists the agents in flight, naming why, without a usable publication", async () => {
    const none = await cli(["status"], []);
    assert.equal(none.status, 0, none.stderr);
    assert.match(none.json().passViewError, /no hold snapshot/);
    assert.equal(none.json().agents.length, 1);
    const missing = await cli(["status"], holdsComment({ pass_view: undefined }));
    assert.equal(missing.status, 0, missing.stderr);
    assert.match(missing.json().passViewError, /has no pass view/);
    assert.equal(missing.json().snapshotAt, "2026-11-06T12:00:00Z");
    assert.equal(missing.json().live, null);
    const bad = await cli(["status"], holdsComment({ pass_view: { schema: "nope" } }));
    assert.match(bad.json().passViewError, /pass view can't be used/);
    assert.equal(bad.json().agents[0].item, "example/work#11");
  });

  it("the other read commands fail, naming why, without a usable publication", async () => {
    const none = await cli(["act-now"], []);
    assert.equal(none.status, 1);
    assert.match(none.stderr, /no hold snapshot/);
    const bad = await cli(["changes", "--since", "2026-11-01T00:00:00Z"], holdsComment({ pass_view: { schema: "nope" } }));
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /pass view can't be used/);
  });

  describe("act commands", () => {
    const RUN = `${API}/repos/example/runner/actions/runs/42`;
    const operator: Route = (method, url) => method === "GET" && url === `${API}/user` ? { body: { login: "jmarrero" } } : undefined;
    const liveRun: Route = (method, url) => operator(method, url, {}) ?? (method === "GET" && url === RUN
      ? { body: { id: 42, html_url: "https://github.com/example/runner/actions/runs/42", repository: { full_name: "example/runner" }, status: "in_progress" } }
      : method === "POST" && url === `${RUN}/cancel` ? { status: 202 } : undefined);
    const posts = (calls: { method: string }[]) => calls.filter((c) => c.method !== "GET");

    it("cancel --dry-run reads the run fresh and sends nothing", async () => {
      const r = await cli(["cancel", "https://github.com/example/runner/actions/runs/42", "--dry-run"], holdsComment(), liveRun);
      assert.equal(r.status, 0, r.stderr);
      const doc = r.json();
      assert.equal(doc.dryRun, true);
      assert.equal(doc.item, "example/work#11");
      assert.deepEqual(doc.wouldSend, [{ method: "POST", url: `${RUN}/cancel` }]);
      assert.deepEqual(posts(r.calls), []);
    });

    it("cancel --yes sends the cancel", async () => {
      const r = await cli(["cancel", "42", "--yes"], holdsComment(), liveRun);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(r.json().sent, [{ method: "POST", url: `${RUN}/cancel` }]);
      assert.deepEqual(posts(r.calls).map((c) => c.method), ["POST"]);
    });

    it("refuses a run the pass view doesn't list, before any request but the snapshot's", async () => {
      const r = await cli(["retry", "43", "--yes"], holdsComment(), liveRun);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /lists no run 43/);
      assert.equal(r.calls.length, 1);
    });

    it("dispatch comments a job plan on an open item", async () => {
      const route: Route = (method, url) => operator(method, url, {})
        ?? (method === "GET" && url === `${API}/repos/example/work/issues/8` ? { body: { state: "open", html_url: "https://github.com/example/work/issues/8" } } : undefined);
      const r = await cli(["dispatch", "example/work#8", "--kind", "implement", "--pool=claude", "--brief", "Fix it.", "--dry-run"], holdsComment(), route);
      assert.equal(r.status, 0, r.stderr);
      const [write] = r.json().wouldSend;
      assert.equal(write.url, `${API}/repos/example/work/issues/8/comments`);
      const plan = JSON.parse(/```agent-board-plan\n([\s\S]*)\n```/.exec(write.body.body)![1]!);
      assert.deepEqual(plan, { schema: "agent-board/job-plan/v1", repo: "example/work", item: 8, kind: "implement", runner: "hosted", pool: "claude", brief: "Fix it." });
      assert.deepEqual(posts(r.calls), []);
      assert.equal(r.json().runningChecked, true);
      for (const [argv, why] of [[["example/work#11", "--kind", "fix"], /lists example\/work#11 running/], [["example/work#8", "--kind", "deploy"], /not a valid/]] as const) {
        const refused = await cli(["dispatch", ...argv, "--brief", "b", "--yes"], holdsComment(), route);
        assert.equal(refused.status, 1);
        assert.match(refused.stderr, why);
        assert.deepEqual(posts(refused.calls), []);
      }
      // Without a pass view, or any snapshot, it still dispatches, saying it couldn't check.
      for (const comments of [holdsComment({ pass_view: undefined }), []]) {
        const blind = await cli(["dispatch", "example/work#8", "--kind", "implement", "--brief", "Fix it.", "--dry-run"], comments, route);
        assert.equal(blind.status, 0, blind.stderr);
        assert.equal(blind.json().runningChecked, false);
        assert.deepEqual(blind.json().wouldSend.map((w: { url: string }) => w.url), [`${API}/repos/example/work/issues/8/comments`]);
      }
    });

    it("run-pass --dry-run checks for an active pass and shows the dispatch, with no pass view needed", async () => {
      const tracker = `${API}/repos/jmarrero-forge/tracker`;
      const runs = (active: number): Route => (method, url) => operator(method, url, {}) ?? (method !== "GET" ? undefined
        : url === tracker ? { body: { default_branch: "main", permissions: { push: true } } }
          : url.startsWith(`${tracker}/actions/workflows/poll.yml/runs?status=in_progress`) ? { body: { total_count: active, workflow_runs: [] } }
            : url.startsWith(`${tracker}/actions/workflows/poll.yml/runs?`) ? { body: { total_count: 0, workflow_runs: [] } } : undefined);
      // The stale fixture view, none, or no snapshot at all: the view's checks are the caller's.
      for (const comments of [holdsComment(), holdsComment({ pass_view: undefined }), []]) {
        const r = await cli(["run-pass", "--dry-run"], comments, runs(0));
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(r.json().wouldSend, [{ method: "POST", url: `${tracker}/actions/workflows/poll.yml/dispatches`, body: { ref: "main", inputs: { apply: "true" }, return_run_details: true } }]);
        assert.ok(!r.calls.some((c) => c.url === `${API}${usagePath}`));
      }
      const refused = await cli(["run-pass", "--yes"], holdsComment(), runs(1));
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /A pass is active \(in_progress\)/);
      assert.deepEqual(posts(refused.calls), []);
    });

    it("file searches for duplicates, then files under the epic", async () => {
      const tracker = `${API}/repos/jmarrero-forge/tracker`;
      const route = (found: string): Route => (method, url) => method !== "GET" ? undefined
        : url.startsWith(`${API}/search/issues?`) ? { body: { items: [{ title: found, html_url: "https://github.com/jmarrero-forge/tracker/issues/5" }] } }
          : url === `${tracker}/issues/3` ? { body: { state: "open", labels: [{ name: "epic" }] } } : undefined;
      const argv = ["file", "--epic", "3", "--title", "Add fold", "--label", "infra", "--dry-run"];
      const r = await cli(argv, holdsComment(), route("Add fold to the CLI"));
      assert.equal(r.status, 0, r.stderr);
      const doc = r.json();
      assert.deepEqual(doc.similar, [{ title: "Add fold to the CLI", url: "https://github.com/jmarrero-forge/tracker/issues/5" }]);
      assert.equal(doc.url, null);
      assert.deepEqual(doc.wouldSend[0], { method: "POST", url: `${tracker}/issues`, body: { title: "Add fold", body: "", labels: ["needs-triage", "infra"] } });
      assert.equal(doc.wouldSend[1].url, `${tracker}/issues/3/sub_issues`);
      assert.match(decodeURIComponent(r.calls.find((c) => c.url.includes("/search/"))!.url), /repo:jmarrero-forge\/tracker is:issue is:open in:title "Add fold"/);
      const dup = await cli(argv, holdsComment(), route("add fold"));
      assert.equal(dup.status, 1);
      assert.match(dup.stderr, /issues\/5 is open with this title/);
    });
  });

  it("hands queue to review-queue", async () => {
    const r = await cli(["queue", "--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^Usage: review-queue/);
  });
});
