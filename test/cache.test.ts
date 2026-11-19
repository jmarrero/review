import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { CacheMiss, type Fetch, GitHub } from "../src/github/api.ts";
import { loadQueue } from "../src/github/backend.ts";
import { type CacheOptions, type EntryMeta, forgetCache, openCache, type PersistentStore, ResponseCache, staleAfterWrite, tokenHash } from "../src/github/cache.ts";
import { composeReview } from "../src/github/forge.ts";
import { deleteCacheDatabase, IdbStore } from "../src/github/idbstore.ts";
import { submitReview } from "../src/github/prs.ts";
import { fields, rawItems, type Scripted, scriptedFetch } from "./helpers.ts";

const API = "https://api.github.com";
const token = async () => "t0ken";
const DAY = 24 * 3600_000;
const T0 = Date.UTC(2026, 8, 1);

/** A clock tests can move. */
function clock(start = T0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

async function openStore(factory: IDBFactory): Promise<IdbStore> {
  const store = await IdbStore.open(factory);
  assert.ok(store, "IndexedDB should open");
  return store;
}

/**
 * One page load: a cache attached to `factory`'s store as `login`, and a
 * client answering from `route`.
 */
async function session(
  factory: IDBFactory,
  route: Parameters<typeof scriptedFetch>[0],
  opts: CacheOptions & { login?: string } = {},
) {
  const store = await openStore(factory);
  const cache = new ResponseCache(opts);
  assert.equal(await cache.attach(store, opts.login ?? "alice", "hash"), true);
  const { fetchImpl, calls } = scriptedFetch(route);
  return { gh: new GitHub(token, fetchImpl, cache), cache, store, calls };
}

/** Every URL of the store's entries, by login. */
async function persisted(factory: IDBFactory): Promise<string[]> {
  const store = await openStore(factory);
  return (await store.metas()).map((m: EntryMeta) => m.key).sort();
}

const etagged = (body: unknown, etag: string): Scripted => ({ body, headers: { etag } });

describe("ResponseCache with IndexedDB", () => {
  it("serves a response in the next session, then revalidates it with its ETag; a 304 only moves its time", async () => {
    const factory = new IDBFactory();
    const c = clock();
    const first = await session(factory, () => etagged({ v: 1 }, 'W/"v1"'), { now: c.now });
    assert.deepEqual(await first.gh.get("/x"), { data: { v: 1 }, changed: true });
    await first.cache.flushed();

    c.advance(5 * 60_000);
    const second = await session(factory, (_m, _u, h) => (h["If-None-Match"] === 'W/"v1"' ? { status: 304 } : etagged({ v: 2 }, 'W/"v2"')), { now: c.now });
    const cached = second.gh.cacheOnly();
    assert.deepEqual(await cached.get("/x"), { data: { v: 1 }, changed: true });
    assert.ok(cached.oldest !== undefined && cached.oldest <= T0 + 1000, "the cached copy is from the first session");
    assert.equal(second.calls.length, 0, "a cache-only read never touches the network");

    assert.deepEqual(await second.gh.get("/x"), { data: { v: 1 }, changed: false });
    assert.equal(second.calls[0]?.headers["If-None-Match"], 'W/"v1"');
    await second.cache.flushed();
    const [meta] = await (await openStore(factory)).metas();
    assert.equal(meta?.fetchedAt, c.now(), "the 304 refreshed the fetch time");
    assert.equal(meta?.etag, 'W/"v1"');
  });

  it("revalidates with If-Modified-Since when there is no ETag", async () => {
    const factory = new IDBFactory();
    const LM = "Tue, 01 Sep 2026 00:00:00 GMT";
    const first = await session(factory, () => ({ body: { v: 1 }, headers: { "last-modified": LM } }));
    await first.gh.get("/y");
    await first.cache.flushed();
    const second = await session(factory, () => ({ status: 304 }));
    assert.deepEqual(await second.gh.get("/y"), { data: { v: 1 }, changed: false });
    assert.equal(second.calls[0]?.headers["If-Modified-Since"], LM);
  });

  it("keeps paginated lists whole", async () => {
    const factory = new IDBFactory();
    const first = await session(factory, (_m, url) =>
      url.endsWith("page=2") ? etagged([3], '"p2"') : { body: [1, 2], headers: { etag: '"p1"', link: `<${API}/l?page=2>; rel="next"` } },
    );
    await first.gh.getAll("/l");
    await first.cache.flushed();
    const second = await session(factory, () => undefined);
    assert.deepEqual((await second.gh.cacheOnly().getAll("/l")).data, [1, 2, 3]);
  });

  it("answers a cache-only miss with CacheMiss and refuses writes", async () => {
    const { gh, calls } = await session(new IDBFactory(), () => ({ body: {} }));
    const cached = gh.cacheOnly();
    await assert.rejects(cached.get("/nothing"), CacheMiss);
    await assert.rejects(cached.send("POST", "/repos/o/r/issues/1/comments", { body: "x" }), /cache-only client/);
    assert.equal(calls.length, 0);
  });

  it("drops what a write may have changed, in memory and on disk", async () => {
    const factory = new IDBFactory();
    // [url, still cached after commenting on o/r#5]
    const cases: [string, boolean][] = [
      ["/repos/o/r/issues/5/comments?per_page=100", false],
      ["/repos/o/r/pulls/5/reviews?per_page=100", false],
      ["/repos/o/r/pulls/5", false],
      ["/repos/O/R/issues/5", false],
      ["/search/issues?q=is%3Apr", false],
      ["/repos/o/r/issues/50/comments?per_page=100", true],
      ["/repos/o/r/pulls?state=open&per_page=100", true],
      ["/repos/o/other/issues/5", true],
      // The board's items embed their issues.
      ["/users/b/projectsV2/1/items?per_page=100&fields=1,2", false],
      ["/orgs/b/projectsV2/2/items", false],
      ["/users/b/projectsV2/1/fields?per_page=100", true],
    ];
    const s = await session(factory, (method) => (method === "POST" ? { status: 201, body: { html_url: "c" } } : etagged({}, '"e"')));
    for (const [url] of cases) await s.gh.get(url);
    await s.gh.send("POST", "/repos/o/r/issues/5/comments", { body: "B" });
    await s.cache.flushed();
    const later = (await session(factory, () => undefined)).gh.cacheOnly();
    for (const [url, kept] of cases) {
      assert.equal(await s.gh.cacheOnly().get(url).then(() => true, () => false), kept, `${url} in memory`);
      assert.equal(await later.get(url).then(() => true, () => false), kept, `${url} persisted`);
    }
  });

  it("doesn't cache a read that raced a write", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl: Fetch = async (url, init) => {
      if (init?.method === "POST") return new Response('{"html_url":"c"}', { status: 201 });
      await gate;
      return new Response(JSON.stringify({ stale: url }), { status: 200, headers: { etag: '"old"' } });
    };
    const cache = new ResponseCache();
    const gh = new GitHub(token, fetchImpl, cache);
    const read = gh.get("/repos/o/r/pulls/5/reviews");
    await gh.send("POST", "/repos/o/r/pulls/5/reviews", { event: "APPROVE" });
    release();
    await read;
    await assert.rejects(gh.cacheOnly().get("/repos/o/r/pulls/5/reviews"), CacheMiss);
  });

  it("evicts the least recently used entries above the size cap, and entries older than the maximum age", async () => {
    const factory = new IDBFactory();
    const c = clock();
    const body = { pad: "x".repeat(90) }; // about 100 characters of JSON
    const s = await session(factory, (_m, url) => etagged(body, `"${url}"`), { now: c.now, maxBytes: 350, maxAgeMs: 7 * DAY });
    for (const p of ["/a", "/b", "/c"]) {
      await s.gh.get(p);
      c.advance(1000);
    }
    // Reading /a makes /b the least recently used.
    await s.gh.cacheOnly().get("/a");
    c.advance(1000);
    await s.gh.get("/d");
    await s.cache.flushed();
    assert.deepEqual(await persisted(factory), ["a", "c", "d"].map((p) => `alice ${API}/${p}`));
    assert.ok(s.cache.bytes <= 350);
    // This tab keeps its memory copy.
    assert.deepEqual((await s.gh.cacheOnly().get("/b")).data, body);

    c.advance(7 * DAY + 1);
    await s.gh.get("/e");
    await s.cache.flushed();
    const later = await session(factory, () => undefined, { now: c.now, maxAgeMs: 7 * DAY });
    await later.cache.flushed();
    assert.deepEqual(await persisted(factory), [`alice ${API}/e`]);
    await assert.rejects(later.gh.cacheOnly().get("/a"), CacheMiss);
  });

  it("wipes another login's entries when a different user signs in", async () => {
    const factory = new IDBFactory();
    const alice = await session(factory, () => etagged({ who: "alice" }, '"a"'));
    await alice.gh.get("/user");
    await alice.cache.flushed();
    const bob = await session(factory, () => undefined, { login: "bob" });
    await assert.rejects(bob.gh.cacheOnly().get("/user"), CacheMiss);
    assert.deepEqual(await persisted(factory), []);
    assert.deepEqual(await (await openStore(factory)).owner(), { login: "bob", tokenHash: "hash" });
  });

  it("wipe deletes the database", async () => {
    const factory = new IDBFactory();
    const s = await session(factory, () => etagged({}, '"a"'));
    await s.gh.get("/user");
    await s.cache.wipe();
    await assert.rejects(s.gh.cacheOnly().get("/user"), CacheMiss);
    assert.deepEqual(await persisted(factory), []);
    assert.equal(await (await openStore(factory)).owner(), undefined);
  });
});

