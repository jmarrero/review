// Live agents, straight from the GitHub Actions API: the runs in flight of
// each agent workflow (LIVE_SOURCES), read with conditional requests, so
// what is running shows even when the pass's publication is missing or
// stale. The run-name carries the kind, item and pool (tracker's
// dispatch.yml: `KIND OWNER/REPO#N[ HEAD] (POOL)`, agent.yml adds the
// cores after the pool); a title that doesn't parse still lists its run.
// The pass view, where there is one, only fills in what a title lacks.
// The one write is Cancel, by OPERATOR, on a run read fresh first.

import { GitHubError, type GitHub } from "./api.ts";
import { checkViewer, write } from "./agentruns.ts";
import { AGENT_WORKFLOW, DEVSPACE_REPO, TRACKER_REPO } from "./config.ts";
import { h } from "../dom.ts";
import type { PassView } from "./passview.ts";
import { ageLabel, agoLabel } from "./view.ts";

/** A workflow whose runs are agent runs, one per item. */
export interface LiveSource { repository: string; workflow: string }

/** Every harness the pass or the operator dispatches agents through. Add one here to list its runs. */
export const LIVE_SOURCES: readonly LiveSource[] = [
  { repository: TRACKER_REPO, workflow: "dispatch.yml" },
  { repository: DEVSPACE_REPO, workflow: AGENT_WORKFLOW },
];

export const LIVE_POLL_MS = 60_000;
/**
 * The statuses listed, each with its own conditional read (the API filters
 * by one): `pending` is a second dispatch of an item behind dispatch.yml's
 * per-item concurrency group. `waiting` (an environment's reviewers) is
 * not listed, as no agent workflow's environment has any.
 */
const LISTED_STATUSES = ["in_progress", "queued", "pending"] as const;
/** Every status of a run not yet finished, which Cancel accepts. */
const UNFINISHED = ["in_progress", "queued", "waiting", "pending", "requested"];
const PAGE_SIZE = 100;
// GitHub can leave un-cancellable records in_progress indefinitely. No agent
// job can run beyond six hours; don't present those records as live work.
const MAX_RUN_AGE_MS = 6 * 60 * 60 * 1000;

export interface LiveRun {
  /** OWNER/REPO#N, from the run-name; null where it doesn't parse. */
  item: string | null;
  kind: string | null;
  pool: string | null;
  /** The run-name as GitHub shows it, for a run whose name doesn't parse. */
  title: string;
  status: string;
  /** When it started running, or was created while queued. */
  startedAt: string;
  run: { repository: string; id: number };
  source: LiveSource;
  /** The pass view lists it running. */
  listed: boolean;
}

export interface LiveRuns {
  /** When they were read, epoch ms. */
  at: number;
  runs: LiveRun[];
  /** Why a source could not be read whole; its runs may be missing. */
  errors: string[];
}

interface RawLiveRun {
  id?: number;
  display_title?: string;
  status?: string | null;
  created_at?: string;
  run_started_at?: string | null;
  path?: string;
  html_url?: string;
  repository?: { full_name?: string };
}

const SEGMENT = "[A-Za-z0-9_.-]+";
const RUN_NAME_RE = new RegExp(`^([a-z][a-z-]{0,31}) (${SEGMENT}/${SEGMENT})#([1-9]\\d{0,9})(?: [0-9a-f]{7,40})?(?: \\(([a-z0-9][a-z0-9_-]{0,31})(?:,[^)]*)?\\))?(?: \\[[^\\]]*\\])?$`);

/** The kind, item and pool a run-name names, or undefined where it isn't one of the harness's. */
export function parseRunName(title: string): { kind: string; item: string; pool: string | null } | undefined {
  const m = RUN_NAME_RE.exec(title.trim());
  if (!m || m[2]!.split("/").some((s) => s === "." || s === "..")) return undefined;
  return { kind: m[1]!, item: `${m[2]}#${m[3]}`, pool: m[4] ?? null };
}

const runsPath = (s: LiveSource, status: string) => `/repos/${s.repository}/actions/workflows/${s.workflow}/runs?status=${status}&per_page=${PAGE_SIZE}`;

/** The recent unfinished runs of every source; a source that fails is an error, not an empty list. */
export async function loadLiveRuns(gh: GitHub, sources: readonly LiveSource[] = LIVE_SOURCES, now = Date.now()): Promise<LiveRuns> {
  const errors: string[] = [];
  const byRun = new Map<string, LiveRun>();
  await Promise.all(sources.flatMap((source) => LISTED_STATUSES.map(async (status) => {
    try {
      const { data } = await gh.get<{ workflow_runs?: RawLiveRun[] } | null>(runsPath(source, status));
      if (!Array.isArray(data?.workflow_runs)) throw new Error("invalid workflow runs response");
      const runs = data.workflow_runs;
      // total_count and the returned status-filtered list can disagree, even
      // on a short page. Only a full page reaches this reader's request bound.
      if (runs.length >= PAGE_SIZE) errors.push(`${source.repository} ${source.workflow}: first ${PAGE_SIZE} ${status} runs read; more may exist`);
      for (const raw of runs) {
        if (!Number.isSafeInteger(raw.id) || (raw.repository?.full_name ?? source.repository).toLowerCase() !== source.repository.toLowerCase()) continue;
        const startedAt = raw.run_started_at ?? raw.created_at ?? "";
        if (now - Date.parse(startedAt) > MAX_RUN_AGE_MS) continue;
        const title = (raw.display_title ?? "").trim() || `run ${raw.id}`;
        const named = parseRunName(title);
        const key = `${source.repository.toLowerCase()}/${raw.id}`;
        // Two status lists can both catch a run moving between them; keep the further along.
        const prior = byRun.get(key);
        if (prior && prior.status === "in_progress") continue;
        byRun.set(key, {
          item: named?.item ?? null, kind: named?.kind ?? null, pool: named?.pool ?? null, title,
          status: raw.status ?? status,
          startedAt,
          run: { repository: source.repository, id: raw.id! },
          source, listed: false,
        });
      }
    } catch (e) {
      const why = e instanceof GitHubError && e.status === 404 ? "workflow missing or not readable with this token" : e instanceof Error ? e.message : String(e);
      errors.push(`${source.repository} ${source.workflow} (${status}): ${why}`);
    }
  })));
  const runs = [...byRun.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.run.id - b.run.id);
  return { at: now, runs, errors: [...new Set(errors)].sort() };
}

