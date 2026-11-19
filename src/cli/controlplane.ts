// control-app: the app's state on the command line, for the controller.
// The read commands use the app's loaders and derivations: the pass's
// published holds snapshot (Home's Needs you, Act now, Live agents and capacity,
// Status's repository board) and review-queue's queue. Each prints one
// JSON document whose order is the publication's, with links.
// The read commands' client refuses anything but GET.
//
// The act commands call the functions behind the app's buttons (Live
// agents' Cancel, Retry and Redispatch, Status's Run a pass, the capture
// bar's File), so they make the same checks and writes. A write is sent
// only with --yes: a command run to see what it would do can't act. With
// --dry-run the same code runs, its reads are sent and its writes are
// recorded instead, each answered with an empty success. Only cancel, retry
// and redispatch need the pass view, for its list of runs: dispatch checks
// the item isn't running only where there is one, and run-pass skips the
// view's capacity checks, which are the caller's to judge from status.

import { type Fetch, GitHub, GitHubError } from "../github/api.ts";
import { actNowRows, mergeRefusal } from "../github/actnow.ts";
import { cancelRun, dispatchItem, redispatch, retryRun } from "../github/agentruns.ts";
import { parseRunUrl } from "../github/asks.ts";
import { captureRequest, fileCapture } from "../github/capture.ts";
import { TRACKER_REPO } from "../github/config.ts";
import { type Holds, loadPassPublications } from "../github/holds.ts";
import { askUrl, type Card, firstPublished, inboxCards, inboxCounts, publishedNote } from "../github/inbox.ts";
import type { ApproveItem } from "../github/maintain.ts";
import { enrich, LIVE_SOURCES, type LiveRun, type LiveRuns, loadLiveRuns } from "../github/liveruns.ts";
import { redactAddresses, stale } from "../github/passes.ts";
import type { AgentRun, PassView } from "../github/passview.ts";
import { startPass } from "../github/runpass.ts";
import { readService, readServiceState, repositorySection, sectionTrusted, serviceProblem, type ServiceDecision } from "../github/service.ts";
import { type Io, readOnly, run as runQueue } from "./queue.ts";

export const PROG = "control-app";
// Keep the wire schema stable for existing callers of either command name.
const SCHEMA = "control-plane/v1";
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;
const ITEM_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}#[1-9]\d{0,9}$/;
const POLL_RUNS_URL = `https://github.com/${TRACKER_REPO}/actions/workflows/poll.yml`;
/** At most this many of the duplicate search's other matches are shown. */
const MAX_SIMILAR = 10;

export const USAGE = `Usage: ${PROG} COMMAND [ARGS]

Read the control app's state as it shows it in the browser, as JSON.
The old command name control-plane remains an alias for one release.

  status               the agent runs in flight (from the Actions API, so even
                       without a publication), then capacity (pools, WIP) and
                       the last passes with their starts and no-start reasons
  needs-you            Home's Needs you cards in its order, with how current
                       and complete the pass's list is
  act-now              the pass's Act now shortlist, as Home shows it
  queue [ARGS]         the review queue; ARGS as for review-queue (--help)
  repo OWNER/REPO      the pass's dispatchable work, live runs and asks on a repository;
                       from a service, also its bot PRs and waiting items
  changes --since TIME passes, starts and new asks since an ISO time
  -h, --help           this text

Act as the app's buttons do. Each needs --dry-run (send the reads, show the
writes) or --yes (send them):

  dispatch OWNER/REPO#N --kind KIND [--pool POOL] --brief TEXT
                       comment a job plan on the item for the next pass to
                       start, unless the pass view (if published) lists it running
  cancel RUN           cancel a run the pass view lists as running
  retry RUN            rerun a listed run's failed jobs
  redispatch RUN       repeat the newest plan of a listed run's failed item
  run-pass             start an applying pass (poll.yml) unless one is active;
                       it doesn't check capacity, as the app's button does
  file --epic N --title TEXT [--body TEXT] [--repo OWNER/REPO] [--label NAME]...
                       file a tracker issue under an epic, unless an open one
                       has the same title

RUN is a run's URL or ID. The token comes from $GH_TOKEN, else $GITHUB_TOKEN,
else \`gh auth token --hostname github.com\`. The read commands send only GET
requests.
Set CONTROL_APP_SERVICE to a private service's HTTP(S) base URL to read its
decision generation instead, without a GitHub token (repo reports its PRs and
waiting items even without a decision). Failures never fall back
to GitHub decision reads. Queue and act commands retain their existing policy.
`;