describe("openCache", () => {
  const open = (factory: IDBFactory) => () => IdbStore.open(factory);
  const destroy = (factory: IDBFactory) => () => deleteCacheDatabase(factory);

  it("knows the login early only for the token it was last used with", async () => {
    const factory = new IDBFactory();
    const first = await openCache("tok-1", true, open(factory), destroy(factory));
    assert.equal(first.knownLogin, undefined);
    assert.ok(first.store && first.tokenHash);
    assert.equal(await first.cache.attach(first.store, "alice", first.tokenHash), true);
    // The token itself is never stored, only its hash.
    const owner = await first.store.owner();
    assert.deepEqual(owner, { login: "alice", tokenHash: await tokenHash("tok-1") });
    assert.doesNotMatch(JSON.stringify(owner), /tok-1/);

    assert.equal((await openCache("tok-1", true, open(factory), destroy(factory))).knownLogin, "alice");
    assert.equal((await openCache("tok-2", true, open(factory), destroy(factory))).knownLogin, undefined);
  });

  it("deletes the store and stays in memory without remember", async () => {
    const factory = new IDBFactory();
    const s = await session(factory, () => etagged({}, '"a"'));
    await s.gh.get("/user");
    await s.cache.flushed();
    // The earlier session's connection closes itself when the database is deleted.
    const opened: string[] = [];
    const c = await openCache("tok", false, async () => {
      opened.push("open");
      return undefined;
    }, destroy(factory));
    assert.deepEqual(opened, []);
    assert.equal(c.store, undefined);
    assert.deepEqual(await persisted(factory), []);
  });

  it("works without storage", async () => {
    const cases: [string, () => Promise<PersistentStore | undefined>][] = [
      ["no IndexedDB", () => IdbStore.open(undefined)],
      ["open throws", () => IdbStore.open({ open: () => { throw new Error("SecurityError"); } } as unknown as IDBFactory)],
      ["open rejects", () => Promise.reject(new Error("blocked"))],
    ];
    for (const [name, openFn] of cases) {
      const s = await openCache("tok", true, openFn, async () => {});
      assert.equal(s.store, undefined, name);
      // The client works as it always did: memory only, with ETags.
      const { fetchImpl, calls } = scriptedFetch((_m, _u, h) => (h["If-None-Match"] ? { status: 304 } : etagged({ ok: 1 }, '"e"')));
      const gh = new GitHub(token, fetchImpl, s.cache);
      assert.deepEqual(await gh.get("/x"), { data: { ok: 1 }, changed: true }, name);
      assert.deepEqual(await gh.get("/x"), { data: { ok: 1 }, changed: false }, name);
      assert.equal(calls.length, 2, name);
    }
  });

  it("keeps working when every store operation fails", async () => {
    const fail = () => Promise.reject(new Error("QuotaExceededError"));
    const broken: PersistentStore = { owner: fail, setOwner: fail, metas: fail, body: fail, put: fail, putMeta: fail, delete: fail, clear: fail, destroy: fail };
    const cache = new ResponseCache();
    assert.equal(await cache.attach(broken, "alice", "h"), false);
    const { fetchImpl } = scriptedFetch((_m, _u, h) => (h["If-None-Match"] ? { status: 304 } : etagged({ ok: 1 }, '"e"')));
    const gh = new GitHub(token, fetchImpl, cache);
    await gh.get("/x");
    assert.equal((await gh.get("/x")).changed, false);
    await cache.flushed();
  });
});

