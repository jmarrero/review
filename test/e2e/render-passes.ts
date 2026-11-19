// Offline synthetic replay only: no network or write authority.
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { installDom } from "../helpers.ts";
import { PASSES_MARKER, parsePasses } from "../../src/github/passes.ts";
import { schedulerPassView, type PassesRead } from "../../src/github/passesview.ts";
import { homeSkeleton } from "../../src/github/homeview.ts";

const [state, out] = process.argv.slice(2);
if (!out || !["populated", "zero-start", "failed-section", "absent", "stale", "unavailable"].includes(state!)) {
  throw new Error("usage: render-passes.ts populated|zero-start|failed-section|absent|stale|unavailable OUT.html");
}
installDom();
const raw = JSON.parse(readFileSync(new URL("../fixtures/passes.json", import.meta.url), "utf8"));
if (state === "populated") raw.passes = [raw.passes[1]];
if (state === "zero-start") raw.passes = [raw.passes[0]];
if (state === "failed-section") raw.passes = [raw.passes[2], raw.passes[3]];
const data = parsePasses(`${PASSES_MARKER}\n\n\`\`\`json\n${JSON.stringify(raw)}\n\`\`\``);
assert.ok(data && typeof data === "object");
const read: PassesRead = state === "absent" ? { absent: true } : { data, ...(state === "unavailable" ? { unavailable: "HTTP 503 (synthetic read failure)" } : {}) };
const now = Date.parse("2026-11-05T12:00:00Z") + (state === "stale" ? 7_200_000 : 0);
const home = homeSkeleton({ toggled() {} });
home.slots.passes.append(schedulerPassView(read, undefined, now));
for (const el of home.el.querySelectorAll<HTMLElement>('[data-view="inbox"]')) el.hidden = true;
assert.equal(home.el.querySelectorAll(".pass-view").length, 1);
const style = readFileSync(new URL("../../static/style.css", import.meta.url), "utf8");
writeFileSync(out, `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${style}</style><title>Pass replay: ${state}</title></head><body><main><p>Synthetic offline replay: ${state}; not live producer evidence.</p>${home.el.outerHTML}</main></body></html>`);