/** The runs, with what the pass view says of each filled in: its pool where the title has none, and that it lists it. */
export function enrich(runs: readonly LiveRun[], view: PassView | undefined): LiveRun[] {
  if (!view) return [...runs];
  const flights = new Map(view.in_flight.flatMap((f) => (f.state === "running" ? [[`${f.run.repository.toLowerCase()}/${f.run.id}`, f] as const] : [])));
  return runs.map((r) => {
    const f = flights.get(`${r.run.repository.toLowerCase()}/${r.run.id}`);
    return f ? { ...r, listed: true, item: r.item ?? f.item, kind: r.kind ?? f.kind, pool: r.pool ?? f.pool } : r;
  });
}

/** Cancel a live run, read fresh: refused unless it is still unfinished and a run of the source it was listed from. */
export async function cancelLiveRun(gh: GitHub, r: LiveRun): Promise<string> {
  const { repository, workflow } = r.source;
  const url = `https://github.com/${repository}/actions/runs/${r.run.id}`;
  if (!LIVE_SOURCES.some((s) => s.repository === repository && s.workflow === workflow) || r.run.repository !== repository) throw new Error(`not cancelling ${url}: not a run of an agent workflow`);
  await checkViewer(gh, "cancelling", [{ any: ["repo"], why: "cancelling" }]);
  const raw = await gh.send<RawLiveRun>("GET", `/repos/${repository}/actions/runs/${r.run.id}`);
  const problem = raw.id !== r.run.id || raw.repository?.full_name?.toLowerCase() !== repository.toLowerCase() ? "GitHub returned a different run"
    : raw.path?.split("@")[0] !== `.github/workflows/${workflow}` ? `it is a run of ${raw.path ?? "an unknown workflow"}, not ${workflow}`
    : !UNFINISHED.includes(raw.status ?? "") ? `the run already finished (${raw.status ?? "unknown"})`
    : undefined;
  if (problem) throw new Error(`not cancelling ${url}: ${problem}`);
  // A lost answer or a 5xx may still have cancelled it: that is Uncertain, not Not sent.
  await write(gh, "POST", `/repos/${repository}/actions/runs/${r.run.id}/cancel`, `cancelling ${url}`);
  return url;
}

const itemHref = (item: string) => `https://github.com/${item.replace("#", "/issues/")}`;
const runHref = (r: LiveRun) => `https://github.com/${r.run.repository}/actions/runs/${r.run.id}`;

/** One row: the item and kind, then pool, elapsed time, the run and Cancel. */
function row(r: LiveRun, now: number, cancel?: (r: LiveRun) => HTMLElement): HTMLElement {
  const head = r.item
    ? [h("a", { class: "live-item", href: itemHref(r.item) }, r.item), r.kind ? h("span", { class: "chip" }, r.kind) : ""]
    : [h("span", { class: "live-item" }, r.title)];
  const elapsed = ageLabel(r.startedAt || undefined, now);
  const meta = [
    r.pool ? h("span", { class: "chip pool" }, r.pool) : h("span", { class: "chip pool unknown" }, "pool ?"),
    r.status === "in_progress" ? h("span", {}, "running ", elapsed) : h("span", { class: "warn" }, `${r.status.replace("_", " ")} `, elapsed),
    h("a", { href: runHref(r) }, `run ${r.run.id}`),
  ];
  return h("li", { class: "live-run" },
    h("div", { class: "live-head" }, ...head),
    h("div", { class: "live-meta" }, ...meta, cancel ? cancel(r) : ""));
}

/** The Live agents list: every unfinished agent run, oldest first, whether or not the pass view is published. */
export function liveAgentsView(data: LiveRuns | undefined, view: PassView | undefined, now = Date.now(), cancel?: (r: LiveRun) => HTMLElement): HTMLElement {
  const el = h("div", { class: "live-agents" });
  if (!data) {
    el.append(h("h3", {}, "Live agents"), h("p", { class: "note" }, "Reading the agent workflows' runs…"));
    return el;
  }
  const runs = enrich(data.runs, view);
  const running = runs.filter((r) => r.status === "in_progress").length;
  el.append(h("h3", {}, "Live agents ", h("span", { class: "count" }, String(runs.length))));
  const queued = runs.length - running;
  el.append(h("p", { class: "note" }, `${running} running${queued ? `, ${queued} queued or waiting` : ""} · from ${LIVE_SOURCES.map((s) => `${s.repository.split("/")[1]} ${s.workflow}`).join(", ")} · read `, Number.isFinite(data.at) ? agoLabel(new Date(data.at).toISOString(), now) : "unknown"));
  for (const e of data.errors) el.append(h("p", { class: "warn" }, `Incomplete: ${e}`));
  el.append(runs.length ? h("ul", { class: "live-runs" }, ...runs.map((r) => row(r, now, cancel))) : h("p", {}, data.errors.length ? "No runs read; see above." : "No agent runs in flight."));
  return el;
}
