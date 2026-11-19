import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub, GitHubError, nextLink, RateLimited, rateLimitWait } from "../src/github/api.ts";
import { GITHUB_CONCURRENCY } from "../src/github/config.ts";
import { scriptedFetch } from "./helpers.ts";

const token = async () => "t0ken";

describe("read-only browser policy", () => {
  it("allows REST and GraphQL reads, but refuses writes before fetch or cache invalidation", async () => {
    const { fetchImpl, calls } = scriptedFetch(() => ({ body: { data: { viewer: { login: "operator" } } } }));
    const gh = new GitHub(token, fetchImpl);
    gh.readOnly = true;
    await gh.get("/user");
    await gh.send("GET", "/user");
    await gh.graphql("query { viewer { login } }");
    const generation = gh.cache.generation;
    for (const [method, path, body] of [
      ["POST", "/repos/o/r/actions/workflows/job.yml/dispatches", { ref: "main" }],
      ["PATCH", "/repos/o/r/issues/1", { state: "closed" }],
      ["DELETE", "/notifications/threads/1", undefined],
      ["POST", "/graphql", { query: "mutation { addComment { clientMutationId } }" }],
      ["POST", "/graphql", { query: "query { viewer { login } } mutation Other { addComment { clientMutationId } }" }],
    ] as const) {
      await assert.rejects(gh.send(method, path, body), (e: unknown) => e instanceof GitHubError && e.status === 403 && /Nothing was sent/.test(e.message));
    }
    assert.equal(calls.length, 3);
    assert.equal(gh.cache.generation, generation);
    gh.readOnly = false;
    await gh.send("POST", "/repos/o/r/actions/workflows/job.yml/dispatches", { ref: "main" });
    assert.equal(calls.length, 4);
  });
});

describe("nextLink", () => {
  const cases: [string | null, string | undefined][] = [
    [null, undefined],
    ['<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"', "https://api.github.com/x?page=2"],
    ['<https://api.github.com/x?page=1>; rel="prev"', undefined],
  ];
  for (const [link, want] of cases) it(String(link), () => assert.equal(nextLink(link), want));
});