describe("a 401", () => {
  it("at any time, from any loader, deletes the cache database", async () => {
    const factory = new IDBFactory();
    let revoked = false;
    const s = await session(factory, (_m, url) => {
      if (revoked) return { status: 401, body: { message: "Bad credentials" } };
      return etagged(new URL(url).pathname.endsWith("/fields") ? fields() : rawItems(), '"e"');
    });
    const cacheSession = { cache: s.cache, store: s.store };
    let rejections = 0;
    let forgotten: Promise<void> | undefined;
    s.gh.onUnauthorized = () => {
      rejections++;
      forgotten = forgetCache(cacheSession, () => deleteCacheDatabase(factory));
    };
    await loadQueue(s.gh);
    await s.cache.flushed();
    assert.equal((await persisted(factory)).length, 2);

    // Revoked mid-session: the next poll's conditional read gets a 401.
    revoked = true;
    await assert.rejects(loadQueue(s.gh), /HTTP 401/);
    assert.equal(rejections, 1);
    await forgotten;
    assert.deepEqual((await factory.databases()).map((d) => d.name), [], "the database is gone");
    await assert.rejects(loadQueue(s.gh.cacheOnly()), CacheMiss, "and so is the memory tier");
    // Writes answer 401 the same way.
    await assert.rejects(s.gh.send("POST", "/repos/o/r/issues/1/comments", { body: "x" }), /HTTP 401/);
    assert.equal(rejections, 2);
  });
});

