// Manual only. Never infer scheduler idleness from the work-in-flight list:
// it lists agents, not poll.yml. Fresh Actions reads stop duplicate applying
// passes; the workflow's concurrency group remains the final race guard.
import { h } from "../dom.ts";
import { GitHub, GitHubError, ReadOnlyError } from "./api.ts";
import { OPERATOR, TRACKER_REPO } from "./config.ts";
import { isObject } from "./heartbeat.ts";
import type { PassView } from "./passview.ts";

const WORKFLOW = "poll.yml";
const ROOT = `/repos/${TRACKER_REPO}`;
const WORKFLOW_PATH = `${ROOT}/actions/workflows/${WORKFLOW}`;
const WORKFLOW_URL = `https://github.com/${TRACKER_REPO}/actions/workflows/${WORKFLOW}`;
const CHECK_TTL = 60_000;

export interface PassFacts { data: PassView | string | undefined; unavailable?: string | undefined; login: string | undefined }
export interface PassControl { busy?: boolean; checkedAt?: number | undefined; message?: string; sent?: boolean; runId?: number; changed?: () => void }

export function passRefusal(facts: PassFacts, now = Date.now()): string | undefined {
  if (facts.login !== OPERATOR) return `Only ${OPERATOR} can run an applying pass here.`;
  const d = facts.data;
  if (facts.unavailable || !d || typeof d !== "object") return "Pass view unavailable; capacity and pass activity are unknown.";
  const age = now - Date.parse(d.observed_at);
  if (age < -60_000 || age > 3_600_000) return "Pass view stale or clock in the future; refresh before running a pass.";
  if (!d.complete || d.omitted) return "Pass view incomplete; refresh before running a pass.";
  if (!d.pools.some((p) => p.under_pace === true && p.resets_at !== null && Date.parse(p.resets_at) > now)) return "No pool with a current reset window is published under pace.";
  return undefined;
}

/** Status buckets in lifecycle order, `waiting` and `queued` read again after
 * `in_progress`. Given current reads, a run changing status once between two
 * reads is still in the earlier status at its read or the later one at its
 * read: for every transition into a started status (requested/pending →
 * waiting/queued ⇄ in_progress) some read of the source comes before a read
 * of the target.
 * Only total_count matters, so the check costs the same however long
 * completed history grows.
 */
export const ACTIVE_SWEEP = ["requested", "pending", "waiting", "queued", "in_progress", "waiting", "queued"] as const;

/** Status filters are served from a search index that can lag, so the
 * unfiltered list, which is current, is read last as a cross-check for runs
 * whose status changed too recently to be indexed. That includes a rerun,
 * which keeps its run ID and creation time and so can sit behind any number
 * of newer runs; GitHub only reruns runs created in the last 30 days, so the
 * cross-check pages back (newest first) until it passes that window, with a
 * day of margin for clock skew. Older runs are covered by the buckets. */
const RECENT_PAGE = 100;
const RERUN_WINDOW = 31 * 86_400_000;
/** About six weeks of runs every ten minutes; refuse rather than read more. */
export const MAX_RECENT_PAGES = 60;

function runList(data: unknown): unknown[] {
  if (!isObject(data) || !Number.isSafeInteger(data.total_count) || (data.total_count as number) < 0 || !Array.isArray(data.workflow_runs)) throw new Error("Pass activity unreadable; not evidence of idle.");
  return data.workflow_runs;
}

function created(run: unknown): number {
  const at = isObject(run) && typeof run.created_at === "string" ? Date.parse(run.created_at) : NaN;
  if (Number.isNaN(at)) throw new Error("Pass activity unreadable; not evidence of idle.");
  return at;
}

/** Sequential, only on demand. Never parallel: concurrent bucket reads lose
 * the ordering that keeps a queued-to-running run from escaping both. */
export async function checkPass(gh: GitHub): Promise<void> {
  const active = (status: string) => new Error(`A pass is active (${status}); wait for it to finish and check workflow runs.`);
  for (const status of ACTIVE_SWEEP) {
    const data = await gh.send<unknown>("GET", `${WORKFLOW_PATH}/runs?status=${status}&per_page=1`);
    if (runList(data).length > 0 || (data as { total_count: number }).total_count > 0) throw active(status);
  }
  const cutoff = Date.now() - RERUN_WINDOW;
  for (let page = 1; ; page++) {
    if (page > MAX_RECENT_PAGES) throw new Error(`More than ${MAX_RECENT_PAGES * RECENT_PAGE} ${WORKFLOW} runs in the rerun window; cannot exclude an active rerun.`);
    const data = await gh.send<unknown>("GET", `${WORKFLOW_PATH}/runs?per_page=${RECENT_PAGE}&page=${page}`);
    const runs = runList(data);
    if (runs.length < RECENT_PAGE && (page - 1) * RECENT_PAGE + runs.length < (data as { total_count: number }).total_count) throw new Error("Pass activity incomplete; cannot exclude an active rerun.");
    let older = false;
    for (const run of runs) {
      if (!isObject(run) || run.status !== "completed") throw active(isObject(run) && typeof run.status === "string" ? run.status : "unknown status");
      if (created(run) < cutoff) older = true;
    }
    if (older || runs.length < RECENT_PAGE) return;
  }
}

