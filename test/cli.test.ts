import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALL } from "../src/github/filter.ts";
import { type ActionJson, age, type EntryJson, printable, type QueueJson, SCHEMA, suggestedAction } from "../src/github/export.ts";
import type { Entry } from "../src/github/queue.ts";
import type { PrWait } from "../src/github/waiting.ts";
import { type Io, parseArgs, readOnly, run, tokenFrom, UsageError } from "../src/cli/queue.ts";
import { fields, fixture, rawItems, scriptedFetch, type Scripted } from "./helpers.ts";

const API = "https://api.github.com";
const PROJECT = `${API}/orgs/jmarrero-forge/projectsV2/1`;
const NOW = new Date("2026-01-20T00:00:00Z");
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

/** His review of a forge PR at `commit`. */
const approved = (commit: string) => [{ user: { login: "jmarrero" }, state: "APPROVED", submitted_at: "2026-01-11T00:00:00Z", commit_id: commit }];

/** The board, the forge and their reviews, from fixtures; anything else is unexpected. */
function world(method: string, url: string): Scripted | undefined {
  if (method !== "GET") return undefined;
  const path = url.slice(API.length);
  if (url.startsWith(`${PROJECT}/fields`)) return { body: fields() };
  if (url.startsWith(`${PROJECT}/items`)) return { body: [...rawItems(), ...fixture<unknown[]>("cli-questions.json")] };
  if (path.startsWith("/search/issues?")) {
    // These drafts are forge entries, not explicit review requests.
    if (decodeURIComponent(path).includes("user-review-requested:")) return { body: { total_count: 0, items: [] } };
    return { body: fixture("forge-search.json") };
  }
  const pulls = /^\/repos\/jmarrero-forge\/(\w+)\/pulls\?state=open/.exec(path);
  if (pulls) {
    const n = { widget: 5, homegit: 9, bootc: 3 }[pulls[1] as string];
    return { body: [{ number: n, html_url: "", head: { sha: HEAD }, base: {} }] };
  }
  if (/^\/repos\/jmarrero-forge\/homegit\/pulls\/9\/reviews/.test(path)) return { body: approved(HEAD) };
  if (/^\/repos\/jmarrero-forge\/bootc\/pulls\/3\/reviews/.test(path)) return { body: approved(OLD) };
  if (/^\/repos\/jmarrero-forge\/\w+\/(pulls\/\d+\/reviews|issues\/\d+\/comments)/.test(path)) return { body: [] };
  // The one open question with comments: only the bot's, so unanswered.
  if (path.startsWith("/repos/jmarrero-forge/tracker/issues/21/comments")) {
    return { body: [{ user: { login: "jmarrero-bot" }, created_at: "2026-01-06T00:00:00Z", html_url: "https://github.com/c/1", body: "ping" }] };
  }
  return undefined;
}

async function runCli(argv: string[], route = world, isTty = false) {
  const { fetchImpl, calls } = scriptedFetch(route);
  let stdout = "";
  let stderr = "";
  const io: Io = {
    fetch: fetchImpl,
    token: async () => "t",
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    isTty,
    now: () => NOW,
  };
  const status = await run(argv, io);
  return { status, stdout, stderr, calls };
}

/** An entry as `key verb`, its nested asks indented. */
function outline(entries: readonly EntryJson[], indent = ""): string[] {
  return entries.flatMap((e) => [`${indent}${e.key} ${e.action.verb}`, ...outline(e.asks, `${indent}  `)]);
}

