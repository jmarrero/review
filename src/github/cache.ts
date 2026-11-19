// The one cache of GitHub GET responses: an in-memory map, backed, when
// the token is remembered, by a persistent store (IndexedDB, see
// idbstore.ts) that survives reloads. The client revalidates every entry
// with If-None-Match or If-Modified-Since (a 304 costs no rate budget),
// and the views can render from it before the network answers
// (stale-while-revalidate; see "Persistent cache" in docs/design.md).
//
// Storage is best effort: every store operation may fail (private mode,
// blocked site data, quota), and a failure only means the entry isn't
// persisted. Without a store the cache is memory only, as it always was.

import { CACHE_MAX_AGE_MS, CACHE_MAX_BYTES } from "./config.ts";

/** A cached response, as the client uses it. */
export interface CachedResponse {
  etag?: string;
  lastModified?: string;
  data: unknown;
  /** The rel="next" page, for lists. */
  next?: string;
  /** When the server last sent or confirmed (304) it, in epoch ms. */
  fetchedAt: number;
}

/** What the persistent store keeps about an entry, without its body. */
export interface EntryMeta {
  /** `${login} ${url}`: entries belong to the login that read them. */
  key: string;
  etag?: string;
  lastModified?: string;
  next?: string;
  fetchedAt: number;
  /** Last read or written, for LRU eviction. */
  usedAt: number;
  /** The body's size in characters of JSON, for the size cap. */
  size: number;
}

/**
 * Whose cache the store holds: the login, and a SHA-256 fingerprint of
 * the token it was last used with, so a reload with the same token can
 * render before GitHub has said whose token it is. Never the token.
 */
export interface Owner {
  login: string;
  tokenHash: string;
}

/** The persistent side, e.g. IndexedDB. Every method may reject. */
export interface PersistentStore {
  owner(): Promise<Owner | undefined>;
  setOwner(owner: Owner): Promise<void>;
  /** Every entry's metadata, without bodies. */
  metas(): Promise<EntryMeta[]>;
  body(key: string): Promise<unknown>;
  put(meta: EntryMeta, body: unknown): Promise<void>;
  putMeta(meta: EntryMeta): Promise<void>;
  delete(keys: readonly string[]): Promise<void>;
  /** Drop every entry and the owner. */
  clear(): Promise<void>;
  /** Close the store and delete it from the browser. */
  destroy(): Promise<void>;
}

export interface CacheOptions {
  maxBytes?: number;
  maxAgeMs?: number;
  now?: () => number;
}

/** The hex SHA-256 of a token, or undefined where WebCrypto is missing. */
export async function tokenHash(token: string): Promise<string | undefined> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return undefined;
  }
}

export class ResponseCache {
  #mem = new Map<string, CachedResponse>();
  #store: PersistentStore | undefined;
  /** The login whose persisted entries this cache reads and writes. */
  #login: string | undefined;
  /** Metadata of persisted entries of #login, by URL. */
  #index = new Map<string, EntryMeta>();
  #bytes = 0;
  #generation = 0;
  /** Store writes in flight. */
  #pending = new Set<Promise<unknown>>();
  readonly #maxBytes: number;
  readonly #maxAgeMs: number;
  readonly #now: () => number;

  constructor(opts: CacheOptions = {}) {
    this.#maxBytes = opts.maxBytes ?? CACHE_MAX_BYTES;
    this.#maxAgeMs = opts.maxAgeMs ?? CACHE_MAX_AGE_MS;
    this.#now = opts.now ?? Date.now;
  }

  /** The cache's clock, in epoch ms. */
  now(): number {
    return this.#now();
  }

  /** The login whose persisted entries are in use, if any. */
  get login(): string | undefined {
    return this.#login;
  }

  /** Persisted bytes in use. */
  get bytes(): number {
    return this.#bytes;
  }

  /**
   * Bumped by every invalidation: a response read before one isn't
   * stored after it, so a GET racing a write can't cache the old state.
   */
  get generation(): number {
    return this.#generation;
  }

