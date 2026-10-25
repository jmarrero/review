// review-queue: the review queue on the command line, as JSON or text.
// It loads the queue exactly as the app does (board, forge PRs and their
// verdicts, the bot's other PRs and whose turn each is, answered asks)
// and ranks and filters it with the same code.
// Read-only: the client refuses anything but GET.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type Fetch, GitHub, GitHubError } from "../github/api.ts";
import { loadAnswered, loadQueue } from "../github/backend.ts";
import { ALL, applyFilter, entryOrg, NO_ORG, parseFilterToken, type QueueFilter } from "../github/filter.ts";
import type { ForgePr, Verdict } from "../github/forge.ts";
import { queueJson, queueText, SCHEMA } from "../github/export.ts";
import { loadForgePrs, loadOtherPrs, loadWaiting, refreshVerdicts, searchBotPrs, type WaitingPr } from "../github/prs.ts";
import { buildEntries, type Entry } from "../github/queue.ts";

export const PROG = "review-queue";

/** Environment variables holding a token, in the order gh itself reads them. */
export const TOKEN_ENV = ["GH_TOKEN", "GITHUB_TOKEN"] as const;
/** The host whose `gh` token is used; the client talks to its API only. */
const GITHUB_HOST = "github.com";

export const USAGE = `Usage: ${PROG} [--json | --text] [--filter FILTER]

Print what is waiting on jmarrero (the review app's queue), ranked as the
app ranks it: P0 first, then the oldest; answered asks, then PRs waiting
on the bot, last.

  --json           the ${SCHEMA} JSON document (default when stdout isn't a terminal)
  --text           a human-readable list (default on a terminal)
  --filter FILTER  the app's filter tokens: all (default); composefs, meaning all
                   upstream work (every org but jmarrero-bot and jmarrero-forge;
                   use org:composefs for that org alone); infra, the bot's own
                   harness (those two orgs); org:NAME; org:none. Add +P0..+P3 or
                   +none for a priority, e.g. composefs+P0. A bare P0 means all+P0.
  -h, --help       this text

The token comes from $GH_TOKEN, else $GITHUB_TOKEN, else
\`gh auth token --hostname github.com\`.
It needs read access to public repositories and read:project for the board.
Nothing is written: only GET requests are sent, to api.github.com.
`;

export interface Options {
  format?: "json" | "text";
  filter: QueueFilter;
  help: boolean;
}

export class UsageError extends Error {
  override name = "UsageError";
}

/** A filter token as the CLI takes it: the app's, or a bare priority for all+P. */
export function parseFilterArg(arg: string): QueueFilter {
  // Priorities in any case, as org names are.
  const bare = arg.replace(/(^|\+)p([0-9])$/, "$1P$2");
  const token = /^(P[0-9]|none)$/.test(bare) ? `all+${bare}` : bare;
  const f = parseFilterToken(token);
  if (!f) throw new UsageError(`unknown filter ${JSON.stringify(arg)}; try all, composefs, infra, org:NAME, with an optional +P0`);
  return f;
}

export function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { filter: ALL, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const [flag, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    switch (flag) {
      case "--json":
      case "--text":
        if (opts.format && opts.format !== flag.slice(2)) throw new UsageError("--json and --text are exclusive");
        opts.format = flag === "--json" ? "json" : "text";
        break;
      case "--filter": {
        const v = inline ?? argv[++i];
        if (v === undefined) throw new UsageError("--filter needs a value");
        opts.filter = parseFilterArg(v);
        break;
      }
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        throw new UsageError(`unknown argument ${JSON.stringify(a)}`);
    }
  }
  return opts;
}

/** A fetch that sends only GETs, so no code path can write. */
export function readOnly(f: Fetch): Fetch {
  return (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") return Promise.reject(new Error(`${PROG} is read-only; refusing ${method} ${input}`));
    return f(input, init);
  };
}

export type TokenSource = () => Promise<string>;

/** What a token may contain: printable ASCII, no spaces. Anything else would break the header. */
const TOKEN_RE = /^[\x21-\x7e]+$/;

/** The token, if it can go in a header; the error never quotes it. */
function checkToken(token: string, source: string): string {
  if (!TOKEN_RE.test(token)) throw new Error(`the token from ${source} isn't one: it holds spaces, control or non-ASCII characters`);
  return token;
}

/**
 * $GH_TOKEN, else $GITHUB_TOKEN, else `gh auth token` for github.com,
 * checked before it goes anywhere, since fetch quotes a bad header value
 * in its error.
 */
export function tokenFrom(env: Readonly<Record<string, string | undefined>>, gh: () => Promise<string> = ghAuthToken): TokenSource {
  let cached: Promise<string> | undefined;
  return () => {
    cached ??= (async () => {
      for (const name of TOKEN_ENV) {
        const v = env[name]?.trim();
        if (v) return checkToken(v, `$${name}`);
      }
      return checkToken(await gh(), "`gh auth token`");
    })();
    return cached;
  };
}

