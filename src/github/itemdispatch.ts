// Start an agent on an item from its view: dispatchItem posts a job plan,
// which the hosted pass dispatches and records in a comment naming the run.
// No workflow_dispatch here: the pass keeps its own capacity and dedup checks.
import { h } from "../dom.ts";
import { type GitHub, ReadOnlyError } from "./api.ts";
import { dispatchItem } from "./agentruns.ts";
import { MaybeSentError } from "./backend.ts";
import { BOT_LOGIN, OPERATOR } from "./config.ts";
import type { PassView } from "./passview.ts";

export const DISPATCH_KINDS = ["triage", "research", "implement", "fix"] as const;

/** About an hour at the default interval: a pass runs every ten minutes. */
export const MAX_RECORD_CHECKS = 30;

const RECORD = /^<!-- agent-board-dispatch: .+ -->\s*$/;
const RUN_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+/;

/** Survives re-renders of the item view, like runpass.ts's PassControl. */
export interface ItemDispatchState { kind?: string; brief?: string; busy?: boolean; sent?: boolean; plan?: string; run?: string; message?: string; polls?: number; changed?: () => void;
  /** Set on sign-out: no more checks. */
  stopped?: boolean }

interface RawComment { user?: { login?: string } | null; body?: string; created_at?: string }

/** The run named by the first dispatch record the pass wrote at or after `since`, if any. */
export function recordedRun(comments: readonly RawComment[], since: number): string | undefined {
  for (const c of comments) {
    const login = c.user?.login?.toLowerCase();
    if (login !== BOT_LOGIN && login !== OPERATOR) continue;
    if (!RECORD.test(c.body?.split("\n")[0] ?? "") || !(Date.parse(c.created_at ?? "") >= since)) continue;
    const run = RUN_URL.exec(c.body!)?.[0];
    if (run) return run;
  }
  return undefined;
}

/** One read of the plan comment for its time, then of the item's comments since then. */
async function findRun(gh: GitHub, item: string, plan: string): Promise<string | undefined> {
  const [repo, number] = item.split("#");
  const id = /#issuecomment-(\d+)$/.exec(plan)?.[1];
  if (!id) throw new Error("the plan comment's URL names no comment");
  const posted = await gh.send<RawComment>("GET", `/repos/${repo}/issues/comments/${id}`);
  const since = Date.parse(posted.created_at ?? "");
  if (!Number.isFinite(since)) throw new Error("the plan comment has no creation time");
  const comments = await gh.send<RawComment[]>("GET", `/repos/${repo}/issues/${number}/comments?since=${encodeURIComponent(posted.created_at!)}&per_page=100`);
  return recordedRun(Array.isArray(comments) ? comments : [], since);
}

/**
 * The operator's dispatch form for an open item (`owner/repo#n`). Asks
 * before writing; one plan per state, never retried after it may have gone
 * out. The pass view is read when the button is pressed, not when drawn.
 */
export function itemDispatchControl(gh: GitHub, item: string, view: () => PassView | undefined, state: ItemDispatchState,
  confirm: (message: string) => boolean = (m) => window.confirm(m), pollMs = 20_000): HTMLElement {
  const kind = h("select", { "aria-label": "Job kind" }, ...DISPATCH_KINDS.map((k) => h("option", { value: k }, k)));
  const brief = h("textarea", { "aria-label": "Brief", rows: "3", maxlength: "16000", placeholder: "What the agent should do" });
  const start = h("button", { type: "submit" }, "Dispatch");
  const note = h("p", { class: "note", role: "status", "aria-live": "polite" });
  const links = h("p", {});
  kind.value = state.kind ?? DISPATCH_KINDS[0];
  brief.value = state.brief ?? "";
  kind.onchange = () => { state.kind = kind.value; };
  brief.oninput = () => { state.brief = brief.value; };
  const form = h("form", { class: "item-dispatch" }, h("h3", {}, "Start an agent"), h("label", {}, "Kind ", kind), h("label", {}, "Brief ", brief), start, note, links);

  function paint() {
    start.disabled = kind.disabled = brief.disabled = !!state.busy || !!state.sent;
    note.textContent = state.message ?? `Posts a job plan as ${OPERATOR}; the next hosted pass dispatches it.`;
    links.replaceChildren(...[state.plan && h("a", { href: state.plan, target: "_blank", rel: "noopener" }, "Plan comment"),
      state.run && h("a", { href: state.run, target: "_blank", rel: "noopener" }, `Run ${state.run.split("/").at(-1)}`)].filter((a) => !!a).flatMap((a, i) => i ? [" · ", a] : [a]));
    links.hidden = !state.plan;
  }

  async function poll() {
    if (!state.plan || state.run || state.stopped) return;
    try {
      const run = await findRun(gh, item, state.plan);
      if (run) { state.run = run; state.message = "Dispatched by the pass."; state.changed?.(); return; }
      state.message = "Plan posted; not dispatched yet. The next pass picks it up.";
    } catch (e) {
      if (state.stopped) return;
      state.message = `Plan posted; couldn't check for its dispatch: ${e instanceof Error ? e.message : String(e)}`;
    }
    state.polls = (state.polls ?? 0) + 1;
    if (state.polls < MAX_RECORD_CHECKS) setTimeout(() => void poll(), pollMs);
    else state.message += " Automatic checks stopped; follow the plan comment on GitHub.";
    state.changed?.();
  }

  form.onsubmit = async (event) => {
    event.preventDefault();
    if (state.busy || state.sent) return;
    if (gh.readOnly) { state.message = new ReadOnlyError().message; paint(); return; }
    if (!confirm(`Post a ${kind.value} plan on ${item}? The next pass starts an agent on it.`)) return;
    state.busy = true; state.message = "Posting the plan…"; state.changed?.();
    try {
      state.plan = await dispatchItem(gh, view(), { item, kind: kind.value, brief: brief.value });
      state.sent = true; state.message = "Plan posted; not dispatched yet.";
      setTimeout(() => void poll(), pollMs);
    } catch (e) {
      // A refusal sent nothing and can be corrected; a lost response may have posted the plan.
      state.sent = e instanceof MaybeSentError;
      const why = e instanceof Error ? e.message : String(e);
      // dispatchItem's own refusals already start "not dispatching".
      state.message = state.sent ? why : why.startsWith("not ") ? `N${why.slice(1)}` : `Not dispatched: ${why}`;
    } finally { state.busy = false; state.changed?.(); }
  };
  // A re-render replaces this element; completion repaints the mounted one.
  state.changed = paint;
  paint();
  return form;
}
