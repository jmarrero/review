// Shared test setup: a jsdom window, synthetic fixtures, and a scripted
// fetch that records requests.

import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { JSDOM } from "jsdom";
import type { RawField, RawItem } from "../src/github/board.ts";

export function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8")) as T;
}

// Approved redacted 3 Nov publication, review#226, merged as
// 64a206d02a081e69af8697a7fb244a2992a0fff4. Spend/overhead and one
// security-sensitive item were removed by the publisher. No private reads.
// The published 12 asks have no groups; variants are constructed contracts.
export const REAL_NEEDS_YOU_AT = "2026-11-03T17:41:35.039037224Z";

export const REAL_NEEDS_YOU_KEYS = [
  "jmarrero-forge/agentic-job#2110", "jmarrero-forge/composefs-rs#33",
  "jmarrero-forge/agentic-job#2811", "jmarrero-forge/agent-board#308",
  "jmarrero-forge/composefs-rs#32", "jmarrero-forge/tracker#430",
  "jmarrero-forge/agentic-job#2026", "jmarrero-forge/tracker#12",
  "jmarrero-forge/tracker#163", "jmarrero-forge/tracker#24",
  "jmarrero-forge/tracker#308", "jmarrero-forge/tracker#7",
];

export const realNeedsYouSnapshot = () => fixture<{
  at: string;
  needs_you: { count: number; items: Record<string, unknown>[]; requests: Record<string, unknown>[] };
}>("needs-you-real-2026-11-03.json");

export const fields = (): RawField[] => fixture<RawField[]>("fields.json");
export const rawItems = (): RawItem[] => fixture<RawItem[]>("items.json");

/** A fresh jsdom window, also installed as the global document. */
export function installDom(): JSDOM["window"] {
  const { window } = new JSDOM("<!doctype html><html><body></body></html>");
  Object.assign(globalThis, { document: window.document, window });
  return window;
}

export interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface Scripted {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * A fetch that answers from `route` and records each request. Throws on
 * an unrouted request so a test can't silently hit the network.
 */
export function scriptedFetch(route: (method: string, url: string, headers: Record<string, string>) => Scripted | undefined) {
  const calls: Recorded[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, headers, body });
    const r = route(method, url, headers);
    if (!r) throw new Error(`unexpected request: ${method} ${url}`);
    const status = r.status ?? 200;
    const payload = status === 204 || status === 205 || status === 304 ? null : JSON.stringify(r.body ?? {});
    return new Response(payload, { status, headers: { "content-type": "application/json", ...r.headers } });
  };
  return { fetchImpl, calls };
}

const TEXT_FIELDS: readonly string[] = ["Why", "Branch", "Gist", "Verdict target"];

/** A board item with the given fields set, as the Projects REST API returns them. */
export function rawBoardItem(n: number, fields: Record<string, string>, title = `item ${n}`): RawItem {
  return {
    id: n,
    node_id: `PVTI_t${n}`,
    content_type: "Issue",
    content: { title, html_url: `https://github.com/jmarrero-forge/tracker/issues/${n}`, state: "open" },
    fields: Object.entries(fields).map(([name, v], i) =>
      TEXT_FIELDS.includes(name)
        ? { id: 200 + i, name, data_type: "text", value: { raw: v } }
        : { id: 200 + i, name, data_type: "single_select", value: { name: { raw: v } } },
    ),
  };
}

/** A published ask as agent-board's pass writes it (its docs/pass.md), on cgwalters-forge/tracker#n unless `over` says otherwise. */
export function rawAsk(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const repository = "jmarrero-forge/tracker";
  return {
    key: `${repository}#${n}`, item: `${repository}#${n}`, source: "items", kind: "needs-human", priority: null, waiting_since: "2026-10-29T18:24:18Z",
    ask: `Ask ${n}?`, recommendation: null, target: `https://github.com/${repository}/issues/${n}`, head: null,
    action: { type: "issue", repository, number: n }, source_ref: { type: "hold", repository, number: n }, ...over,
  };
}

/** One producer-shaped Act now record bound to its detailed ask. */
export function rawActNow(ask: Record<string, unknown>, unblocks = 1): Record<string, unknown> {
  return { key: ask.key, unblocks, priority: ask.priority, waiting_since: ask.waiting_since, action: ask.action };
}

/** A needs-you list of `items`, complete and confirmed at `at`. */
export function rawNeedsYou(items: unknown[], at: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "agent-board/needs-you/v2", complete: true, validated_at: at, changed_at: at,
    sources: { epics: "complete", items: "complete", reviews: "complete", proposals: "complete", digest: "off" },
    summaries: "complete", omitted: 0, count: items.length, items, ...over,
  };
}

/** The bot's hold comment holding `needsYou` (left out where undefined), as the pass renders it. */
export function holdsComment(at: string, needsYou?: unknown, holds: unknown[] = publishedTestHolds(needsYou)): { user: { login: string }; body: string } {
  const snapshot = { schema: "agent-board/holds/v1", at, truncated: 0, holds, ...(needsYou === undefined ? {} : { needs_you: needsYou }) };
  return { user: { login: "jmarrero-bot" }, body: `<!-- agent-board-holds v1 -->\nHolds as of ${at}.\n\n\`\`\`json\n${JSON.stringify(snapshot)}\n\`\`\`\n` };
}

/** agent-board's PART_CHARS: the base64 each comment of a compressed snapshot carries. */
export const PART_CHARS = 59_000;

/**
 * The plain hold comment `body`, a snapshot at `at`, published compressed as
 * agent-board's `holds::parts` does past one comment (agent-board#774), in
 * pieces of `partChars`, the bot's comments in the order the pass leaves them.
 */
export function compressedHolds(body: string, at: string, partChars = PART_CHARS): { user: { login: string }; body: string }[] {
  const encoded = gzipSync(body).toString("base64");
  const pieces = Array.from({ length: Math.ceil(encoded.length / partChars) }, (_, i) => encoded.slice(i * partChars, (i + 1) * partChars));
  const count = pieces.length;
  return pieces.map((piece, i) => {
    const [marker, header, said] = i === 0
      ? ["<!-- agent-board-holds v1 -->", { schema: "agent-board/holds-parts/v1", at, encoding: "gzip+base64", parts: count }, `Holds as of ${at}, compressed across ${count} comments.`]
      : ["<!-- agent-board-holds part v1 -->", { schema: "agent-board/holds-parts/v1", at, part: i + 1 }, `Part ${i + 1} of ${count} of the holds as of ${at}.`];
    return { user: { login: "jmarrero-bot" }, body: `${marker}\n${said}\n\n\`\`\`json\n${JSON.stringify(header)}\n\`\`\`\n\n\`\`\`text\n${piece}\n\`\`\`\n` };
  });
}

/** Normal synthetic publications include the operator holds behind their asks. */
export function publishedTestHolds(list: unknown): unknown[] {
  const published = list as { items?: Record<string, unknown>[]; identities?: Record<string, unknown>[] } | undefined;
  const items = [...new Map([...(published?.items ?? []), ...(published?.identities ?? [])].map((a) => [a.item, a])).values()];
  return items.filter((a) => ["epics", "items", "pass", "holds"].includes(String(a.source))).map((a) => ({
    item: a.item, url: `https://github.com/${String(a.item).replace("#", "/issues/")}`, epic: a.source === "epics", kind: a.kind,
    reason: a.ask ?? "Waiting on the operator", operator: true, priority: a.priority ?? null, question: null,
  }));
}