async function ghAuthToken(): Promise<string> {
  try {
    // github.com's token even when GH_HOST names an Enterprise server: it only goes to api.github.com.
    const { stdout } = await promisify(execFile)("gh", ["auth", "token", "--hostname", GITHUB_HOST], { timeout: 10_000 });
    const t = stdout.trim();
    if (!t) throw new Error("it printed nothing");
    return t;
  } catch (e) {
    const why = (e as NodeJS.ErrnoException).code === "ENOENT" ? "gh isn't installed" : e instanceof Error ? e.message.split("\n")[0] : String(e);
    throw new Error(`no token: set GH_TOKEN, or log in with \`gh auth login\` (\`gh auth token\` failed: ${why})`);
  }
}

export interface Io {
  fetch: Fetch;
  token: TokenSource;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  isTty: boolean;
  now: () => Date;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Where to look when the token is refused: the app says "sign in again". */
const TOKEN_HINT = "check $GH_TOKEN/$GITHUB_TOKEN, or `gh auth status`; the token needs read:project for the board";

/** A warning when a filter names an org no entry has, so a typo doesn't read as an empty queue. */
export function unknownOrgWarning(entries: readonly Entry[], f: QueueFilter): string | undefined {
  if (typeof f.scope === "string") return undefined;
  const orgs = new Set(entries.map((e) => entryOrg(e) ?? NO_ORG));
  if (orgs.has(f.scope.org)) return undefined;
  return `no entry targets org ${f.scope.org}; the queue has ${[...orgs].sort().join(", ") || "none"}`;
}

/**
 * Load and rank the queue as the app does. The board must be readable;
 * the forge and the answered asks only degrade the queue (as in the
 * app), and are reported as warnings.
 */
export async function loadEntries(gh: GitHub) {
  const warnings: string[] = [];
  const { items, linked } = await loadQueue(gh);
  let prs: ForgePr[] = [];
  let forgeKnown = false;
  const verdicts = new Map<string, Verdict>();
  // A forge PR he sent back is his again once the bot replied: without
  // this, every change request would read as his to review.
  const replied = new Set<string>();
  let others: WaitingPr[] = [];
  // One search of the bot's PRs serves both lists, as in the app; each
  // list then fails on its own, so a forge review that can't be read
  // doesn't hide the upstream PRs waiting on him.
  const all = searchBotPrs(gh);
  all.catch(() => {});
  try {
    prs = await loadForgePrs(gh, await all);
    forgeKnown = true;
    for (const [k, v] of await refreshVerdicts(gh, prs, new Map())) {
      verdicts.set(k, v.verdict);
      if (v.botReplied) replied.add(k);
    }
  } catch (e) {
    warnings.push(`couldn't read the forge's PRs or their reviews: ${message(e)}`);
  }
  try {
    const waiting = await loadWaiting(gh, await loadOtherPrs(gh, await all));
    others = waiting.prs;
    for (const err of waiting.errors) warnings.push(`couldn't read one of the bot's other PRs: ${err}`);
  } catch (e) {
    warnings.push(`couldn't read the bot's other PRs: ${message(e)}`);
  }
  const answered = await loadAnswered(gh, items);
  return { entries: buildEntries(items, prs, verdicts, forgeKnown, answered, { others, replied, linked }), warnings };
}

/** Run the CLI; the exit status: 0, 1 on failure, 2 on a usage error. */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  let opts: Options;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    io.stderr(`${PROG}: ${message(e)}\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    io.stdout(USAGE);
    return 0;
  }
  try {
    const gh = new GitHub(io.token, readOnly(io.fetch));
    const { entries, warnings } = await loadEntries(gh);
    const orgWarning = unknownOrgWarning(entries, opts.filter);
    if (orgWarning) warnings.push(orgWarning);
    const now = io.now();
    const doc = queueJson(applyFilter(entries, opts.filter), opts.filter, now, warnings);
    const format = opts.format ?? (io.isTty ? "text" : "json");
    io.stdout(format === "json" ? `${JSON.stringify(doc, null, 2)}\n` : queueText(doc, now));
    if (format === "json") for (const w of warnings) io.stderr(`${PROG}: warning: ${w}\n`);
    return 0;
  } catch (e) {
    // The client's 401 message is the app's ("sign in again"); say what to check here instead.
    const text = e instanceof GitHubError && e.status === 401 ? `GitHub refused the token (HTTP 401); ${TOKEN_HINT}` : message(e);
    io.stderr(`${PROG}: ${text}\n`);
    return 1;
  }
}
