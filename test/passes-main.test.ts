// Real entry-point replay of cached independent history, without a holds snapshot.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { JSDOM, VirtualConsole } from "jsdom";
import { GitHub } from "../src/github/api.ts";
import { ResponseCache, tokenHash } from "../src/github/cache.ts";
import { TOKEN_KEY } from "../src/github/config.ts";
import { IdbStore } from "../src/github/idbstore.ts";
import { NEEDS_HUMAN_QUERY } from "../src/github/needshuman.ts";
import { PASSES_MARKER } from "../src/github/passes.ts";
import { usagePath } from "../src/github/usage.ts";
import { fixture } from "./helpers.ts";

for (const route of ["inbox", "status"]) it(`retains cold cached history without holds on #${route} after HTTP 503`, async () => {
  const factory = new IDBFactory();
  const store = await IdbStore.open(factory);
  assert.ok(store);
  const token = ["ghp", "x".repeat(24)].join("_");
  const cache = new ResponseCache();
  assert.equal(await cache.attach(store, "jmarrero", await tokenHash(token)), true);
  const data = fixture("passes.json");
  const comments = [{ user: { login: "jmarrero-bot" }, body: `${PASSES_MARKER}\n\n\`\`\`json\n${JSON.stringify(data)}\n\`\`\`` }];
  await new GitHub(async () => token, async () => Response.json(comments, { headers: { etag: '"history"' } }), cache).get(usagePath);
  await cache.flushed();
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error: Error) => {
    if (!error.message.startsWith("Not implemented: navigation")) throw error;
  });
  const dom = new JSDOM(readFileSync(new URL("../static/index.html", import.meta.url), "utf8"), {
    url: `https://review.example/#${route}`, pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.scrollTo = () => {};
  window.localStorage.setItem(TOKEN_KEY, token);
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const requests: string[] = [];
  Object.assign(globalThis, {
    indexedDB: factory, window, document: window.document, Node: window.Node, HTMLElement: window.HTMLElement,
    ResizeObserver: class { observe() {} disconnect() {} },
    fetch: async (input: string, init?: RequestInit) => {
      assert.ok(!init?.method || init.method === "GET" || new URL(input).pathname === "/graphql", "no live writes");
      const url = new URL(input);
      // The failed publication's one allowed search: Act now's direct needs-human read.
      requests.push(url.pathname === "/search/issues" && url.searchParams.get("q") === NEEDS_HUMAN_QUERY ? "needs-human" : url.pathname);
      if (url.pathname + url.search === usagePath) {
        await gate;
        return Response.json({ message: "Synthetic publication failure" }, { status: 503 });
      }
      return Response.json(url.pathname === "/user" ? { login: "jmarrero" }
        : url.pathname === "/graphql" ? { data: {} } : []);
    },
  });
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`Timed out: ${window.document.querySelector("#view")?.textContent}; notice: ${window.document.querySelector("#notice")?.textContent}; meta: ${window.document.querySelector("#meta")?.textContent}; requests: ${requests.join(", ")}`);
  };
  const panel = () => window.document.querySelector('[aria-label="Scheduler passes"]');
  try {
    await import(`../src/github/main.ts?cached-passes=${route}`);
    release();
    await until(() => !!panel()?.textContent?.includes("HTTP 503"));
    assert.match(panel()!.textContent!, /What follows is the last one read/);
    assert.ok(panel()!.querySelector("a[href$='/actions/runs/42064057295']"));
    assert.ok(panel()!.querySelector(".pass-record"));
    assert.doesNotMatch(panel()!.textContent!, /well under pace with nothing ready|None running/);
    assert.equal(window.document.querySelectorAll('[aria-label="Scheduler passes"], [aria-label="Poller passes"]').length, 1);
    assert.equal(requests.filter((p) => p.endsWith("/issues/1/comments")).length, 1);
    // Live agents' own read of the agent workflows' runs is the one Actions read.
    const live = (p: string) => /^\/repos\/[^/]+\/[^/]+\/actions\/workflows\/(dispatch|agent)\.yml\/runs$/.test(p);
    assert.ok(!requests.some((p) => (p.includes("/actions/") && !live(p)) || p.endsWith("/items") || p === "/search/issues"), "no target/operations discovery");
  } finally {
    release();
    window.document.querySelector<HTMLButtonElement>("#signout")?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    window.close();
  }
});
