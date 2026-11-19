// Draws Needs you from any checkout of this repository against this
// checkout's fixtures, offline, and writes the page with that checkout's
// style.css inlined, for screenshots that compare commits on the same data:
//
//   git worktree add /tmp/before 4a8d672
//   node test/e2e/render-needs-you.ts /tmp/before group /tmp/before.html [CARD_KEY]
//   chromium --headless --screenshot=/tmp/before.png --window-size=1280,2400 file:///tmp/before.html
//
// For a screenshot of this checkout alone, `npm run test:browser` (see
// test/browser/app.spec.ts) needs no manual step. The checkout needs
// node_modules (a symlink to this one's will do). The data is one of
// fixture-api.ts's FIXTURE_DATA. CARD_KEY opens that card's details and
// its first two members.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { FIXTURE_DATA, type FixtureData, FIXTURE_TOKEN, fixtureResponse } from "./fixture-api.ts";

const [checkout, data, out, open] = process.argv.slice(2);
if (!checkout || !data || !out) throw new Error(`usage: render-needs-you.ts CHECKOUT ${FIXTURE_DATA.join("|")} OUT.html [CARD_KEY]`);
if (!(FIXTURE_DATA as readonly string[]).includes(data)) throw new Error(`unknown data ${data}: ${FIXTURE_DATA.join(", ")}`);
const SETTLE_MS = 200;
const dom = new JSDOM(readFileSync(resolve(checkout, "static/index.html"), "utf8"), { url: "https://review.example/#inbox", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
const { window } = dom;
window.scrollTo = () => {};
Object.assign(globalThis, {
  window, document: window.document, Node: window.Node, HTMLElement: window.HTMLElement, localStorage: window.localStorage,
  ResizeObserver: class { observe() {} disconnect() {} },
  fetch: async (input: string, init?: RequestInit) => {
    const body = fixtureResponse(data as FixtureData, init?.method ?? "GET", new URL(input).pathname, init?.body == null ? undefined : String(init.body));
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  },
});

const doc = window.document;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 300; i++, await sleep(10)) if (check()) return;
  throw new Error(`timed out waiting for ${what}`);
}
await import(pathToFileURL(resolve(checkout, "src/github/main.ts")).href);
await until(() => !!doc.querySelector(".signin"), "sign-in");
doc.querySelector<HTMLInputElement>(".signin input[type=password]")!.value = FIXTURE_TOKEN;
doc.querySelector(".signin")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
await until(() => !!doc.querySelector(".published") && !doc.querySelector(".published")!.textContent!.startsWith("Reading"), "the published list");
await sleep(SETTLE_MS);
if (open) {
  const card = doc.querySelector(`.inbox-cards > .card[data-key="${open}"]`);
  if (!card) throw new Error(`no card ${open}`);
  const opened = [card.querySelector<HTMLDetailsElement>(".card-full"), ...[...card.querySelectorAll<HTMLDetailsElement>("details.member")].slice(0, 2)];
  for (const d of opened) if (d) { d.open = true; d.dispatchEvent(new window.Event("toggle")); await sleep(SETTLE_MS); }
}
for (const el of doc.querySelectorAll('script, link[rel=stylesheet], meta[http-equiv="Content-Security-Policy"]')) el.remove();
doc.head.append(Object.assign(doc.createElement("style"), { textContent: readFileSync(resolve(checkout, "static/style.css"), "utf8") }));
writeFileSync(out, `<!doctype html>\n${doc.documentElement.outerHTML}`);
process.exit(0);