describe("GitHub.get", () => {
  it("sends the token, then revalidates with the ETag and reuses data on 304", async () => {
    let n = 0;
    const { fetchImpl, calls } = scriptedFetch((_m, _u, headers) => {
      n++;
      if (headers["If-None-Match"] === 'W/"v1"') return { status: 304, headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4999" } };
      return { body: { n }, headers: { etag: 'W/"v1"' } };
    });
    const gh = new GitHub(token, fetchImpl);
    assert.deepEqual(await gh.get("/x"), { data: { n: 1 }, changed: true });
    assert.deepEqual(await gh.get("/x"), { data: { n: 1 }, changed: false });
    assert.equal(calls[0]?.headers.Authorization, "Bearer t0ken");
    assert.equal(calls[0]?.headers["If-None-Match"], undefined);
    assert.equal(calls[1]?.headers["If-None-Match"], 'W/"v1"');
    assert.equal(calls[0]?.url, "https://api.github.com/x");
    assert.deepEqual(gh.rate, { limit: 5000, remaining: 4999, reset: 0 });
    assert.equal(gh.rateLow(0.1), false);
  });

  it("explains an auth failure", async () => {
    const { fetchImpl } = scriptedFetch(() => ({ status: 401, body: { message: "Bad credentials" } }));
    const gh = new GitHub(token, fetchImpl);
    await assert.rejects(gh.get("/user"), (e: unknown) => {
      assert.ok(e instanceof GitHubError);
      assert.equal(e.status, 401);
      assert.match(e.message, /Bad credentials.*sign in again/);
      return true;
    });
  });

  it("includes GitHub's error details", async () => {
    const { fetchImpl } = scriptedFetch(() => ({
      status: 422,
      body: { message: "Unprocessable Entity", errors: ["Can not approve your own pull request", { message: "second" }, { code: "x" }] },
    }));
    const gh = new GitHub(token, fetchImpl);
    await assert.rejects(gh.send("POST", "/x"), /HTTP 422: Unprocessable Entity; Can not approve your own pull request; second$/);
  });

  it("refuses paths that would leave the API origin", async () => {
    const gh = new GitHub(token, scriptedFetch(() => ({})).fetchImpl);
    await assert.rejects(gh.get("https://evil.example/x"), /refusing to send the token outside/);
    await assert.rejects(gh.get("x"), /must start with \//);
  });

  it("refuses a next page outside the API origin", async () => {
    const { fetchImpl, calls } = scriptedFetch(() => ({ body: [1], headers: { link: '<https://evil.example/x?page=2>; rel="next"' } }));
    const gh = new GitHub(token, fetchImpl);
    await assert.rejects(gh.getAll("/x"), /refusing to send the token outside/);
    assert.equal(calls.length, 1);
  });

  it("tracks the core rate limit only", async () => {
    const rate = (resource: string, remaining: string) => ({ "x-ratelimit-resource": resource, "x-ratelimit-limit": resource === "search" ? "30" : "5000", "x-ratelimit-remaining": remaining });
    const { fetchImpl } = scriptedFetch((_m, url) => ({ body: {}, headers: url.includes("search") ? rate("search", "2") : rate("core", "4000") }));
    const gh = new GitHub(token, fetchImpl);
    await gh.get("/user");
    await gh.get("/search/issues?q=x");
    assert.deepEqual(gh.rate, { limit: 5000, remaining: 4000, reset: 0 });
    assert.equal(gh.rateLow(0.1), false);
  });

  it("notes a classic token's scopes", async () => {
    const { fetchImpl } = scriptedFetch(() => ({ body: {}, headers: { "x-oauth-scopes": "gist, repo" } }));
    const gh = new GitHub(token, fetchImpl);
    assert.equal(gh.scopes, undefined);
    await gh.get("/user");
    assert.equal(gh.scopes, "gist, repo");
  });
});

describe("GitHub request timeout", () => {
  it("gives up on a request that never gets an answer", async () => {
    // A connection that died silently: fetch settles only when aborted.
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const gh = new GitHub(token, hang);
    gh.timeoutMs = 20;
    // AbortSignal.timeout's timer doesn't keep Node's event loop alive.
    const alive = setInterval(() => {}, 1000);
    try {
      await assert.rejects(gh.get("/x"), /GET https:\/\/api\.github\.com\/x: GitHub didn't answer within \d+ s/);
      await assert.rejects(gh.send("POST", "/y", {}), /POST https:\/\/api\.github\.com\/y: GitHub didn't answer/);
    } finally {
      clearInterval(alive);
    }
  });
});

describe("GitHub.abandonGets", () => {
  it("abandons the GETs sent before a time, and no write", async () => {
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const gh = new GitHub(token, hang);
    const before = gh.get("/old");
    const write = gh.send("POST", "/write", {});
    let writeSettled = false;
    write.then(
      () => (writeSettled = true),
      () => (writeSettled = true),
    );
    // Let both reach fetch.
    await new Promise((r) => setImmediate(r));
    const later = Date.now() + 1;
    gh.abandonGets(later);
    await assert.rejects(before, /GET https:\/\/api\.github\.com\/old: abandoned, the page was suspended while it waited/);
    await new Promise((r) => setImmediate(r));
    assert.equal(writeSettled, false);
    // A GET sent after that time is left alone.
    const after = gh.get("/new");
    let afterSettled = false;
    after.catch(() => {}).finally(() => (afterSettled = true));
    await new Promise((r) => setImmediate(r));
    gh.abandonGets(later - 1_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(afterSettled, false);
  });
});

describe("GitHub.getAll", () => {
  it("follows pages and reports a change on any page", async () => {
    const page2 = "https://api.github.com/list?page=2";
    let second = 0;
    const { fetchImpl } = scriptedFetch((_m, url, headers) => {
      if (url === page2) {
        second++;
        if (second === 2 && headers["If-None-Match"]) return { status: 304 };
        return { body: [3], headers: { etag: `"p2-${second}"` } };
      }
      if (headers["If-None-Match"]) return { status: 304 };
      return { body: [1, 2], headers: { etag: '"p1"', link: `<${page2}>; rel="next"` } };
    });
    const gh = new GitHub(token, fetchImpl);
    assert.deepEqual(await gh.getAll("/list"), { data: [1, 2, 3], changed: true });
    assert.deepEqual(await gh.getAll("/list"), { data: [1, 2, 3], changed: false });
    // Page 2 changes; page 1 still 304.
    second = 5;
    assert.deepEqual(await gh.getAll("/list"), { data: [1, 2, 3], changed: true });
  });

  it("stops at the page limit", async () => {
    const { fetchImpl } = scriptedFetch((_m, url) => ({ body: [1], headers: { link: `<${url}x>; rel="next"` } }));
    await assert.rejects(new GitHub(token, fetchImpl).getAll("/loop", 3), /more than 3 pages/);
  });
});

describe("GitHub rate limits", () => {
  const refuse = (status: number, headers: Record<string, string>, message: string) => {
    const { fetchImpl, calls } = scriptedFetch(() => ({ status, headers, body: { message } }));
    return { gh: new GitHub(token, fetchImpl), calls };
  };

  it("a secondary limit with retry-after: says when it retries, not a permission, and sends nothing until then", async () => {
    const { gh, calls } = refuse(403, { "retry-after": "30" }, "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.");
    const before = Date.now();
    await assert.rejects(gh.get("/search/issues?q=x"), (e: unknown) => {
      assert.ok(e instanceof RateLimited);
      assert.equal(e.status, 403);
      assert.equal(e.message, "GitHub rate limit: retrying in 30 s");
      assert.doesNotMatch(e.message, /permission/);
      return true;
    });
    assert.ok(gh.blockedUntil >= before + 30_000 && gh.blockedUntil <= Date.now() + 30_000);
    // Held back without asking GitHub again, writes too.
    await assert.rejects(gh.get("/x"), RateLimited);
    await assert.rejects(gh.send("POST", "/y", {}), /GitHub rate limit: retrying in \d+ s/);
    assert.equal(calls.length, 1);
  });

  it("the secondary-limit message alone waits GitHub's minute", async () => {
    const { gh } = refuse(403, {}, "You have exceeded a secondary rate limit.");
    await assert.rejects(gh.get("/x"), /: GitHub rate limit: retrying in 60 s$/);
  });

  it("a spent primary limit waits until its reset", async () => {
    const reset = Math.ceil(Date.now() / 1000) + 120;
    const { gh } = refuse(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset), "x-ratelimit-limit": "5000" }, "API rate limit exceeded for user ID 1.");
    await assert.rejects(gh.get("/x"), (e: unknown) => e instanceof RateLimited && /retrying in 1[12]\d s/.test(e.message));
    assert.equal(gh.blockedUntil, reset * 1000);
  });

  it("retries by itself once the wait is over", async () => {
    let n = 0;
    const { fetchImpl } = scriptedFetch(() => (n++ === 0 ? { status: 429, headers: { "retry-after": "0" }, body: {} } : { body: { ok: true } }));
    const gh = new GitHub(token, fetchImpl);
    await assert.rejects(gh.get("/x"), RateLimited);
    assert.deepEqual((await gh.get("/x")).data, { ok: true });
  });

  it("a real 403 keeps its permission hint, and blocks nothing", async () => {
    const { gh, calls } = refuse(403, { "x-ratelimit-remaining": "4000", "x-ratelimit-reset": "1" }, "Resource not accessible by personal access token");
    await assert.rejects(gh.get("/x"), (e: unknown) => {
      assert.ok(e instanceof GitHubError && !(e instanceof RateLimited));
      assert.match(e.message, /HTTP 403: Resource not accessible by personal access token \(no access with this token, or it lacks a permission\)$/);
      return true;
    });
    assert.equal(gh.blockedUntil, 0);
    await assert.rejects(gh.get("/x"), /HTTP 403/);
    assert.equal(calls.length, 2);
  });

  it("recognises each documented signal", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    assert.equal(rateLimitWait(403, h({ "retry-after": "7" }), "", 0), 7_000);
    assert.equal(rateLimitWait(429, h({}), "", 0), 60_000);
    assert.equal(rateLimitWait(403, h({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "100" }), "", 40_000), 60_000);
    assert.equal(rateLimitWait(403, h({}), "secondary rate limit", 0), 60_000);
    assert.equal(rateLimitWait(403, h({ "x-ratelimit-remaining": "12" }), "Must have admin rights", 0), undefined);
    assert.equal(rateLimitWait(404, h({ "retry-after": "7" }), "rate limit", 0), undefined);
  });
});

describe("GitHub concurrency", () => {
  /** A fetch whose answers the test releases, recording how many were in flight at most, overall and of searches. */
  const gated = () => {
    const waiting: (() => void)[] = [];
    const peak = { all: 0, search: 0 };
    const now = { all: 0, search: 0 };
    const fetchImpl = async (url: string) => {
      const search = url.includes("/search/");
      now.all++;
      if (search) now.search++;
      peak.all = Math.max(peak.all, now.all);
      peak.search = Math.max(peak.search, now.search);
      await new Promise<void>((r) => waiting.push(r));
      now.all--;
      if (search) now.search--;
      return Response.json({});
    };
    return { fetchImpl, waiting, peak };
  };
  const drain = async (waiting: (() => void)[], done: () => boolean) => {
    while (!done()) {
      await new Promise((r) => setImmediate(r));
      waiting.shift()?.();
    }
  };

  it(`sends at most ${GITHUB_CONCURRENCY} requests at once, and one search at a time`, async () => {
    const { fetchImpl, waiting, peak } = gated();
    const gh = new GitHub(token, fetchImpl);
    let settled = 0;
    const all = [
      ...Array.from({ length: 10 }, (_, i) => gh.get(`/repos/o/r/issues/${i}`)),
      ...Array.from({ length: 4 }, (_, i) => gh.get(`/search/issues?q=${i}`)),
    ].map((p) => p.finally(() => settled++));
    await new Promise((r) => setImmediate(r));
    assert.equal(waiting.length, GITHUB_CONCURRENCY);
    await drain(waiting, () => settled === all.length);
    await Promise.all(all);
    assert.equal(peak.all, GITHUB_CONCURRENCY);
    assert.equal(peak.search, 1);
  });

  it("shares one request among GETs of the same URL in flight together", async () => {
    let n = 0;
    const gh = new GitHub(token, async () => Response.json({ n: ++n }));
    const [a, b, c] = await Promise.all([gh.get("/x"), gh.get("/x"), gh.get("/y")]);
    assert.deepEqual([a.data, b.data, c.data], [{ n: 1 }, { n: 1 }, { n: 2 }]);
    // Once answered, a later GET asks again.
    assert.deepEqual((await gh.get("/x")).data, { n: 3 });
  });

  /** Whether a GET sent after `write` joins one sent before it. */
  const sharedAcross = async (write: (gh: GitHub) => Promise<unknown>) => {
    let body = "old";
    let release!: () => void;
    let sent!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const onWire = new Promise<void>((r) => (sent = r));
    const gh = new GitHub(token, async (_url, init) => {
      if (init?.method === "POST" || init?.method === "PATCH") {
        if (!String(init.body).includes("query {")) body = "new";
        return Response.json({ data: {} });
      }
      if (body === "new") return Response.json({ body });
      const answer = Response.json({ body });
      sent();
      await held;
      return answer;
    });
    const before = gh.get("/orgs/o/projectsV2/1/items");
    await onWire;
    await write(gh);
    const after = gh.get<{ body: string }>("/orgs/o/projectsV2/1/items");
    release();
    await before;
    return (await after).data.body === "old";
  };

  it("doesn't share a GET sent before a write with one after it", async () => {
    assert.equal(await sharedAcross((gh) => gh.send("PATCH", "/repos/o/r/issues/1", {})), false);
    assert.equal(await sharedAcross((gh) => gh.graphql("mutation { m }")), false);
    // A GraphQL query writes nothing.
    assert.equal(await sharedAcross((gh) => gh.graphql("query { q }")), true);
  });
});

describe("GitHub.graphql", () => {
  const cases: [string, unknown, RegExp | object][] = [
    ["data", { data: { a: 1 } }, { a: 1 }],
    ["errors beside data", { data: { a: null }, errors: [{ message: "boom" }, {}] }, /: boom; GraphQL error$/],
    ["no data", { data: null }, /no GraphQL data/],
  ];
  for (const [name, body, want] of cases) {
    it(name, async () => {
      const gh = new GitHub(token, async () => Response.json(body));
      if (want instanceof RegExp) await assert.rejects(gh.graphql("query{a}"), want);
      else assert.deepEqual(await gh.graphql("query{a}"), want);
    });
  }
});