describe("review-queue --json", () => {
  // The draft item is Needs human with no ask: a bot bug. The closed
  // question is a tracker issue with no target, so it has no org.
  const all = [
    "item:PVTI_synthetic_draft report-bug",
    "item:PVTI_synthetic_epic see-asks",
    "  item:PVTI_synthetic_question answer",
    "item:PVTI_synthetic_upstream_pr see-asks",
    "  item:PVTI_synthetic_upstream_question answer",
    "pr:jmarrero-forge/widget#5 review",
    "item:PVTI_synthetic_upstream_issue see-asks",
    "  item:PVTI_synthetic_review_ask review",
    "  item:PVTI_synthetic_chore_ask rerun",
    "item:PVTI_synthetic_redacted report-bug",
    "item:PVTI_synthetic_unrecommended_question answer",
    "item:PVTI_synthetic_open_question answer",
    "pr:jmarrero-forge/homegit#9 comment",
    "pr:jmarrero-forge/bootc#3 review",
    "item:PVTI_synthetic_home_issue report-bug",
    "item:PVTI_synthetic_closed_question wait",
  ];
  const cases: { name: string; argv: string[]; want: string[] }[] = [
    { name: "everything, ranked as the app ranks it", argv: ["--json"], want: all },
    {
      name: "composefs: upstream work only",
      argv: ["--json", "--filter", "composefs"],
      want: all.filter((l) => /widget#5|upstream_issue|review_ask|chore_ask|upstream_pr|upstream_question|bootc#3/.test(l)),
    },
    { name: "infra: the bot's own", argv: ["--json", "--filter=infra"], want: ["pr:jmarrero-forge/homegit#9 comment", "item:PVTI_synthetic_home_issue report-bug"] },
    { name: "a bare priority", argv: ["--json", "--filter", "P0"], want: all.slice(0, 3) },
    { name: "one org and a priority", argv: ["--json", "--filter", "org:bootc-dev+P1"], want: [] },
    { name: "org and no priority", argv: ["--filter", "org:bootc-dev+none"], want: ["pr:jmarrero-forge/bootc#3 review"] },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const r = await runCli(c.argv);
      assert.equal(r.stderr, "");
      assert.equal(r.status, 0);
      const doc = JSON.parse(r.stdout) as QueueJson;
      assert.equal(doc.schema, SCHEMA);
      assert.deepEqual(outline(doc.entries), c.want);
      assert.equal(doc.counts.rows, c.want.length);
      assert.ok(r.calls.every((x) => x.method === "GET"));
    });
  }

  it("describes an entry fully", async () => {
    const doc = JSON.parse((await runCli(["--json"])).stdout) as QueueJson;
    assert.equal(doc.generatedAt, NOW.toISOString());
    assert.equal(doc.filter, "all");
    const pr = doc.entries.find((e) => e.kind === "pr" && e.where === "jmarrero-forge/bootc#3");
    assert.deepEqual(pr, {
      key: "pr:jmarrero-forge/bootc#3",
      kind: "pr",
      title: "lib: Pushed since the approval",
      where: "jmarrero-forge/bootc#3",
      priority: null,
      rankPriority: null,
      org: "bootc-dev",
      since: "2026-01-02T00:00:00Z",
      settled: false,
      bug: false,
      url: "https://github.com/jmarrero-forge/bootc/pull/3",
      appUrl: "https://jmarrero.github.io/review/#pr/jmarrero-forge/bootc/3",
      verdict: { state: "approved-older", label: "approved an older head" },
      action: { verb: "review", summary: "review the commits pushed since your approval" },
      asks: [],
    });
    assert.deepEqual(doc.counts, { entries: 12, rows: 16, open: 12 });
    const asks = doc.entries.find((e) => e.key === "item:PVTI_synthetic_upstream_issue")?.asks ?? [];
    assert.deepEqual(
      asks.map((a) => a.action.targets),
      [
        ["https://github.com/example-upstream/widget/pull/50"],
        ["https://github.com/example-upstream/widget/actions/runs/777"],
      ],
    );
    const summaries = ["item:PVTI_synthetic_unrecommended_question", "item:PVTI_synthetic_open_question"].map(
      (k) => doc.entries.find((e) => e.key === k)?.action.summary,
    );
    assert.deepEqual(summaries, ["answer the question (no option is recommended)", "answer the question (in your own words: it offers no options)"]);
    const q = doc.entries.find((e) => e.key === "item:PVTI_synthetic_epic")?.asks[0];
    assert.equal(q?.question?.options[0]?.recommended, true);
    assert.equal(q?.priority, "P0");
  });

  it("degrades to the board alone when the forge can't be read, with a warning", async () => {
    const r = await runCli(["--json"], (m, url) => (url.includes("/search/") ? { status: 503, body: { message: "down" } } : world(m, url)));
    assert.equal(r.status, 0);
    const doc = JSON.parse(r.stdout) as QueueJson;
    // The one search failed, so neither list of PRs was read.
    assert.equal(doc.warnings.length, 2);
    assert.match(r.stderr, /warning: couldn't read the forge's PRs.*503/);
    assert.match(r.stderr, /warning: couldn't read the bot's other PRs.*503/);
    assert.ok(!doc.entries.some((e) => e.kind === "pr"));
  });

  it("fails on an unreadable board", async () => {
    const r = await runCli(["--json"], () => ({ status: 401, body: { message: "Bad credentials" } }));
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "review-queue: GitHub refused the token (HTTP 401); check $GH_TOKEN/$GITHUB_TOKEN, or `gh auth status`; the token needs read:project for the board\n");
  });
});