class UsageError extends Error {
  override name = "UsageError";
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const itemUrl = (item: string) => `https://github.com/${item.replace("#", "/issues/")}`;

const runUrl = (r: { repository: string; id: number }) => `https://github.com/${r.repository}/actions/runs/${r.id}`;

/** The snapshot's part a command needs, or an error naming why it can't be used. */
function part<T>(value: T | string | undefined, what: string): T {
  if (value === undefined) throw new Error(`the pass's snapshot has no ${what}`);
  if (typeof value === "string") throw new Error(`the pass's ${what} can't be used: ${value}`);
  return value;
}

async function loadHolds(gh: GitHub): Promise<Holds> {
  const { holds, uncertain } = await loadPassPublications(gh);
  if (!holds) throw new Error(uncertain ?? "the pass has published no hold snapshot");
  return holds;
}

type Pass = PassView["passes"][number];

function passJson(p: Pass) {
  return {
    at: p.at,
    result: p.result,
    sections: p.sections.map((s) => ({ name: s.name, result: s.result, error: s.error === null ? null : redactAddresses(s.error) })),
    started: p.started.map((s) => ({ item: s.item, kind: s.kind, pool: s.pool, url: itemUrl(s.item), run: runUrl(s.run) })),
    noStart: p.reasons.map((r) => ({ item: r.item, kind: r.kind, reason: redactAddresses(r.reason), until: r.until })),
    omitted: p.omitted,
  };
}

function flightJson(f: PassView["in_flight"][number]) {
  return f.state === "running"
    ? { state: f.state, item: f.item, kind: f.kind, pool: f.pool, startedAt: f.started_at ?? null, url: itemUrl(f.item), run: runUrl(f.run) }
    : { state: f.state, item: `${f.repository}#${f.number}`, url: `https://github.com/${f.repository}/pull/${f.number}` };
}

/** What every document says of the publication it read. */
function observed(view: PassView, now: number) {
  return { observedAt: view.observed_at, stale: stale(view.observed_at, now), complete: view.complete, omitted: view.omitted };
}

/** An agent run in flight, as the Actions API lists it (Home's Live agents). */
function agentJson(r: LiveRun) {
  return { item: r.item, kind: r.kind, pool: r.pool, status: r.status, startedAt: r.startedAt || null, title: r.title, listedByPass: r.listed, url: r.item ? itemUrl(r.item) : null, run: runUrl(r.run) };
}

/**
 * The agents in flight from the Actions API, whatever the publication
 * says; then the snapshot's time and, where it has one, its pass view.
 * Without a usable pass view, its parts are null and passViewError says why.
 */
function status(h: Holds | string, live: LiveRuns, now: number) {
  const view = typeof h === "object" && typeof h.passView === "object" ? h.passView : undefined;
  const agents = { agents: enrich(live.runs, view).map(agentJson), agentsErrors: live.errors };
  if (typeof h === "string") return { ...agents, snapshotAt: null, passViewError: h, wip: null, live: null, pools: null, passes: null };
  const snapshot = { snapshotAt: h.at, snapshotStale: stale(h.at, now) };
  if (!view) {
    const passViewError = h.passView === undefined ? "the pass's snapshot has no pass view" : `the pass's pass view can't be used: ${h.passView}`;
    return { ...agents, ...snapshot, passViewError, wip: h.wip ?? null, live: null, pools: null, passes: null };
  }
  return {
    ...agents,
    ...snapshot,
    ...observed(view, now),
    wip: h.wip ?? null,
    live: view.in_flight.map(flightJson),
    pools: view.pools.map((p) => ({ name: p.name, usedPercent: p.used_percent, allowedPercent: p.allowed_percent, resetsAt: p.resets_at, ready: p.ready, underPace: p.under_pace })),
    passes: view.passes.map(passJson),
  };
}

function actNow(h: Holds, now: number) {
  const list = part(h.needsYou, "needs-you list");
  // As Home reads it: a list just confirmed; actNowRows applies its own age bound.
  const rows = actNowRows({ list, asks: list.items, unavailable: false, checkedAt: now }, now);
  return {
    validatedAt: list.validatedAt,
    complete: list.complete,
    rows: rows.map(({ ask: a, unblocks, fallback }) => ({
      key: a.key, item: a.item, kind: a.kind, priority: a.priority, waitingSince: a.waitingSince, ask: a.ask, unblocks, fallback: fallback ?? false,
      action: a.action, url: askUrl(a.action), mergeRefusal: mergeRefusal(a) ?? null,
    })),
  };
}

/** One Needs you card; the pass's cards are an ask's or the digest's group. */
function cardJson(c: Card) {
  const base = { key: c.key, kind: c.kind, title: c.title, where: c.where, url: c.url ?? null, since: c.since ?? null, priority: c.priority ?? null, note: c.note ?? null, unavailable: c.unavailable ?? false };
  if ("ask" in c) return { ...base, item: c.ask.item, source: c.ask.source, askKind: c.ask.kind, recommendation: c.ask.recommendation, detailMissing: c.ask.detailMissing ?? false };
  if (c.kind !== "digest") return base;
  const pr = (i: ApproveItem) => `${i.pr.owner}/${i.pr.repo}`;
  return { ...base, items: c.items.map((i) => ({ item: `${pr(i)}#${i.pr.number}`, head: i.head, reason: i.reason, url: `https://github.com/${pr(i)}/pull/${i.pr.number}` })) };
}

/**
 * Needs you as Home shows it on a first read, from the same derivation:
 * the list's cards in its order, else the snapshot's own operator holds
 * and listError saying why there is no list. The read is GitHub's answer
 * just now by default; service reads label receipt separately from validation.
 */
function needsYou(h: Holds, now: number, source: "github" | "service" = "github") {
  const published = firstPublished(h, now);
  const l = published.list;
  const { text, settled } = publishedNote(published, now, source);
  const { known, listed, unlisted } = inboxCounts(published);
  return {
    snapshotAt: h.at,
    snapshotStale: stale(h.at, now),
    listError: published.error ?? null,
    validatedAt: l?.validatedAt ?? null,
    changedAt: l?.changedAt ?? null,
    complete: l?.complete ?? null,
    note: text,
    settled,
    counts: { known, listed, unlisted },
    cards: inboxCards({ published }).map(cardJson),
  };
}

function serviceNeedsYou(d: ServiceDecision, now: number, problem: string | undefined) {
  const body = needsYou(d.holds, now, "service");
  // Service availability and coverage supplement, not replace, list evidence.
  const notes = [problem, !d.complete ? "Service decision is incomplete; listed cards are partial evidence." : undefined, body.note];
  return { ...body, settled: body.settled && d.complete && !problem,
    ...(problem ? { unavailable: true } : {}), note: notes.filter(Boolean).join(" ") };
}

function repo(h: Holds, name: string, now: number) {
  const work = part(h.dispatchableWork, "dispatchable work");
  const lower = name.toLowerCase();
  const [repository, entry] = Object.entries(work.repositories).find(([r]) => r.toLowerCase() === lower) ?? [name, undefined];
  const view = typeof h.passView === "object" ? h.passView : undefined;
  const list = typeof h.needsYou === "object" ? h.needsYou : undefined;
  const on = (item: string) => item.toLowerCase().startsWith(`${lower}#`);
  return {
    repository,
    // Absent from the publication: the pass has no record of it, not proof of no work.
    work: entry ? { ...entry, items: entry.items.map((i) => ({ ...i, url: itemUrl(i.item) })) } : null,
    live: view ? view.in_flight.map(flightJson).filter((f) => on(f.item)) : null,
    asks: list ? list.items.filter((a) => a.action.repository.toLowerCase() === lower).map((a) => ({ key: a.key, kind: a.kind, waitingSince: a.waitingSince, ask: a.ask, url: askUrl(a.action) })) : null,
    ...(view ? { pass: observed(view, now) } : {}),
  };
}

function changes(h: Holds, since: number, now: number) {
  const view = part(h.passView, "pass view");
  const list = typeof h.needsYou === "object" ? h.needsYou : undefined;
  const after = (iso: string) => Date.parse(iso) > since;
  return {
    since: new Date(since).toISOString(),
    ...observed(view, now),
    passes: view.passes.filter((p) => after(p.at)).map(passJson),
    // The pass view keeps only its last few passes: older ones are unknown here.
    passesCovered: view.passes.length > 0 && view.passes.some((p) => !after(p.at)),
    asks: list ? list.items.filter((a) => after(a.waitingSince)).map((a) => ({ key: a.key, kind: a.kind, waitingSince: a.waitingSince, ask: a.ask, url: askUrl(a.action) })) : null,
    ...(list ? { asksChangedAt: list.changedAt } : {}),
  };
}

/** The positional arguments a command takes, refusing anything else. */
function parse(command: string, args: readonly string[]): { repo?: string; since?: number } {
  if (command === "repo") {
    if (args.length !== 1 || !REPO_RE.test(args[0]!)) throw new UsageError("repo needs one OWNER/REPO");
    return { repo: args[0]! };
  }
  if (command === "changes") {
    const [flag, value, ...rest] = args[0]?.startsWith("--since=") ? ["--since", args[0].slice("--since=".length), ...args.slice(1)] : args;
    const since = Date.parse(value ?? "");
    if (flag !== "--since" || rest.length || !Number.isFinite(since)) throw new UsageError("changes needs --since ISO_TIME");
    return { since };
  }
  if (args.length) throw new UsageError(`${command} takes no arguments`);
  return {};
}

const COMMANDS = ["status", "needs-you", "act-now", "repo", "changes"] as const;

/** Each act command's flags that take a value; --label may repeat. */
const ACT_FLAGS = {
  dispatch: ["--kind", "--pool", "--brief"],
  cancel: [],
  retry: [],
  redispatch: [],
  "run-pass": [],
  file: ["--epic", "--title", "--body", "--repo", "--label"],
} as const satisfies Record<string, readonly string[]>;

type ActCommand = keyof typeof ACT_FLAGS;

interface Act {
  command: ActCommand;
  dryRun: boolean;
  target?: string;
  flags: Map<string, string[]>;
}

const isAct = (c: string | undefined): c is ActCommand => c !== undefined && Object.hasOwn(ACT_FLAGS, c);

function parseAct(command: ActCommand, args: readonly string[]): Act {
  const known: readonly string[] = ACT_FLAGS[command];
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  let dryRun = false;
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const flag = eq < 0 ? a : a.slice(0, eq);
    if (flag === "--dry-run" || flag === "--yes") {
      if (eq >= 0) throw new UsageError(`${flag} takes no value`);
      if (flag === "--dry-run") dryRun = true;
      else yes = true;
    } else if (known.includes(flag)) {
      const v = eq < 0 ? args[++i] : a.slice(eq + 1);
      if (v === undefined) throw new UsageError(`${flag} needs a value`);
      if (flags.has(flag) && flag !== "--label") throw new UsageError(`${flag} is given twice`);
      flags.set(flag, [...(flags.get(flag) ?? []), v]);
    } else if (a.startsWith("-")) {
      throw new UsageError(`${command} takes no ${a}`);
    } else positional.push(a);
  }
  if (dryRun === yes) throw new UsageError(`${command} needs one of --dry-run or --yes`);
  const one = (f: string) => flags.get(f)?.[0];
  const need = (f: string) => { if (one(f) === undefined) throw new UsageError(`${command} needs ${f}`); };
  if (command === "dispatch") {
    if (positional.length !== 1 || !ITEM_RE.test(positional[0]!)) throw new UsageError("dispatch needs one OWNER/REPO#N");
    need("--kind");
    need("--brief");
  } else if (command === "file") {
    if (positional.length) throw new UsageError("file takes no positional arguments");
    need("--title");
    if (!/^[1-9]\d{0,9}$/.test(one("--epic") ?? "")) throw new UsageError("file needs --epic N, a tracker issue number");
  } else if (command === "run-pass") {
    if (positional.length) throw new UsageError("run-pass takes no arguments");
  } else if (positional.length !== 1 || !(parseRunUrl(positional[0]!) || /^[1-9]\d{0,15}$/.test(positional[0]!))) {
    throw new UsageError(`${command} needs one RUN, a workflow run's URL or ID`);
  }
  return { command, dryRun, flags, ...(positional[0] === undefined ? {} : { target: positional[0] }) };
}