/** No retries: even a lost response can mean the applying pass was started. */
export async function dispatchPass(gh: GitHub, facts: () => PassFacts, attempting: () => void = () => {}): Promise<number | undefined> {
  const refuse = () => { const reason = passRefusal(facts()); if (reason) throw new Error(reason); };
  refuse();
  return startPass(gh, () => { refuse(); attempting(); });
}

/**
 * dispatchPass without the pass view's checks, for the control-app CLI,
 * whose caller judges capacity itself: still only the operator, with write
 * access, and never while a pass is active. `attempting` runs just before
 * the dispatch, and may refuse by throwing.
 */
export async function startPass(gh: GitHub, attempting: () => void = () => {}): Promise<number | undefined> {
  const viewer = await gh.send<{ login: string }>("GET", "/user");
  if (viewer.login !== OPERATOR) throw new Error(`Only ${OPERATOR} can run an applying pass here.`);
  const repo = await gh.send<{ default_branch: string; permissions?: { push?: boolean } }>("GET", ROOT);
  if (repo.permissions?.push !== true || typeof repo.default_branch !== "string" || !repo.default_branch) throw new Error("Running a pass requires repository write access and Actions read/write permission.");
  await checkPass(gh);
  attempting();
  const result = await gh.send<{ workflow_run_id?: unknown } | undefined>("POST", `${WORKFLOW_PATH}/dispatches`, { ref: repo.default_branch, inputs: { apply: "true" }, return_run_details: true });
  const id = result?.workflow_run_id;
  return Number.isSafeInteger(id) && (id as number) > 0 ? id as number : undefined;
}

export function runPassControl(gh: GitHub, facts: () => PassFacts, state: PassControl, confirm: () => boolean = () => window.confirm("Run an applying pass now? This can start agents and make the configured board and repository writes.")): HTMLElement {
  const el = h("div", { class: "run-pass-control" });
  const check = h("button", { type: "button" }, "Check pass availability");
  const run = h("button", { type: "button" }, "Run a pass now");
  const note = h("p", { class: "note", role: "status", "aria-live": "polite" });
  const receipt = h("a", { href: WORKFLOW_URL }, "View poll workflow runs");
  function paint() {
    const reason = passRefusal(facts());
    const checked = state.checkedAt !== undefined && Date.now() - state.checkedAt < CHECK_TTL && Date.now() >= state.checkedAt;
    check.disabled = !!reason || !!state.busy || !!state.sent;
    run.disabled = check.disabled || !checked;
    note.textContent = (!state.sent && reason) || state.message || "Check availability first. No Actions reads until requested; running or queued passes prevent dispatch.";
    if (state.runId) { receipt.href = `https://github.com/${TRACKER_REPO}/actions/runs/${state.runId}`; receipt.textContent = `View pass run ${state.runId}`; }
  }
  // A snapshot refresh replaces this element, not the in-flight operation.
  // Completion must notify the currently mounted control, not a detached one.
  state.changed = paint;
  check.onclick = async () => {
    if (check.disabled) return;
    state.busy = true; state.message = "Checking live pass activity…"; state.checkedAt = undefined; state.changed?.();
    try {
      await checkPass(gh);
      state.checkedAt = Date.now(); state.message = "No active pass found. Run a pass now rechecks before dispatch; Actions write permission is required.";
      const expiry = setTimeout(() => { if (!state.busy && !state.sent) { state.message = "Availability check expired; check again before dispatch."; state.changed?.(); } }, CHECK_TTL);
      expiry.unref?.();
    } catch (e) { state.message = `Cannot check pass availability: ${String(e)}`; }
    finally { state.busy = false; state.changed?.(); }
  };
  run.onclick = async () => {
    paint();
    if (run.disabled || !confirm()) return;
    state.busy = true; state.checkedAt = undefined; state.message = "Rechecking and requesting applying pass…"; state.changed?.();
    // Once POST could be attempted, this session never offers an automatic retry.
    let attempted = false;
    try {
      const id = await dispatchPass(gh, facts, () => { attempted = true; });
      if (id !== undefined) state.runId = id;
      state.sent = true; state.message = state.runId ? "Applying pass requested." : "Applying pass accepted; GitHub returned no run ID. Check workflow runs for the receipt.";
    } catch (e) {
      if (e instanceof ReadOnlyError) attempted = false;
      state.sent = attempted;
      const denied = !(e instanceof ReadOnlyError) && e instanceof GitHubError && [403, 404].includes(e.status);
      state.message = `${denied ? "Actions read/write permission required. " : ""}${attempted ? "Dispatch outcome may be uncertain. Inspect workflow runs before trying again; no retry was sent. " : "Pass not dispatched. "}${String(e)}`;
    } finally { state.busy = false; state.changed?.(); }
  };
  el.append(check, run, note, receipt);
  paint();
  return el;
}