describe("the approve guard", () => {
  const HEAD = "c".repeat(40);
  const MOVED = "d".repeat(40);
  const ref = { owner: "jmarrero-forge", repo: "widget", number: 7 };
  const PULL = `${API}/repos/jmarrero-forge/widget/pulls/7`;
  const pull = (sha: string) => ({ number: 7, html_url: "https://github.com/jmarrero-forge/widget/pull/7", state: "open", head: { sha }, base: {} });

  it("reads the head from GitHub, never the cache", async () => {
    const factory = new IDBFactory();
    // The cache, memory and disk, says the head is the one he reviewed...
    const s = await session(factory, (method, url) => {
      if (method === "GET" && url === PULL) return etagged(pull(HEAD), '"h1"');
      return undefined;
    });
    await s.gh.get("/repos/jmarrero-forge/widget/pulls/7");
    await s.cache.flushed();
    // ...but on GitHub it moved, with the same ETag, which a conditional read would trust.
    const later = await session(factory, (method, url) => {
      if (method === "GET" && url === PULL) return etagged(pull(MOVED), '"h1"');
      if (method === "POST") return { body: { html_url: "r" } };
      return undefined;
    });
    const err = await submitReview(later.gh, ref, composeReview("approve", "", HEAD)).then(
      () => "sent",
      (e: Error) => e.message,
    );
    assert.match(err, /head moved to dddddddddddd.*nothing was sent/);
    assert.deepEqual(
      later.calls.map((c) => [c.method, c.headers["If-None-Match"] ?? null]),
      [["GET", null]],
      "one unconditional GET, no review posted",
    );
    await assert.rejects(submitReview(later.gh.cacheOnly(), ref, composeReview("approve", "", HEAD)), /cache-only client/);
  });
});

describe("staleAfterWrite", () => {
  it("ignores writes outside an issue or PR", () => {
    assert.equal(staleAfterWrite("/gists")("/search/issues?q=x"), false);
    assert.equal(staleAfterWrite("/graphql")("/users/b/projectsV2/1/items"), false);
  });

  it("makes the next queue read after an answer a full one, not a revalidation", async () => {
    const { fetchImpl, calls } = scriptedFetch((method, url) => {
      if (method === "POST") return { status: 201, body: { html_url: "c" } };
      if (url.includes("/fields")) return etagged(fields(), '"f"');
      return etagged(rawItems(), '"i"');
    });
    const gh = new GitHub(token, fetchImpl, new ResponseCache());
    await loadQueue(gh);
    await gh.send("POST", "/repos/jmarrero-forge/tracker/issues/7/comments", { body: "A" });
    calls.length = 0;
    await loadQueue(gh);
    const items = calls.find((c) => c.url.includes("/items"));
    const fieldsRead = calls.find((c) => c.url.includes("/fields"));
    assert.equal(items?.headers["If-None-Match"], undefined, "the items listing was dropped");
    assert.equal(fieldsRead?.headers["If-None-Match"], '"f"', "the fields weren't");
  });
});
