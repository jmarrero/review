// A small GitHub REST client: conditional GETs with ETags or
// Last-Modified (a 304 costs no rate budget when authorised) against one
// response cache (cache.ts), pagination by Link header, and rate-limit
// tracking. `fetch` is injected so tests can script responses.
//
// It also keeps the app inside GitHub's secondary rate limits, which
// punish concurrent requests: at most GITHUB_CONCURRENCY requests are in
// flight, searches (which have a budget of their own, 30 a minute) one
// at a time. Once GitHub says a limit was hit, nothing more is sent until
// it said to retry; until then requests fail at once with RateLimited.

import { type CachedResponse, ResponseCache, staleAfterWrite } from "./cache.ts";
import { API_ROOT, GITHUB_CONCURRENCY, RATE_LIMIT_WAIT_MS, REQUEST_TIMEOUT_MS } from "./config.ts";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export type TokenGetter = () => Promise<string>;

export class GitHubError extends Error {
  override name = "GitHubError";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** GitHub refused a request for a rate limit, or one was still in force: nothing is sent before `retryAt`. */
export class RateLimited extends GitHubError {
  override name = "RateLimited";
  /** Epoch ms. */
  readonly retryAt: number;
  constructor(status: number, retryAt: number, now: number) {
    super(status, `GitHub rate limit: retrying in ${Math.max(1, Math.ceil((retryAt - now) / 1000))} s`);
    this.retryAt = retryAt;
  }
}

/**
 * How long a refused request says to wait (ms), if it was refused for a
 * rate limit, the documented ways: a 403 or 429 with retry-after, or with
 * x-ratelimit-remaining 0 and x-ratelimit-reset; or the secondary-limit
 * message without either, for which GitHub says to wait a minute.
 * Undefined for any other failure, such as a 403 for a missing permission.
 */
export function rateLimitWait(status: number, headers: Headers, message: string, now: number): number | undefined {
  if (status !== 403 && status !== 429) return undefined;
  const after = Number(headers.get("retry-after") ?? NaN);
  if (Number.isFinite(after) && after >= 0) return after * 1000;
  const reset = Number(headers.get("x-ratelimit-reset") ?? NaN);
  if (headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset)) return Math.max(0, reset * 1000 - now);
  if (status === 429 || /rate limit/i.test(message)) return RATE_LIMIT_WAIT_MS;
  return undefined;
}

/** At most `n` holders at once; the others wait their turn, first come first served. */
class Slots {
  #free: number;
  readonly #waiting: (() => void)[] = [];
  constructor(n: number) {
    this.#free = n;
  }

  /** Wait for a slot; call the returned function once to give it back. */
  async take(): Promise<() => void> {
    if (this.#free > 0) this.#free--;
    else await new Promise<void>((resolve) => this.#waiting.push(resolve));
    let given = false;
    return () => {
      if (given) return;
      given = true;
      const next = this.#waiting.shift();
      if (next) next();
      else this.#free++;
    };
  }
}

export interface RateLimit {
  limit: number;
  remaining: number;
  /** Epoch seconds. */
  reset: number;
}

/** A cache-only read found nothing cached. */
export class CacheMiss extends Error {
  override name = "CacheMiss";
}

export interface Fetched<T> {
  data: T;
  /** False when the server answered 304 and the cached data was reused. */
  changed: boolean;
}

/** The URL of rel="next" in a Link header, if any. */
export function nextLink(link: string | null): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part.trim());
    if (m && m[2]?.split(/\s+/).includes("next")) return m[1];
  }
  return undefined;
}

/** A message, or an error entry's message (GitHub sends strings or objects). */
function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : "";
}

/** GitHub's error details, joined; empty if the body has none or isn't JSON. */
async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown; errors?: unknown };
    return [body.message, ...(Array.isArray(body.errors) ? body.errors : [])].map(errorText).filter(Boolean).join("; ");
  } catch {
    // Not JSON; the status is enough.
    return "";
  }
}

async function errorMessage(res: Response, what: string): Promise<string> {
  const detail = await errorDetail(res);
  // A rate limit never gets here: #send throws RateLimited for it.
  const hint =
    res.status === 401
      ? " (the token is invalid or expired; sign in again)"
      : res.status === 403 || res.status === 404
        ? " (no access with this token, or it lacks a permission)"
        : "";
  return `${what} failed with HTTP ${res.status}${detail ? `: ${detail}` : ""}${hint}`;
}

export class GitHub {
  #fetch: Fetch;
  #token: TokenGetter;
  readonly cache: ResponseCache;
  /** Called on any 401: the token was revoked or expired. */
  onUnauthorized: (() => void) | undefined;
  /** Answer GETs from the cache only, never the network (see cacheOnly). */
  #cacheOnly = false;
  #oldest: number | undefined;
  #ageParent: GitHub | undefined;
  rate: RateLimit | undefined;
  /** A classic token's scopes, from X-OAuth-Scopes; unset for other tokens. */
  scopes: string | undefined;
  /** Give up on a request unanswered for this long (ms). */
  timeoutMs = REQUEST_TIMEOUT_MS;
  /** The GETs waiting for an answer, and when each was sent, for abandonGets. */
  readonly #pending = new Set<{ sent: number; abort: AbortController }>();
  readonly #slots = new Slots(GITHUB_CONCURRENCY);
  readonly #searchSlot = new Slots(1);
  #blockedUntil = 0;