describe("review-queue: whose turn a PR is", () => {
  const UPSTREAM = "https://github.com/example-upstream/widget/pull/60";
  /** His change request on widget#5 at its head, and the bot's reply if `replied`. */
  const turns =
    (replied: boolean) =>
    (method: string, url: string): Scripted | undefined => {
      const path = url.slice(API.length);
      // The requests search finds an upstream PR asking for his review; the other search, the forge's drafts.
      if (path.startsWith("/search/issues?") && decodeURIComponent(path).includes("user-review-requested:")) {
        const item = { html_url: UPSTREAM, title: "widget: Upstream fix", body: "", user: { login: "jmarrero-bot" }, created_at: "2026-01-07T00:00:00Z", updated_at: "2026-01-08T00:00:00Z", draft: false, pull_request: {} };
        return { body: { total_count: 1, items: [item] } };
      }
      if (path.startsWith("/repos/jmarrero-forge/widget/pulls/5/reviews")) {
        return { body: [{ user: { login: "jmarrero" }, state: "CHANGES_REQUESTED", submitted_at: "2026-01-11T00:00:00Z", commit_id: HEAD }] };
      }
      if (path.startsWith("/repos/jmarrero-forge/widget/issues/5/comments")) {
        return { body: replied ? [{ user: { login: "jmarrero-bot" }, created_at: "2026-01-12T00:00:00Z", html_url: "https://github.com/c/2", body: "done" }] : [] };
      }
      if (/^\/repos\/jmarrero-forge\/\w+\/pulls\/\d+\/comments/.test(path)) return { body: [] };
      if (path === "/repos/example-upstream/widget/pulls/60") {
        return { body: { number: 60, html_url: UPSTREAM, state: "open", title: "widget: Upstream fix", requested_reviewers: [{ login: "jmarrero" }], head: { sha: HEAD }, base: { ref: "main" } } };
      }
      if (path.startsWith("/repos/example-upstream/widget/commits/")) return { body: { total_count: 0, check_runs: [] } };
      if (/^\/repos\/example-upstream\/widget\/(rules|pulls\/60\/reviews|issues\/60\/(comments|timeline))/.test(path)) return { body: [] };
      return world(method, url);
    };
  const pr = (doc: QueueJson, where: string) => doc.entries.find((e) => e.where === where);

  it("waits on the bot for a PR he sent back, last and not open", async () => {
    const r = await runCli(["--json"], turns(false));
    assert.equal(r.stderr, "");
    const doc = JSON.parse(r.stdout) as QueueJson;
    const forge = pr(doc, "jmarrero-forge/widget#5");
    assert.deepEqual(forge?.wait, { onBot: true, reasons: [] });
    assert.equal(forge?.action.verb, "wait");
    assert.equal(doc.entries.at(-1), forge);
    // The base's 12 open, less widget#5, plus the upstream PR.
    assert.equal(doc.counts.open, 12);
    const text = (await runCli(["--text"], turns(false), true)).stdout.split("\n");
    const group = text.indexOf("== Changes requested, waiting on the bot");
    assert.ok(group > 0);
    assert.match(text[group + 1] ?? "", /jmarrero-forge\/widget#5/);
  });

  it("is his again once the bot replied", async () => {
    const doc = JSON.parse((await runCli(["--json"], turns(true))).stdout) as QueueJson;
    const forge = pr(doc, "jmarrero-forge/widget#5");
    assert.deepEqual(forge?.wait, { onBot: false, reasons: ["updated"] });
    assert.deepEqual(forge?.action, { verb: "review", summary: "the bot responded to your change request" });
    assert.equal(doc.counts.open, 13);
  });

  it("lists the bot's upstream PR that requests his review", async () => {
    const doc = JSON.parse((await runCli(["--json"], turns(false))).stdout) as QueueJson;
    const up = pr(doc, "example-upstream/widget#60");
    assert.equal(up?.kind, "pr");
    assert.deepEqual(up?.wait, { onBot: false, reasons: ["review-requested"] });
    assert.deepEqual(up?.action, { verb: "review", summary: "review requested" });
  });

  it("still lists it when a forge PR's reviews can't be read", async () => {
    const route = turns(false);
    const r = await runCli(["--json"], (m, url) => (url.includes("/jmarrero-forge/bootc/pulls/3/reviews") ? { status: 503, body: { message: "down" } } : route(m, url)));
    const doc = JSON.parse(r.stdout) as QueueJson;
    assert.deepEqual(doc.warnings.map((w) => w.split(":")[0]), ["couldn't read the forge's PRs or their reviews"]);
    assert.ok(pr(doc, "example-upstream/widget#60"));
  });
});

describe("a PR's action from its turn", () => {
  const entry = (wait: PrWait): Entry => ({ key: "pr:o/r#1", kind: "pr", title: "t", where: "o/r#1", href: "#pr/o/r/1", wait });
  const run = { url: "https://github.com/o/r/actions/runs/9", owner: "o", repo: "r", id: "9" };
  const cases: [string, PrWait, ActionJson][] = [
    ["re-sign", { reasons: ["resign"], onBot: false, unsigned: ["abc1234"] }, { verb: "review", summary: "approve to re-sign (DCO): abc1234 lack your Signed-off-by" }],
    ["rerun alone", { reasons: ["rerun"], onBot: false, failed: ["ci/test"], runs: [run] }, { verb: "rerun", summary: "required checks failed: rerun: ci/test", targets: [run.url] }],
    ["review and rerun", { reasons: ["review-requested", "rerun"], onBot: false, runs: [run] }, { verb: "review", summary: "review requested; required checks failed: rerun", targets: [run.url] }],
    ["on the bot", { reasons: [], onBot: true }, { verb: "wait", summary: "you requested changes; the bot acts next" }],
  ];
  for (const [name, wait, want] of cases) it(name, () => assert.deepEqual(suggestedAction(entry(wait)), want));
});

describe("review-queue --text", () => {
  it("groups by priority and shows the action and question", async () => {
    const r = await runCli(["--filter", "P0"], world, true);
    assert.equal(r.status, 0);
    const lines = r.stdout.split("\n");
    assert.match(lines[0] ?? "", /^2 open of 3 row\(s\) in 2 entries \(filter: all\+P0\)$/);
    assert.equal(lines[2], "== P0");
    assert.ok(lines.some((l) => /^ {4}question +jmarrero-forge\/tracker#21 /.test(l)));
    assert.ok(lines.some((l) => /-> answer: answer the question \(the bot recommends A\)/.test(l)));
    assert.ok(lines.some((l) => /A\) .*\(recommended\)$/.test(l)));
  });

  it("says when nothing waits, and warns about an org nothing targets", async () => {
    const r = await runCli(["--text", "--filter", "org:nobody"]);
    assert.match(r.stdout, /Nothing waiting on you\.\n$/);
    assert.match(r.stdout, /warning: no entry targets org nobody; the queue has bootc-dev, example-upstream, jmarrero-bot, no org, other\n/);
  });
});

describe("parseArgs", () => {
  const ok: [string[], string | undefined, string][] = [
    [[], undefined, "all"],
    [["--text"], "text", "all"],
    [["--json", "--filter", "composefs+P0"], "json", "composefs+P0"],
    [["--filter=none"], undefined, "all+none"],
    [["--filter", "org:none"], undefined, "no org"],
    [["--filter", "composefs+p0"], undefined, "composefs+P0"],
    [["--filter", "p1"], undefined, "all+P1"],
  ];
  for (const [argv, format, filter] of ok) {
    it(argv.join(" ") || "(none)", () => {
      const o = parseArgs(argv);
      assert.equal(o.format, format);
      const f = o.filter;
      const scope = typeof f.scope === "string" ? f.scope : f.scope.org;
      assert.equal(f.priority === undefined ? scope : `${scope}+${f.priority === "No priority" ? "none" : f.priority}`, filter);
    });
  }
  const bad: string[][] = [["--json", "--text"], ["--filter"], ["--filter", "bogus"], ["--filter", "composefs+P"], ["-x"]];
  for (const argv of bad) it(`refuses ${argv.join(" ")}`, () => assert.throws(() => parseArgs(argv), UsageError));

  it("prints usage on errors and --help", async () => {
    const bad = await runCli(["--nope"]);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /unknown argument "--nope"\nUsage:/);
    const help = await runCli(["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^Usage: review-queue/);
    assert.equal(help.calls.length, 0);
    assert.deepEqual(parseArgs([]).filter, ALL);
  });
});

describe("readOnly", () => {
  it("refuses anything but GET", async () => {
    const { fetchImpl, calls } = scriptedFetch(() => ({ body: {} }));
    const f = readOnly(fetchImpl);
    await f(`${API}/user`);
    for (const method of ["POST", "patch", "DELETE"]) await assert.rejects(f(`${API}/x`, { method }), /read-only/);
    assert.equal(calls.length, 1);
  });
});

describe("tokenFrom", () => {
  const cases: [Record<string, string>, string][] = [
    [{ GH_TOKEN: "a", GITHUB_TOKEN: "b" }, "a"],
    [{ GH_TOKEN: " ", GITHUB_TOKEN: "b" }, "b"],
    [{}, "from-gh"],
  ];
  for (const [env, want] of cases) {
    it(JSON.stringify(env), async () => {
      let asked = 0;
      const t = tokenFrom(env, async () => (asked++, "from-gh"));
      assert.equal(await t(), want);
      assert.equal(await t(), want);
      assert.ok(asked <= 1);
    });
  }
});

describe("a malformed token", () => {
  const secret = "ghp_secret";
  for (const bad of [`${secret}\nX-Evil: 1`, `${secret} x`, `${secret}\u00e9`]) {
    for (const source of ["env", "gh"] as const) {
      it(`${source}: ${JSON.stringify(bad)}`, async () => {
        const token = source === "env" ? tokenFrom({ GH_TOKEN: bad }) : tokenFrom({}, async () => bad);
        const { fetchImpl, calls } = scriptedFetch(world);
        let stderr = "";
        const status = await run(["--json"], { fetch: fetchImpl, token, stdout: () => {}, stderr: (s) => (stderr += s), isTty: false, now: () => NOW });
        assert.equal(status, 1);
        assert.equal(calls.length, 0);
        assert.match(stderr, /isn't one/);
        assert.ok(!stderr.includes(secret));
      });
    }
  }
});

describe("printable", () => {
  const cases: [string, string, string][] = [
    ["plain text and newlines", "a title\nnext", "a title\nnext"],
    ["an OSC title and a screen clear", "x\x1b]0;pwned\x07\x1b[2J", "x?]0;pwned??[2J"],
    ["DEL and the one-byte CSI", "a\x7fb\u009bc", "a?b?c"],
    ["a bidi override", "evil\u202eftp.exe", "evil?ftp.exe"],
    ["a tab and a carriage return", "a\tb\rc", "a?b?c"],
    ["emoji with a zero-width joiner", "\u{1F469}\u200d\u{1F4BB}", "\u{1F469}\u200d\u{1F4BB}"],
  ];
  for (const [name, input, want] of cases) it(name, () => assert.equal(printable(input), want));
});

describe("age", () => {
  const cases: [string | null, string][] = [
    [null, "?"],
    ["2026-01-19T23:30:00Z", "now"],
    ["2026-01-19T00:00:00Z", "24h"],
    ["2026-01-10T00:00:00Z", "10d"],
  ];
  for (const [since, want] of cases) it(String(since), () => assert.equal(age(since, NOW), want));
});
