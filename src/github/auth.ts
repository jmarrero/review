// Where the access token comes from, while the app is hosted on GitHub
// Pages (see "Hosting v0" in docs/design.md): you paste a personal access
// token. It stays in this browser, in sessionStorage (gone with the tab)
// or, if you ask, localStorage, and is only ever sent to api.github.com
// (the GitHub client refuses other URLs, and the CSP's connect-src allows
// no other origin). No authentication service is needed.

import { TOKEN_KEY } from "./config.ts";

/** Where a pasted token is kept. */
export type Persistence = "session" | "local";

export interface TokenSource {
  get(): Promise<string>;
  signOut(): Promise<void>;
  /** Where the token is kept, which also decides whether the response cache persists. */
  persistence: Persistence;
}

/** The two storages, either of which may be missing or throw (private mode, blocked site data). */
export interface Storages {
  session: Storage | undefined;
  local: Storage | undefined;
}

function tryStorage(get: () => Storage): Storage | undefined {
  try {
    return get();
  } catch {
    return undefined;
  }
}

export function browserStorages(): Storages {
  return { session: tryStorage(() => window.sessionStorage), local: tryStorage(() => window.localStorage) };
}

// Classic (ghp_), fine-grained (github_pat_), OAuth (gho_), and GitHub
// App user (ghu_) tokens: prefix, then letters, digits and underscores.
const TOKEN_RE = /^(?:ghp|gho|ghu|github_pat)_[A-Za-z0-9_]{20,}$/;

/** A pasted token, trimmed, or an error saying why it can't be one. */
export function parseToken(input: string): string {
  const t = input.trim();
  if (!t) throw new Error("Paste a token first.");
  if (!TOKEN_RE.test(t)) {
    throw new Error("That doesn't look like a GitHub token: expected one starting with github_pat_ or ghp_.");
  }
  return t;
}

function read(s: Storage | undefined): string | undefined {
  try {
    return s?.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function remove(s: Storage | undefined): void {
  try {
    s?.removeItem(TOKEN_KEY);
  } catch {
    // Blocked storage held nothing.
  }
}

/** Forget the token everywhere this app may have kept it. */
export function forgetToken(storages: Storages = browserStorages()): void {
  remove(storages.session);
  remove(storages.local);
}

function source(token: string, storages: Storages, persistence: Persistence): TokenSource {
  return {
    get: async () => token,
    signOut: async () => forgetToken(storages),
    persistence,
  };
}

/** The saved token, if any: this tab's first, then a remembered one. */
export function savedToken(storages: Storages = browserStorages()): TokenSource | undefined {
  const session = read(storages.session);
  const t = session ?? read(storages.local);
  return t && TOKEN_RE.test(t) ? source(t, storages, session !== undefined ? "session" : "local") : undefined;
}

/**
 * Use a pasted token, saving it where asked. Saving it in one storage
 * removes it from the other, so "remember" can be turned off again. If
 * storage is blocked, the token lives in memory only, until reload.
 */
export function useToken(input: string, persistence: Persistence, storages: Storages = browserStorages()): TokenSource {
  const t = parseToken(input);
  forgetToken(storages);
  try {
    storages[persistence]?.setItem(TOKEN_KEY, t);
  } catch {
    // Memory only.
  }
  return source(t, storages, persistence);
}

/** A classic token scope requirement: any one of `any` satisfies it. */
export interface ScopeNeed {
  any: readonly string[];
  why: string;
}

/**
 * The requirements a classic token's scopes (the X-OAuth-Scopes header)
 * leave unmet. Fine-grained tokens send no such header: undefined in,
 * nothing reported.
 */
export function missingScopes(header: string | undefined, needs: readonly ScopeNeed[]): ScopeNeed[] {
  if (header === undefined) return [];
  const have = new Set(header.split(",").map((s) => s.trim()).filter(Boolean));
  return needs.filter((n) => !n.any.some((s) => have.has(s)));
}
