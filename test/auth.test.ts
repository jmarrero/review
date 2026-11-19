import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { missingScopes, parseToken, savedToken, type Storages, useToken } from "../src/github/auth.ts";
import { CLASSIC_SCOPES, TOKEN_KEY } from "../src/github/config.ts";

const FINE = `github_pat_${"A1b2".repeat(10)}`;
const CLASSIC = `ghp_${"x9Y8".repeat(9)}`;

/** A Storage in memory; `blocked` makes every call throw, like disabled site data. */
class MemoryStorage implements Storage {
  #m = new Map<string, string>();
  #blocked: boolean;
  constructor(blocked = false) {
    this.#blocked = blocked;
  }
  #check(): void {
    if (this.#blocked) throw new DOMException("blocked", "SecurityError");
  }
  get length(): number {
    return this.#m.size;
  }
  clear(): void {
    this.#check();
    this.#m.clear();
  }
  getItem(k: string): string | null {
    this.#check();
    return this.#m.get(k) ?? null;
  }
  key(i: number): string | null {
    return [...this.#m.keys()][i] ?? null;
  }
  removeItem(k: string): void {
    this.#check();
    this.#m.delete(k);
  }
  setItem(k: string, v: string): void {
    this.#check();
    this.#m.set(k, v);
  }
}

const storages = (blocked = false): Storages => ({ session: new MemoryStorage(blocked), local: new MemoryStorage(blocked) });

describe("parseToken", () => {
  const cases: [string, string, string | RegExp][] = [
    ["fine-grained, padded", ` ${FINE}\n`, FINE],
    ["classic", CLASSIC, CLASSIC],
    ["empty", "  ", /Paste a token/],
    ["unknown prefix", `xyz_${"a".repeat(30)}`, /doesn't look like/],
    ["too short", "ghp_abc", /doesn't look like/],
    ["with spaces", `ghp_${"a".repeat(20)} b`, /doesn't look like/],
    ["an HTML payload", `ghp_${"a".repeat(20)}<script>`, /doesn't look like/],
  ];
  for (const [name, input, want] of cases) {
    it(name, () => {
      if (typeof want === "string") assert.equal(parseToken(input), want);
      else assert.throws(() => parseToken(input), want);
    });
  }
});

describe("useToken and savedToken", () => {
  it("keeps the token in sessionStorage by default", async () => {
    const s = storages();
    assert.equal(await useToken(FINE, "session", s).get(), FINE);
    assert.equal(s.session?.getItem(TOKEN_KEY), FINE);
    assert.equal(s.local?.getItem(TOKEN_KEY), null);
    assert.equal(await savedToken(s)?.get(), FINE);
  });

  it("remembers in localStorage only when asked, and moves it back", () => {
    const s = storages();
    useToken(FINE, "local", s);
    assert.equal(s.local?.getItem(TOKEN_KEY), FINE);
    assert.equal(s.session?.getItem(TOKEN_KEY), null);
    useToken(CLASSIC, "session", s);
    assert.equal(s.local?.getItem(TOKEN_KEY), null);
    assert.equal(s.session?.getItem(TOKEN_KEY), CLASSIC);
  });

  it("signs out of both storages", async () => {
    const s = storages();
    s.session?.setItem(TOKEN_KEY, FINE);
    s.local?.setItem(TOKEN_KEY, CLASSIC);
    await savedToken(s)?.signOut();
    assert.equal(savedToken(s), undefined);
  });

  it("ignores a saved value that isn't a token", () => {
    const s = storages();
    s.session?.setItem(TOKEN_KEY, "garbage");
    assert.equal(savedToken(s), undefined);
  });

  it("works in memory when storage is blocked", async () => {
    const s = storages(true);
    assert.equal(await useToken(FINE, "local", s).get(), FINE);
    assert.equal(savedToken(s), undefined);
    assert.equal(savedToken({ session: undefined, local: undefined }), undefined);
  });
});

describe("missingScopes", () => {
  const missing = (h: string | undefined) => missingScopes(h, CLASSIC_SCOPES).map((n) => n.any[0]);
  const cases: [string | undefined, string[]][] = [
    [undefined, []],
    ["", ["read:project"]],
    ["repo, project", []],
    ["public_repo, read:project, gist", []],
    ["repo,gist", ["read:project"]],
    ["read:project", []],
  ];
  for (const [header, want] of cases) it(String(header), () => assert.deepEqual(missing(header), want));
});