interface Write {
  method: string;
  url: string;
  body?: unknown;
}

/** A fetch that sends reads (GETs and GraphQL queries) and records every write, sending it only when `send`. */
function recording(f: Fetch, send: boolean, writes: Write[]): Fetch {
  return (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;
    try { body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
    const query = new URL(input).pathname === "/graphql" ? (body as { query?: unknown } | undefined)?.query : undefined;
    if (method === "GET" || (typeof query === "string" && /^\s*query\b/.test(query))) return f(input, init);
    writes.push({ method, url: input, ...(body === undefined ? {} : { body }) });
    return send ? f(input, init) : Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  };
}

/** The run the pass view lists (running, or started by a recent pass) by URL or ID; refused if none or more than one. */
function listedRun(view: PassView, target: string): AgentRun {
  const ref = parseRunUrl(target);
  const id = ref?.id ?? target;
  const repository = ref && `${ref.owner}/${ref.repo}`.toLowerCase();
  const runs = [...view.in_flight.flatMap((f) => (f.state === "running" ? [f] : [])), ...view.passes.flatMap((p) => p.started)]
    .filter((r) => String(r.run.id) === id && (!repository || r.run.repository.toLowerCase() === repository));
  const distinct = [...new Map(runs.map((r) => [`${r.item.toLowerCase()} ${r.kind} ${r.run.repository.toLowerCase()}`, r])).values()];
  if (!distinct.length) throw new Error(`the pass view lists no run ${target}`);
  if (distinct.length > 1) throw new Error(`the pass view lists ${distinct.length} runs with ID ${id}; give its URL`);
  return distinct[0]!;
}

/** Make an act command's checks and writes; what it acted on, for the document. */
async function act(gh: GitHub, a: Act) {
  const one = (f: string) => a.flags.get(f)?.[0];
  if (a.command === "file") {
    const repo = one("--repo");
    const draft = { title: one("--title")!, body: one("--body") ?? "", url: "", epic: Number(one("--epic")), labels: a.flags.get("--label") ?? [], ...(repo === undefined ? {} : { repo }) };
    const { title } = captureRequest(draft);
    // The search index lags new issues by a minute or so; the exact-title refusal is a guard, not a lock.
    const q = `repo:${TRACKER_REPO} is:issue is:open in:title "${title.replaceAll('"', " ")}"`;
    const found = await gh.send<{ items?: { title: string; html_url: string }[] }>("GET", `/search/issues?q=${encodeURIComponent(q)}&per_page=${MAX_SIMILAR + 1}`);
    const items = found.items ?? [];
    const same = items.filter((i) => i.title.trim().toLowerCase() === title.toLowerCase());
    if (same.length) throw new Error(`not filing: ${same.map((i) => i.html_url).join(", ")} is open with this title`);
    const similar = items.slice(0, MAX_SIMILAR).map((i) => ({ title: i.title, url: i.html_url }));
    const filed = await fileCapture(gh, draft);
    return { similar, url: filed.url ?? null, ...(filed.parentError ? { parentError: filed.parentError } : {}), ...(filed.boardError ? { boardError: filed.boardError } : {}) };
  }
  if (a.command === "run-pass") {
    const id = await startPass(gh);
    return { url: id === undefined ? POLL_RUNS_URL : `https://github.com/${TRACKER_REPO}/actions/runs/${id}` };
  }
  if (a.command === "dispatch") {
    const { holds } = await loadPassPublications(gh);
    const view = typeof holds?.passView === "object" ? holds.passView : undefined;
    const pool = one("--pool");
    const url = await dispatchItem(gh, view, { item: a.target!, kind: one("--kind")!, brief: one("--brief")!, ...(pool === undefined ? {} : { pool }) });
    // Without a pass view nothing says whether the item is running; the next pass's own checks still hold.
    return { url, runningChecked: view !== undefined };
  }
  const view = part((await loadHolds(gh)).passView, "pass view");
  const r = listedRun(view, a.target!);
  const fn = { cancel: cancelRun, retry: retryRun, redispatch }[a.command];
  return { item: r.item, kind: r.kind, run: runUrl(r.run), url: await fn(gh, view, r) };
}

/** Run the CLI; the exit status: 0, 1 on failure, 2 on a usage error. */
export async function run(argv: readonly string[], io: Io & { serviceUrl?: string | undefined }): Promise<number> {
  const [command, ...args] = argv;
  if (command === "queue") return runQueue(args, io);
  if (command === "-h" || command === "--help") {
    io.stdout(USAGE);
    return 0;
  }
  let opts: ReturnType<typeof parse> | Act;
  try {
    if (isAct(command)) opts = parseAct(command, args);
    else if (!COMMANDS.includes(command as (typeof COMMANDS)[number])) throw new UsageError(command ? `unknown command ${JSON.stringify(command)}` : "a command is needed");
    else opts = parse(command!, args);
  } catch (e) {
    io.stderr(`${PROG}: ${message(e)}\n${USAGE}`);
    return 2;
  }
  try {
    const now = io.now().getTime();
    const head = { schema: SCHEMA, command, generatedAt: new Date(now).toISOString() };
    if ("dryRun" in opts) {
      const writes: Write[] = [];
      const done = await act(new GitHub(io.token, recording(io.fetch, !opts.dryRun, writes)), opts);
      // A dry run's writes all get empty answers, so a link only a write returns (a filed issue's) is null.
      const body = opts.dryRun ? { dryRun: true, ...done, wouldSend: writes } : { dryRun: false, ...done, sent: writes.map(({ method, url }) => ({ method, url })) };
      io.stdout(`${JSON.stringify({ ...head, ...body }, null, 2)}\n`);
      return 0;
    }
    if (io.serviceUrl && command === "repo") {
      // The decision section is optional on the service; PRs and waiting
      // items are independent sections of the same generation.
      const s = await readServiceState(io.serviceUrl, io.fetch);
      const d = s.decision;
      const problem = d ? serviceProblem(d, now) : s.decisionError;
      const name = opts.repo!;
      io.stdout(`${JSON.stringify({ ...head, source: "service", generation: s.generation, unavailable: problem ?? null,
        ...(d ? repo(d.holds, name, now) : { repository: name, work: null, live: null, asks: null }),
        prs: repositorySection(s.prs, s.prsError, name, now), waiting: repositorySection(s.waiting, s.waitingError, name, now),
        // Whole only if the decision and both lists are complete, current reads.
        complete: !!d && d.complete && !problem && [s.prs, s.waiting].every((x) => !!x && sectionTrusted(x, now)) }, null, 2)}\n`);
      return 0;
    }
    if (io.serviceUrl) {
      const d = await readService(io.serviceUrl, io.fetch, now);
      const problem = serviceProblem(d, now);
      const holds = d.holds;
      const body = command === "status" ? { snapshotAt: holds.at, wip: holds.wip, candidates: d.candidates, pools: d.pools, holds: holds.holds, holdsOmitted: d.holdsOmitted, poolsOmitted: d.poolsOmitted, passes: null, live: null }
        : command === "needs-you" ? serviceNeedsYou(d, now, problem)
          : command === "act-now" ? (problem ? { rows: [], unavailable: problem } : actNow(holds, now))
            : { since: new Date(opts.since!).toISOString(), passes: null, asks: null, error: "Service decision contract does not supply pass history" };
      // A complete nested list cannot certify the enclosing preview's coverage.
      // Keep its own coverage visible without letting the body overwrite ours.
      const listCommand = command === "needs-you" || command === "act-now";
      const listComplete = typeof holds.needsYou === "object" ? holds.needsYou.complete : null;
      io.stdout(`${JSON.stringify({ ...head, source: "service", generation: d.generation, unavailable: problem ?? null, ...body,
        ...(listCommand ? { listComplete } : {}), complete: d.complete && (!listCommand || listComplete === true) }, null, 2)}\n`);
      return 0;
    }
    const gh = new GitHub(io.token, readOnly(io.fetch));
    if (command === "status") {
      // Live agents come from the Actions API: status answers even without a publication.
      const [holds, live] = await Promise.all([loadHolds(gh).catch((e: unknown) => message(e)), loadLiveRuns(gh, LIVE_SOURCES, now)]);
      io.stdout(`${JSON.stringify({ ...head, ...status(holds, live, now) }, null, 2)}\n`);
      return 0;
    }
    const holds = await loadHolds(gh);
    const body = command === "needs-you" ? needsYou(holds, now)
      : command === "act-now" ? actNow(holds, now)
        : command === "repo" ? repo(holds, opts.repo!, now)
          : changes(holds, opts.since!, now);
    io.stdout(`${JSON.stringify({ ...head, ...body }, null, 2)}\n`);
    return 0;
  } catch (e) {
    const text = e instanceof GitHubError && e.status === 401 ? "GitHub refused the token (HTTP 401); check $GH_TOKEN/$GITHUB_TOKEN, or `gh auth status`" : message(e);
    io.stderr(`${PROG}: ${text}\n`);
    return 1;
  }
}