  /**
   * Persist entries of `login` in `store`. A store owned by another
   * login is wiped first; entries of other logins, too old, or over the
   * size cap are dropped. Returns false if the store failed, and then
   * stays memory only.
   */
  async attach(store: PersistentStore, login: string, hash: string | undefined): Promise<boolean> {
    if (this.#store === store && this.#login === login) return true;
    // Another login's responses never serve this one, not even from memory.
    if (this.#login !== undefined && this.#login !== login) this.#mem.clear();
    try {
      const owner = await store.owner();
      if (owner?.login !== login) await store.clear();
      if (owner?.login !== login || (hash && owner.tokenHash !== hash)) await store.setOwner({ login, tokenHash: hash ?? "" });
      const metas = await store.metas();
      const prefix = `${login} `;
      const cutoff = this.#now() - this.#maxAgeMs;
      const drop: string[] = [];
      this.#index.clear();
      this.#bytes = 0;
      for (const m of metas) {
        if (!m.key.startsWith(prefix) || m.fetchedAt < cutoff) {
          drop.push(m.key);
          continue;
        }
        this.#index.set(m.key.slice(prefix.length), m);
        this.#bytes += m.size;
      }
      if (drop.length) await store.delete(drop);
      this.#store = store;
      this.#login = login;
      this.#evict();
      return true;
    } catch {
      this.#store = undefined;
      this.#login = undefined;
      this.#index.clear();
      this.#bytes = 0;
      return false;
    }
  }

  /** Write to the store in the background; a failure only means it isn't persisted. */
  #persist(p: Promise<unknown>): void {
    const settled = p.catch(() => {
      // Not persisted; the memory copy still serves this tab.
    });
    this.#pending.add(settled);
    void settled.finally(() => this.#pending.delete(settled));
  }

  /** Resolves when the store writes made so far have finished (or failed). */
  async flushed(): Promise<void> {
    await Promise.all([...this.#pending]);
  }

  #key(url: string): string {
    return `${this.#login} ${url}`;
  }

  /** A cached response for `url`, from memory or the store; undefined if none or too old. */
  async get(url: string): Promise<CachedResponse | undefined> {
    const now = this.#now();
    const meta = this.#index.get(url);
    if (meta) meta.usedAt = now;
    const hit = this.#mem.get(url);
    if (hit) return hit.fetchedAt >= now - this.#maxAgeMs ? hit : undefined;
    if (!meta || !this.#store) return undefined;
    if (meta.fetchedAt < now - this.#maxAgeMs) {
      this.#forget([url]);
      return undefined;
    }
    let data: unknown;
    try {
      data = await this.#store.body(meta.key);
    } catch {
      return undefined;
    }
    // Invalidated, or replaced, while reading.
    if (data === undefined || this.#index.get(url) !== meta) return this.#mem.get(url);
    const entry: CachedResponse = { data, fetchedAt: meta.fetchedAt };
    if (meta.etag) entry.etag = meta.etag;
    if (meta.lastModified) entry.lastModified = meta.lastModified;
    if (meta.next) entry.next = meta.next;
    this.#mem.set(url, entry);
    this.#persist(this.#store.putMeta(meta));
    return entry;
  }

  /**
   * Store a fresh response of `size` characters, unless an invalidation
   * happened since `generation` was read, when its request went out.
   */
  put(url: string, entry: CachedResponse, size: number, generation = this.#generation): void {
    if (generation !== this.#generation) return;
    this.#mem.set(url, entry);
    if (!this.#store) return;
    const meta: EntryMeta = { key: this.#key(url), fetchedAt: entry.fetchedAt, usedAt: this.#now(), size };
    if (entry.etag) meta.etag = entry.etag;
    if (entry.lastModified) meta.lastModified = entry.lastModified;
    if (entry.next) meta.next = entry.next;
    // Larger than the whole cache: memory only.
    if (size > this.#maxBytes) {
      this.#forget([url], false);
      return;
    }
    this.#bytes += size - (this.#index.get(url)?.size ?? 0);
    this.#index.set(url, meta);
    this.#persist(this.#store.put(meta, entry.data));
    this.#evict(url);
  }

  /** The server confirmed `url` is unchanged (304): only its time moves. */
  refreshed(url: string): void {
    const now = this.#now();
    const hit = this.#mem.get(url);
    if (hit) hit.fetchedAt = now;
    const meta = this.#index.get(url);
    if (!meta || !this.#store) return;
    meta.fetchedAt = now;
    meta.usedAt = now;
    this.#persist(this.#store.putMeta(meta));
  }

  /** Drop every entry whose URL matches, in memory and in the store. */
  invalidate(match: (url: string) => boolean): void {
    this.#generation++;
    const urls = new Set([...this.#mem.keys(), ...this.#index.keys()].filter(match));
    this.#forget([...urls]);
  }

  #forget(urls: readonly string[], fromMemory = true): void {
    const keys: string[] = [];
    for (const url of urls) {
      if (fromMemory) this.#mem.delete(url);
      const meta = this.#index.get(url);
      if (!meta) continue;
      this.#index.delete(url);
      this.#bytes -= meta.size;
      keys.push(meta.key);
    }
    if (keys.length && this.#store) this.#persist(this.#store.delete(keys));
  }

  /** Above the size cap, drop the least recently used persisted entries (never `keep`). */
  #evict(keep?: string): void {
    if (this.#bytes <= this.#maxBytes) return;
    const lru = [...this.#index].filter(([url]) => url !== keep).sort((a, b) => a[1].usedAt - b[1].usedAt);
    const drop: string[] = [];
    let bytes = this.#bytes;
    for (const [url, meta] of lru) {
      if (bytes <= this.#maxBytes) break;
      drop.push(url);
      bytes -= meta.size;
    }
    // Evicted from the store only; this tab keeps its memory copies.
    this.#forget(drop, false);
  }

  /** Forget everything, and delete the persistent store. */
  async wipe(): Promise<void> {
    this.#generation++;
    this.#mem.clear();
    this.#index.clear();
    this.#bytes = 0;
    const store = this.#store;
    this.#store = undefined;
    this.#login = undefined;
    await this.flushed();
    await store?.destroy();
  }
}

/** An API path's issue or PR (a PR is also an issue): /repos/O/R/issues/N or /pulls/N, and below. */
const ISSUE_PATH_RE = /^\/repos\/([^/]+)\/([^/]+)\/(?:issues|pulls)\/(\d+)(?:\/|$)/;
/** A project's item listings, which embed each item's issue or PR: /users/O/projectsV2/N/items, and below. */
const PROJECT_ITEMS_RE = /^\/(?:users|orgs)\/[^/]+\/projectsV2\/\d+\/items(?:\/|$)/;

function issueOf(pathOrUrl: string): { issue: string | undefined; listing: boolean } {
  const path = new URL(pathOrUrl, "https://api.github.com").pathname;
  const m = ISSUE_PATH_RE.exec(path);
  return { issue: m ? `${m[1]}/${m[2]}#${m[3]}`.toLowerCase() : undefined, listing: path.startsWith("/search/") || PROJECT_ITEMS_RE.test(path) };
}

/**
 * Which cached URLs a successful write to `path` may have made stale:
 * everything under the issue or PR it wrote to, in both its /issues and
 * /pulls trees, and the listings that embed issues: searches, whose
 * results carry comment counts and updated_at, and the board's items,
 * which carry their issue's state and body. A reload right after an
 * action then can't show the state from before it.
 */
export function staleAfterWrite(path: string): (url: string) => boolean {
  const target = issueOf(path).issue;
  if (!target) return () => false;
  return (url) => {
    const u = issueOf(url);
    return u.issue === target || u.listing;
  };
}

/** The cache for a sign-in, and what's needed to attach it to a login later. */
export interface CacheSession {
  cache: ResponseCache;
  store?: PersistentStore;
  tokenHash?: string;
  /**
   * The login the store belongs to, when it was last used with this very
   * token: its entries can be shown before GitHub confirms the login.
   */
  knownLogin?: string;
}

/**
 * Forget cached responses: in memory, the attached store, and any cache
 * database left, e.g. another login's that was never attached. On
 * sign-out, and whenever GitHub rejects the token.
 */
export async function forgetCache(session: CacheSession, destroyAll: () => Promise<void>): Promise<void> {
  await session.cache.wipe();
  await (session.store ? session.store.destroy() : destroyAll()).catch(() => {});
}

/**
 * Open the response cache for a token. Only a remembered token gets a
 * persistent store; otherwise any store left from an earlier sign-in is
 * deleted, and the cache lives in memory, like the token, until the tab
 * closes. Never throws: without storage the cache is memory only.
 */
export async function openCache(
  token: string,
  remember: boolean,
  open: () => Promise<PersistentStore | undefined>,
  destroy: () => Promise<void>,
): Promise<CacheSession> {
  const cache = new ResponseCache();
  if (!remember) {
    await destroy().catch(() => {});
    return { cache };
  }
  const store = await open().catch(() => undefined);
  if (!store) return { cache };
  const session: CacheSession = { cache, store };
  const hash = await tokenHash(token);
  if (!hash) return session;
  session.tokenHash = hash;
  const owner = await store.owner().catch(() => undefined);
  if (owner && owner.tokenHash === hash && (await cache.attach(store, owner.login, hash))) session.knownLogin = owner.login;
  return session;
}