  constructor(token: TokenGetter, fetchImpl: Fetch = (i, init) => fetch(i, init), cache: ResponseCache = new ResponseCache()) {
    this.#token = token;
    this.#fetch = fetchImpl;
    this.cache = cache;
  }

  /**
   * A client over the same cache that never touches the network: GETs
   * answer from the cache or throw CacheMiss, and writes are refused. The
   * same loaders then render the last known state before revalidating.
   */
  cacheOnly(): GitHub {
    const gh = new GitHub(this.#token, () => Promise.reject(new Error("cache-only client")), this.cache);
    gh.#cacheOnly = true;
    return gh;
  }

  /** On a cache-only client: when the oldest response it served was fetched (epoch ms). */
  get oldest(): number | undefined {
    return this.#oldest;
  }

  /** Isolate a source's cache ages; live reads keep this client's request and rate tracking. */
  readScope(): GitHub {
    if (!this.#cacheOnly) return this;
    const scope = this.cacheOnly();
    scope.#ageParent = this;
    return scope;
  }

  /** The API URL for PATH; the token never goes anywhere else. */
  #url(path: string): string {
    if (path.startsWith(`${API_ROOT}/`)) return path;
    if (/^[a-z]+:/i.test(path)) throw new Error(`refusing to send the token outside ${API_ROOT}: ${path}`);
    if (!path.startsWith("/")) throw new Error(`API path must start with /: ${path}`);
    return `${API_ROOT}${path}`;
  }

  #noteRate(res: Response): void {
    // Search and GraphQL have budgets of their own; track the core one.
    const resource = res.headers.get("x-ratelimit-resource");
    if (resource !== null && resource !== "core") return;
    const limit = Number(res.headers.get("x-ratelimit-limit"));
    const remaining = Number(res.headers.get("x-ratelimit-remaining"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (limit > 0 && Number.isFinite(remaining)) this.rate = { limit, remaining, reset };
    const scopes = res.headers.get("x-oauth-scopes");
    if (scopes !== null) this.scopes = scopes;
  }

  /**
   * Abandon the GETs sent before `before` (epoch ms) still waiting for an
   * answer: after the page was suspended, one may never get one. Writes
   * are left alone: abandoning one wouldn't undo it.
   */
  abandonGets(before: number): void {
    for (const p of this.#pending) if (p.sent < before) p.abort.abort();
  }

  /** Until when (epoch ms) GitHub said to send nothing; 0 or past when nothing is held back. */
  get blockedUntil(): number {
    return this.#blockedUntil;
  }

  /**
   * Send a request once a slot is free (and, for a search, once no other
   * search is in flight), unless a rate limit holds it back. The slot is
   * held until the response's headers arrive, not while its body is read.
   */
  async #send(method: string, url: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
    const search = url.startsWith(`${API_ROOT}/search/`);
    const releaseSearch = search ? await this.#searchSlot.take() : undefined;
    const release = await this.#slots.take();
    try {
      // Checked once it is this request's turn: a limit may have been hit while it waited.
      const now = Date.now();
      if (now < this.#blockedUntil) throw new RateLimited(429, this.#blockedUntil, now);
      const res = await this.#sendNow(method, url, headers, body);
      if (res.status === 403 || res.status === 429) {
        // A clone, so the caller can still read the body of any other 403.
        const at = Date.now();
        const wait = rateLimitWait(res.status, res.headers, await errorDetail(res.clone()), at);
        if (wait !== undefined) {
          this.#blockedUntil = Math.max(this.#blockedUntil, at + wait);
          throw new RateLimited(res.status, this.#blockedUntil, at);
        }
      }
      return res;
    } finally {
      release();
      releaseSearch?.();
    }
  }

  async #sendNow(method: string, url: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    // AbortSignal.any is recent (Safari 17.4); without it, GETs just can't be abandoned.
    const pending = method === "GET" && typeof AbortSignal.any === "function" ? { sent: Date.now(), abort: new AbortController() } : undefined;
    const init: RequestInit = {
      method,
      signal: pending ? AbortSignal.any([timeout, pending.abort.signal]) : timeout,
      // We do our own conditional requests; the browser cache would
      // otherwise answer from its copy for max-age=60 without asking.
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${await this.#token()}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...headers,
      },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    }
    let res: Response;
    if (pending) this.#pending.add(pending);
    try {
      res = await this.#fetch(url, init);
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") throw new Error(`${method} ${url}: GitHub didn't answer within ${Math.round(this.timeoutMs / 1000)} s`);
      if (pending?.abort.signal.aborted) throw new Error(`${method} ${url}: abandoned, the page was suspended while it waited`);
      throw e;
    } finally {
      if (pending) this.#pending.delete(pending);
    }
    this.#noteRate(res);
    if (res.status === 401) this.onUnauthorized?.();
    return res;
  }

  /** GET one page, conditionally if we have it cached with a validator. */
  async #getPage(url: string): Promise<{ entry: CachedResponse; changed: boolean }> {
    const cached = await this.cache.get(url);
    if (this.#cacheOnly) {
      if (!cached) throw new CacheMiss(`not cached: GET ${url}`);
      this.#oldest = Math.min(this.#oldest ?? cached.fetchedAt, cached.fetchedAt);
      if (this.#ageParent) this.#ageParent.#oldest = Math.min(this.#ageParent.#oldest ?? cached.fetchedAt, cached.fetchedAt);
      return { entry: cached, changed: true };
    }
    const validators: Record<string, string> = {};
    if (cached?.etag) validators["If-None-Match"] = cached.etag;
    else if (cached?.lastModified) validators["If-Modified-Since"] = cached.lastModified;
    const generation = this.cache.generation;
    const res = await this.#send("GET", url, validators);
    if (res.status === 304 && cached) {
      this.cache.refreshed(url);
      return { entry: cached, changed: false };
    }
    if (!res.ok) throw new GitHubError(res.status, await errorMessage(res, `GET ${url}`));
    const text = await res.text();
    const entry: CachedResponse = { data: JSON.parse(text) as unknown, fetchedAt: this.cache.now() };
    const etag = res.headers.get("etag");
    const lastModified = res.headers.get("last-modified");
    const next = nextLink(res.headers.get("link"));
    if (etag) entry.etag = etag;
    if (lastModified) entry.lastModified = lastModified;
    if (next) entry.next = next;
    this.cache.put(url, entry, text.length, generation);
    return { entry, changed: true };
  }

  /** GET a JSON resource, conditionally. */
  async get<T>(path: string): Promise<Fetched<T>> {
    const { entry, changed } = await this.#getPage(this.#url(path));
    return { data: entry.data as T, changed };
  }

  /**
   * GET a resource that stops changing once final, such as a finished
   * run's jobs: a cached copy that `isFinal` accepts (by its content,
   * not by comparing clocks) is used as is, without asking GitHub again.
   * A final copy is current, so it doesn't count toward `oldest`.
   */
  async getSettled<T>(path: string, isFinal: (data: T) => boolean): Promise<Fetched<T>> {
    const url = this.#url(path);
    const cached = await this.cache.get(url);
    if (cached && isFinal(cached.data as T)) return { data: cached.data as T, changed: false };
    // A copy from before it was final is no answer, not even a stale one.
    if (this.#cacheOnly) throw new CacheMiss(`not cached in its final state: GET ${url}`);
    return this.get<T>(path);
  }

  /**
   * GET every page of a list. Changed if any page changed, or the number
   * of pages did.
   */
  async getAll<T>(path: string, maxPages = 20): Promise<Fetched<T[]>> {
    const out: T[] = [];
    let changed = false;
    let url: string | undefined = this.#url(path);
    for (let page = 0; url; page++) {
      if (page >= maxPages) throw new Error(`GET ${path}: more than ${maxPages} pages; refusing to continue`);
      const { entry, changed: pageChanged } = await this.#getPage(this.#url(url));
      if (!Array.isArray(entry.data)) throw new Error(`GET ${url}: expected a JSON array`);
      out.push(...(entry.data as T[]));
      changed ||= pageChanged;
      url = entry.next;
    }
    return { data: out, changed };
  }

  /**
   * An unconditional request, with an optional JSON body. It never reads
   * or fills the cache, so a GET here is always the server's current
   * answer: guards before a write (the approve's head check) use it. A
   * successful write drops the cached responses it may have changed.
   */
  async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (this.#cacheOnly) throw new Error(`cache-only client: not sending ${method} ${path}`);
    const url = this.#url(path);
    // A write may land even if its response is lost, so invalidate first.
    if (method !== "GET") this.cache.invalidate(staleAfterWrite(url));
    const res = await this.#send(method, url, {}, body);
    if (!res.ok) throw new GitHubError(res.status, await errorMessage(res, `${method} ${path}`));
    // And again: a GET that raced the write may have cached the old state.
    if (method !== "GET") this.cache.invalidate(staleAfterWrite(url));
    // Some writes succeed with no body: 204, and 205 from marking a
    // notification thread read. Parse only what is there.
    const text = await res.text();
    return (text === "" ? undefined : JSON.parse(text)) as T;
  }

  /** True when the rate budget is below `fraction` of its limit. */
  rateLow(fraction: number): boolean {
    return this.rate !== undefined && this.rate.remaining < this.rate.limit * fraction;
  }
}
