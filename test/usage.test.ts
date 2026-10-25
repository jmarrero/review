import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import type { RawComment } from "../src/github/heartbeat.ts";
import { findUsage, loadUsage, MAX_RUNS, parseBudget, parseUsage, poolPace, spendByRun, tokenTotal, UNKNOWN_KIND, USAGE_CONFIG, USAGE_MARKER, usagePath } from "../src/github/usage.ts";
import { fixture, scriptedFetch } from "./helpers.ts";

// The fixture's second comment is what bin/bot-heartbeat publish
// --dry-run wrote to the private repository for a sample heartbeat; the
// first is someone else's copy of it, with other numbers.
const comments = () => fixture<RawComment[]>("usage-comments.json");
const body = (json: unknown) => `${USAGE_MARKER}\ntext\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;
const tokens = { input: 1, output: 2, cache_read: 3, cache_write: 4 };
const win = { kind: "five_hour", since: "2026-09-28T10:05:00Z", used_percent: 42.5, resets_at: "2026-09-28T15:05:00Z", requests: 7, tokens };
const valid = () => ({ schema: "bot-usage/v1", updated_at: "2026-09-28T15:05:00Z", session: "s-1", windows: [win], workers: [{ name: "w", tokens }] });

describe("findUsage", () => {
  it("reads the bot's comment as bot-heartbeat writes it, not a copy by someone else", () => {
    assert.deepEqual(findUsage(comments()), {
      updatedAt: "2026-09-28T15:05:00Z",
      observedAt: "2026-09-28T15:04:00Z",
      windows: [
        { kind: "five_hour", since: "2026-09-28T12:00:00Z", usedPercent: 42.5, resetsAt: "2026-09-28T17:00:00Z", requests: 4, tokens: { input: 100, output: 219000, cacheRead: 43800000, cacheWrite: 1440000 } },
        { kind: "seven_day", since: "2026-09-24T09:00:00Z", usedPercent: 63, resetsAt: "2026-10-01T09:00:00Z", requests: 5, tokens: { input: 200, output: 619000, cacheRead: 133800000, cacheWrite: 4440000 } },
      ],
      coordinatorTokens: { input: 40, output: 30000, cacheRead: 9000000, cacheWrite: 200000 },
      workers: [
        { name: "ops-v2", tokens: { input: 20, output: 60000, cacheRead: 4000000, cacheWrite: 150000 } },
        { name: "bootc-2482", tokens: { input: 10, output: 9000, cacheRead: 800000, cacheWrite: 90000 } },
      ],
      commentUrl: "https://github.com/jmarrero-forge/bot-ops/issues/1#issuecomment-2",
    });
  });
  it("finds nothing among others' comments", () => assert.equal(findUsage(comments().slice(0, 1)), undefined));
  // tracker's usage.yml snapshot, edited in place, after an older one still on the issue.
  const snapshot = () => fixture<RawComment[]>("usage-snapshot.json");
  it("reads the comment edited last, dated by its edit, whatever the order", () => {
    for (const list of [snapshot(), snapshot().reverse()]) {
      const u = findUsage(list);
      assert.equal(u?.commentUrl, "https://github.com/jmarrero-forge/bot-ops/issues/1#issuecomment-11");
      assert.equal(u?.updatedAt, "2026-10-18T14:42:00Z");
      assert.deepEqual(u?.windows, []);
      assert.deepEqual(u?.pools?.claude, { usedPercent: 73, allowedPercent: 73.2, resetsAt: "2026-10-19T23:00:00.000Z", observedAt: "2026-10-18T14:40:00.000Z", hold: false, windowMinutes: 10080 });
      assert.deepEqual([u?.pools?.openai?.usedPercent, u?.pools?.openai?.hold], [1, false]);
      assert.deepEqual(u?.mistral?.allowance, { limitUsd: 300, resetsAt: "2026-11-01T00:00:00Z", spentUsd: 41.25, estimated: false, unpriced: [], lowerBound: false });
    }
  });
  it("prefers the comment's edit time to the JSON's updated_at, and the JSON's to none", () => {
    const [old] = snapshot();
    assert.equal(findUsage([{ ...old!, updated_at: "2026-10-18T15:00:00Z" }])?.updatedAt, "2026-10-18T15:00:00Z");
    const { updated_at: _, ...undated } = old!;
    assert.equal(findUsage([undated])?.updatedAt, "2026-10-15T17:42:00Z");
    assert.equal(findUsage([{ ...old!, updated_at: "yesterday" }])?.updatedAt, "2026-10-15T17:42:00Z", "a malformed edit time is ignored");
  });
});

describe("parseUsage", () => {
  it("keeps null pools with counters or a valid snapshot timestamp", () => {
    const raw = fixture<Record<string, unknown>>("usage-null-pools.json");
    const parsed = parseUsage(body(raw));
    assert.deepEqual(parsed?.pools, {});
    assert.deepEqual(parsed?.windows, []);
    assert.deepEqual(parsed?.mistral, { requests: 2500, tokens: 1234567 });
    const empty = { ...raw, updated_at: undefined, observed_at: undefined, mistral: undefined };
    for (const field of ["updated_at", "observed_at", "mistral"]) {
      assert.ok(parseUsage(body({ ...empty, [field]: raw[field] })), field);
    }
    for (const edit of [{}, { updated_at: "now", observed_at: "soon", mistral: { requests: -1, tokens: 2 } }, { schema: "other" }]) {
      assert.equal(parseUsage(body({ ...empty, ...edit })), undefined);
    }
  });

  it("accepts pool-only publications and drops malformed pools independently", () => {
    const raw = fixture<{ pools: Record<string, Record<string, unknown>> }>("usage-pools.json");
    assert.equal(parseUsage(body(raw))?.pools?.openai?.usedPercent, 80);
    for (const edit of [{ used_percent: -1 }, { allowed_percent: "30" }, { resets_at: "soon" }, { observed_at: null }, { hold: "true" }]) {
      const parsed = parseUsage(body({ ...raw, pools: { ...raw.pools, openai: { ...raw.pools.openai, ...edit } } }));
      assert.equal(parsed?.pools?.openai, undefined);
      assert.equal(parsed?.pools?.claude?.usedPercent, 42);
    }
  });

  it("keeps a held pool's next dispatch time, and none for a bad time or an unheld pool", () => {
    const raw = fixture<{ pools: Record<string, Record<string, unknown>> }>("usage-pools.json");
    const openai = (edit: Record<string, unknown>) => parseUsage(body({ ...raw, pools: { openai: { ...raw.pools.openai, ...edit } } }))?.pools?.openai;
    assert.equal(openai({})?.nextDispatchAt, "2026-10-13T00:57:18.315Z");
    for (const edit of [{ next_dispatch_at: "soon" }, { next_dispatch_at: null }, { hold: false }]) {
      const pool = openai(edit);
      assert.equal(pool?.usedPercent, 80, JSON.stringify(edit));
      assert.equal(pool?.nextDispatchAt, undefined, JSON.stringify(edit));
    }
  });

  it("reads Mistral's counters when well formed, and shows nothing otherwise", () => {
    const raw = fixture<{ mistral?: unknown }>("usage-pools.json");
    assert.deepEqual(parseUsage(body(raw))?.mistral, { requests: 2500, tokens: 1234567 });
    for (const bad of [undefined, null, "x", {}, { requests: 2 }, { requests: -1, tokens: 5 }, { requests: 2, tokens: "5" }]) {
      assert.equal(parseUsage(body({ ...raw, mistral: bad }))?.mistral, undefined, JSON.stringify(bad));
    }
  });

  it("reads Mistral's allowance: its own spend first, else an estimate from tokens and prices", () => {
    const raw = fixture<{ mistral: Record<string, unknown> }>("usage-pools.json");
    const limit = { limit_usd: 300, resets_at: "2026-11-01T12:00:00Z" };
    const models = [
      { model: "mistral-large-latest", input_tokens: 1_000_000, output_tokens: 100_000 },
      { model: "codestral-latest", input_tokens: 500_000, output_tokens: 0 },
    ];
    const prices = { "mistral-large-latest": { input: 2, output: 6 }, "codestral-latest": { input: 0.3, output: 0.9 } };
    const allowance = (a: unknown) => parseUsage(body({ ...raw, mistral: { ...raw.mistral, allowance: a } }))?.mistral;
    assert.deepEqual(allowance({ ...limit, spent_usd: 0.92, models, prices })?.allowance, { limitUsd: 300, resetsAt: limit.resets_at, spentUsd: 0.92, estimated: false, unpriced: [], lowerBound: false });
    const est = allowance({ ...limit, models, prices })?.allowance;
    assert.equal(est?.estimated, true);
    assert.ok(Math.abs(est!.spentUsd - 2.75) < 1e-9, String(est?.spentUsd));
    assert.deepEqual(est?.unpriced, []);
    assert.equal(est?.lowerBound, false);
    assert.deepEqual(allowance({ ...limit, models: [], prices })?.allowance?.spentUsd, 0, "a month with no tokens yet is $0, not no meter");
    // A malformed entry beside priced ones is left out, and says so.
    const bent = allowance({ ...limit, models: [...models, { model: "mistral/large", input_tokens: 5e7, output_tokens: 0 }], prices })?.allowance;
    assert.deepEqual([bent?.unpriced, bent?.lowerBound], [[], true]);
    // A model without a price leaves a lower bound; one named like an Object property finds no price there.
    const partial = allowance({ ...limit, models: [...models, { model: "constructor", input_tokens: 5, output_tokens: 5 }], prices })?.allowance;
    assert.deepEqual([partial?.unpriced, partial?.lowerBound], [["constructor"], true]);
    assert.ok(Math.abs(partial!.spentUsd - 2.75) < 1e-9);
    // No allowance, or one that can't give a spend, keeps the counters alone.
    for (const bad of [undefined, {}, { ...limit, limit_usd: 0, spent_usd: 1 }, { ...limit, resets_at: "soon", spent_usd: 1 }, { ...limit, spent_usd: -1 }, { ...limit, spent_usd: "1" }, { ...limit, models }, { ...limit, models, prices: {} }, { ...limit, models: [{ model: "<b>", input_tokens: 1, output_tokens: 1 }], prices }]) {
      assert.deepEqual(allowance(bad), { requests: 2500, tokens: 1234567 }, JSON.stringify(bad));
    }
    const capped = allowance({ ...limit, models: Array.from({ length: 40 }, (_, i) => ({ ...models[0], model: `m${i}` })), prices: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`m${i}`, prices["mistral-large-latest"]])) })?.allowance;
    assert.deepEqual([capped?.spentUsd.toFixed(2), capped?.lowerBound], [(32 * 2.6).toFixed(2), true], "at most 32 models count, and the rest make it a lower bound");
  });

  // (edit, windows kept, whether the first has a percent, workers kept)
  type Json = ReturnType<typeof valid>;
  const cases: [string, (j: Json) => unknown, number | undefined, boolean?, number?][] = [
    ["valid", (j) => j, 1, true, 1],
    ["another schema (the heartbeat's)", (j) => ({ ...j, schema: "bot-heartbeat/v1" }), undefined],
    ["no updated_at", (j) => ({ ...j, updated_at: "now" }), undefined],
    ["no percent: tokens only", (j) => ({ ...j, windows: [{ ...win, used_percent: undefined, resets_at: undefined }] }), 1, false],
    ["a percent without its reset is dropped", (j) => ({ ...j, windows: [{ ...win, resets_at: "soon" }] }), 1, false],
    ["an absurd percent is dropped", (j) => ({ ...j, windows: [{ ...win, used_percent: 5000 }] }), 1, false],
    ["a newer kind, shown as is", (j) => ({ ...j, windows: [{ ...win, kind: "seven_day_opus" }] }), 1, true],
    ["markup in a kind", (j) => ({ ...j, windows: [{ ...win, kind: "<b>x</b>" }] }), 0],
    ["negative tokens", (j) => ({ ...j, windows: [{ ...win, tokens: { ...tokens, output: -1 } }] }), 0],
    ["tokens as text", (j) => ({ ...j, windows: [{ ...win, tokens: { ...tokens, input: "1" } }] }), 0],
    ["windows not a list", (j) => ({ ...j, windows: {} }), 0],
    ["too many windows", (j) => ({ ...j, windows: Array.from({ length: 9 }, () => win) }), 4, true],
    ["markup in a worker's name", (j) => ({ ...j, workers: [{ name: "<img src=x>", tokens }] }), 1, true, 0],
    ["a worker's absurd tokens", (j) => ({ ...j, workers: [{ name: "w", tokens: { ...tokens, output: Number.MAX_VALUE } }] }), 1, true, 0],
    ["no workers", (j) => ({ ...j, workers: undefined }), 1, true, 0],
  ];
  for (const [what, edit, windows, pct, workers] of cases) {
    it(what, () => {
      const u = parseUsage(body(edit(valid())));
      assert.equal(u?.windows.length, windows);
      if (pct !== undefined) assert.equal(u?.windows[0]?.usedPercent !== undefined, pct);
      if (workers !== undefined) assert.equal(u?.workers.length, workers);
    });
  }
  it("needs its marker", () => assert.equal(parseUsage(body(valid()).replace(USAGE_MARKER, "")), undefined));
  it("totals tokens", () => assert.equal(tokenTotal({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }), 10));
});

describe("runs in the snapshot", () => {
  const raw = () => fixture<{ runs: Record<string, unknown>[] }>("usage-runs.json");
  const runs = (edit: Record<string, unknown>) => parseUsage(body({ ...raw(), runs: [{ ...raw().runs[0], ...edit }] }))?.runs;
  it("reads each run's names and tokens, kind and item optional", () => {
    const u = parseUsage(body(raw()));
    assert.equal(u?.runs?.length, 5);
    assert.deepEqual(u?.runs?.[0], {
      repository: "jmarrero-forge/review", runId: 19876543210, pool: "claude", kind: "implement", item: "jmarrero-forge/review#99",
      finishedAt: "2026-10-18T13:30:00Z", requests: 412, tokens: { input: 120000, output: 310000, cacheRead: 41000000, cacheWrite: 2600000 },
    });
    assert.deepEqual(u?.runs?.[3], { repository: "jmarrero-forge/agentic-job", runId: 19876543213, pool: "mistral", finishedAt: "2026-10-18T02:00:00Z", tokens: { input: 500000, output: 20000, cacheRead: 0, cacheWrite: 0 } });
    assert.equal(u?.pools?.claude?.usedPercent, 73, "the pools are read as before");
  });
  it("tells no runs list from an empty one", () => {
    const { runs: _, ...without } = raw();
    assert.equal(parseUsage(body(without))?.runs, undefined);
    assert.deepEqual(parseUsage(body({ ...without, runs: [] }))?.runs, []);
    assert.equal(parseUsage(body({ ...without, runs: {} }))?.runs, undefined);
  });
  it("drops a malformed run, not the list", () => {
    for (const bad of [
      { repository: "review" }, { repository: "jmarrero-forge/.." }, { repository: "<b>/x" }, { run_id: "19876543210" }, { run_id: 1.5 }, { run_id: 0 }, { pool: "Claude" }, { pool: "<b>" },
      { finished_at: "yesterday" }, { finished_at: undefined }, { tokens: { input: 1, output: 2, cache_read: 3 } }, { tokens: { input: -1, output: 2, cache_read: 3, cache_write: 4 } },
    ]) {
      assert.deepEqual(runs(bad), [], JSON.stringify(bad));
    }
    assert.equal(parseUsage(body({ ...raw(), runs: [{ ...raw().runs[0], pool: "<b>" }, raw().runs[1]] }))?.runs?.length, 1);
  });
  it("counts a run listed twice once, by repository and run id", () => {
    const twice = parseUsage(body({ ...raw(), runs: [raw().runs[0], { ...raw().runs[0], kind: "review" }, { ...raw().runs[0], repository: "jmarrero-forge/tracker" }] }))?.runs;
    assert.deepEqual(twice?.map((r) => [r.repository, r.kind]), [["jmarrero-forge/review", "implement"], ["jmarrero-forge/tracker", "implement"]]);
  });
  it("leaves out a kind, item or request count it can't read, keeping the run", () => {
    for (const edit of [{ kind: "<img src=x>" }, { item: "jmarrero-forge/review" }, { item: "jmarrero-forge/review#0" }, { item: "../x#1" }, { requests: -1 }, { requests: "4" }]) {
      const [run] = runs(edit) ?? [];
      assert.ok(run, JSON.stringify(edit));
      const field = Object.keys(edit)[0] as "kind" | "item" | "requests";
      assert.equal(run?.[field], undefined, JSON.stringify(edit));
    }
  });
  it(`reads at most ${MAX_RUNS} runs`, () => {
    const many = Array.from({ length: MAX_RUNS + 20 }, (_, i) => ({ ...raw().runs[0], run_id: i + 1 }));
    assert.equal(parseUsage(body({ ...raw(), runs: many }))?.runs?.length, MAX_RUNS);
  });
});

describe("spendByRun", () => {
  const now = Date.parse("2026-10-18T14:44:00Z");
  const all = () => parseUsage(body(fixture("usage-runs.json")))!.runs!;
  it("keeps the day's runs, largest first, and totals them by kind and repository", () => {
    const spend = spendByRun(all(), now);
    assert.deepEqual(spend.runs.map((r) => r.runId), [19876543210, 19876543212, 19876543211, 19876543213], "the run of two days ago is left out");
    assert.deepEqual(spend.byKind, [
      { name: "implement", tokens: 44030000, runs: 1 },
      { name: "review", tokens: 11399000, runs: 2 },
      { name: UNKNOWN_KIND, tokens: 520000, runs: 1 },
    ]);
    assert.deepEqual(spend.byRepository, [
      { name: "jmarrero-forge/review", tokens: 52300000, runs: 2 },
      { name: "jmarrero-forge/tracker", tokens: 3129000, runs: 1 },
      { name: "jmarrero-forge/agentic-job", tokens: 520000, runs: 1 },
    ]);
  });
  it("leaves out a run dated after now, and finds nothing a day later", () => {
    assert.equal(spendByRun(all(), now - 60 * 60_000).runs.length, 3, "a run that finished after this now is not yet shown");
    assert.deepEqual(spendByRun(all(), now + 2 * 24 * 60 * 60_000), { runs: [], byKind: [], byRepository: [] });
  });
});

describe("loadUsage", () => {
  const load = async (status: number, list: unknown = comments()) => {
    const { fetchImpl, calls } = scriptedFetch((_m, url) => (url.endsWith(usagePath) ? { status, body: status === 200 ? list : { message: "x" } } : undefined));
    const data = await loadUsage(new GitHub(async () => "t", fetchImpl)).catch((e: Error) => e);
    return { data, path: new URL(calls[0]?.url ?? "").pathname };
  };
  it("reads the private repository's issue", async () => {
    const { data, path } = await load(200);
    assert.equal(path, "/repos/jmarrero-forge/bot-ops/issues/1/comments");
    assert.equal(!(data instanceof Error) && data.state, "ok");
  });
  it("says when none is published", async () => assert.deepEqual((await load(200, [])).data, { state: "none" }));
  for (const status of [403, 404]) it(`a ${status} is unreadable, not an error`, async () => assert.deepEqual((await load(status)).data, { state: "unreadable" }));
  it("any other failure is an error", async () => assert.ok((await load(500)).data instanceof Error));
});

describe("poolPace", () => {
  const pool = { usedPercent: 50, allowedPercent: 7.5, hold: true, windowMinutes: 10080, observedAt: "2026-10-16T01:05:00Z", resetsAt: "2026-10-22T11:52:00Z" };
  it("measures the share gone from the pool's own reset, and projects to its end", () => {
    // The panel of 16 Oct: OpenAI's week reset at 11:52 on 15 Oct, so 13 hours of 168 were gone.
    const pace = poolPace(pool);
    assert.equal(pace.unit, "week");
    assert.equal(pace.gonePercent.toFixed(1), "7.9");
    assert.equal(Math.round(pace.projectedPercent!), 636);
  });
  it("makes no projection early in a window, and names a window that isn't a week", () => {
    assert.equal(poolPace({ ...pool, observedAt: "2026-10-15T15:00:00Z" }).projectedPercent, undefined);
    assert.equal(poolPace({ ...pool, windowMinutes: 300, resetsAt: "2026-10-16T03:35:00Z" }).unit, "5h window");
    assert.equal(poolPace({ ...pool, windowMinutes: 300, resetsAt: "2026-10-16T03:35:00Z" }).gonePercent, 50);
  });
  it("reads window_minutes, a week when absent or nonsense", () => {
    const raw = fixture<{ pools: Record<string, Record<string, unknown>> }>("usage-pools.json");
    const minutes = (v: unknown) => parseUsage(body({ ...raw, pools: { claude: { ...raw.pools.claude, window_minutes: v } } }))?.pools?.claude?.windowMinutes;
    assert.deepEqual([minutes(300), minutes(undefined), minutes(0), minutes(-5), minutes("300"), minutes(1e9)], [300, 10080, 10080, 10080, 10080, 10080]);
  });
});

describe("Mistral's allowance from the pools file", () => {
  const pools = { claude: { budget: "3000" }, mistral: { budget: "1000", allowance: { amount: 300, currency: "USD", period: "calendar-month" } } };
  const now = Date.parse("2026-10-16T12:00:00Z");
  it("reads a USD calendar-month allowance, and nothing else", () => {
    assert.deepEqual(parseBudget(JSON.stringify(pools), now), { limitUsd: 300, since: "2026-10-01T00:00:00.000Z", resetsAt: "2026-11-01T00:00:00.000Z" });
    assert.equal(parseBudget(JSON.stringify(pools), Date.parse("2026-12-31T23:59:00Z"))?.resetsAt, "2027-01-01T00:00:00.000Z");
    for (const allowance of [undefined, { amount: 300, currency: "EUR", period: "calendar-month" }, { amount: 300, currency: "USD", period: "rolling" }, { amount: -1, currency: "USD", period: "calendar-month" }, { amount: "300", currency: "USD", period: "calendar-month" }]) {
      assert.equal(parseBudget(JSON.stringify({ mistral: { allowance } }), now), undefined, JSON.stringify(allowance));
    }
    assert.equal(parseBudget("not json", now), undefined);
  });
  it("reads it after the snapshot, one conditional GET, only for a Mistral row without an allowance of its own", async () => {
    assert.deepEqual(USAGE_CONFIG.mistralAllowance, { repo: "jmarrero-forge/tracker", path: ".github/agentic-job/pools.json" });
    const snapshot = (mistral: unknown) => [{ user: { login: "jmarrero-bot" }, body: body({ ...fixture<object>("usage-pools.json"), mistral }) }];
    const run = async (mistral: unknown, target: { repo: string; path: string } | null = { repo: "example/tracker", path: ".github/agentic-job/pools.json" }) => {
      const { fetchImpl, calls } = scriptedFetch((_m, url) => url.endsWith(usagePath) ? { body: snapshot(mistral) }
        : url.endsWith("/repos/example/tracker/contents/.github/agentic-job/pools.json") ? { body: { encoding: "base64", size: 200, content: Buffer.from(JSON.stringify(pools)).toString("base64"), html_url: "https://github.com/example/tracker/blob/main/.github/agentic-job/pools.json" } } : undefined);
      const data = await loadUsage(new GitHub(async () => "t", fetchImpl), now, target);
      return { mistral: data.state === "ok" ? data.usage.mistral : undefined, paths: calls.map((c) => new URL(c.url).pathname) };
    };
    const read = await run({ requests: 1, tokens: 2 });
    assert.deepEqual(read.paths, [new URL(usagePath, "https://x").pathname, "/repos/example/tracker/contents/.github/agentic-job/pools.json"]);
    assert.equal(read.mistral?.budget?.limitUsd, 300);
    assert.equal(read.mistral?.budget?.url, "https://github.com/example/tracker/blob/main/.github/agentic-job/pools.json");
    assert.equal((await run({ requests: 1, tokens: 2, allowance: { limit_usd: 300, resets_at: "2026-11-01T00:00:00Z", spent_usd: 4 } })).paths.length, 1);
    assert.equal((await run(undefined)).paths.length, 1);
    assert.equal((await run({ requests: 1, tokens: 2 }, null)).paths.length, 1);
    assert.equal((await run({ requests: 1, tokens: 2 }, { repo: "example/tracker", path: "../../x.json" })).paths.length, 1);
    assert.equal((await run({ requests: 1, tokens: 2 }, { repo: "../..", path: "x.json" })).paths.length, 1);
    const missing = await run({ requests: 1, tokens: 2 }, { repo: "example/other", path: "pools.json" });
    assert.deepEqual(missing.mistral, { requests: 1, tokens: 2 }, "an unreadable pools file leaves the counters");
    const { fetchImpl, calls } = scriptedFetch((_m, url) => url.endsWith(usagePath) ? { body: snapshot({ requests: 1, tokens: 2 }) } : { status: 404, body: { message: "Not Found" } });
    const gh = new GitHub(async () => "t", fetchImpl);
    for (let i = 0; i < 2; i++) assert.equal((await loadUsage(gh, now, { repo: "example/private", path: "pools.json" })).state, "ok");
    assert.equal(calls.filter((c) => c.url.includes("/contents/")).length, 1, "a 404 is not asked for again");
  });
});
