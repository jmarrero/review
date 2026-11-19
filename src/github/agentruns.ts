// Live agents' one-click actions: cancel a run, rerun a failed run's failed
// jobs, or redispatch its item by replying with the newest job plan
// (agent-board's docs/job-plans.md). Each is a forge write made with the
// viewer's token, only for a run the pass view lists, and only by OPERATOR:
// every one reads what it acts on fresh first and refuses rather than guess.

import { GitHubError, type GitHub } from "./api.ts";
import { FAILED_CONCLUSIONS, parseRunUrl, type RawRun, rerunProblem, type RunRef } from "./asks.ts";
import { missingScopes } from "./auth.ts";
import { MaybeSentError, postRerun, readRun } from "./backend.ts";
import { BOT_LOGIN, OPERATOR } from "./config.ts";
import type { AgentRun, PassView } from "./passview.ts";

/** A classic token needs these to write to Actions, or to comment; fine-grained ones are refused by GitHub itself. */
const ACTIONS_SCOPE = [{ any: ["repo"], why: "cancelling and rerunning" }];
const COMMENT_SCOPE = [{ any: ["repo", "public_repo"], why: "commenting" }];

const PLAN_INFO = "agent-board-plan";
const PLAN_SCHEMA = "agent-board/job-plan/v1";
/** agent-board refuses an issue with more comments: its newest plan could be unread. */
const MAX_COMMENTS = 1_000;
const LIVE_STATUSES = ["queued", "in_progress", "waiting", "requested", "pending"];

const runKey = (r: AgentRun): string => `${r.item.toLowerCase()} ${r.kind} ${r.run.repository.toLowerCase()}/${r.run.id}`;

/** Whether the pass view lists this run: running, for a cancel; started or running, for a retry or redispatch. */
export function listed(view: PassView, r: AgentRun, runningOnly: boolean): boolean {
  const running = view.in_flight.flatMap((f) => (f.state === "running" ? [f] : []));
  const runs = runningOnly ? running : [...running, ...view.passes.flatMap((p) => p.started)];
  return runs.some((s) => runKey(s) === runKey(r));
}

/** The run's typed parts as a github.com run URL, refused unless it parses strictly. */
function runRef(r: AgentRun, verb: string): RunRef {
  const ref = parseRunUrl(`https://github.com/${r.run.repository}/actions/runs/${r.run.id}`);
  if (!ref) throw new Error(`not ${verb}: ${r.run.repository} run ${r.run.id} is not a workflow run`);
  return ref;
}

/** Refuse a viewer other than OPERATOR (read fresh: the token may have changed) or a classic token that can't write. */
export async function checkViewer(gh: GitHub, verb: string, needs: typeof ACTIONS_SCOPE): Promise<void> {
  const { login } = await gh.send<{ login?: string }>("GET", "/user");
  if (login !== OPERATOR) throw new Error(`not ${verb}: signed in as ${login ?? "an unknown user"}; only ${OPERATOR} acts on agent runs`);
  if (missingScopes(gh.scopes, needs).length) throw new Error(`not ${verb}: this token needs the ${needs[0]!.any.join(" or ")} scope`);
}

function sameRun(ref: RunRef, raw: RawRun): string | undefined {
  if (raw.html_url?.toLowerCase() !== ref.url.toLowerCase() || String(raw.id ?? "") !== ref.id) return `GitHub returned a different run (${raw.html_url ?? "no URL"})`;
  if (raw.repository?.full_name?.toLowerCase() !== `${ref.owner}/${ref.repo}`.toLowerCase()) return `the run is not in ${ref.owner}/${ref.repo}`;
  return undefined;
}

/** A write GitHub refused (4xx) did nothing; anything else may have gone out. */
export async function write<T>(gh: GitHub, method: string, path: string, what: string, body?: unknown): Promise<T> {
  try {
    return await gh.send<T>(method, path, body);
  } catch (e) {
    if (e instanceof GitHubError && (e.status === 403 || e.status === 404)) throw new Error(`not ${what}: this token can't (HTTP ${e.status}); it needs Actions and Issues write access on the repository`);
    if (e instanceof GitHubError && e.status < 500) throw new Error(`not ${what}: ${e.message}`);
    throw new MaybeSentError(`${what} may or may not have gone out (${e instanceof Error ? e.message : String(e)}); check GitHub before trying again`);
  }
}

/** Cancel a run the pass view lists as running, after reading it fresh: a finished run is refused. Resolves to the run's URL. */
export async function cancelRun(gh: GitHub, view: PassView, r: AgentRun): Promise<string> {
  if (!listed(view, r, true)) throw new Error(`not cancelling: the pass view doesn't list run ${r.run.id} as running`);
  const ref = runRef(r, "cancelling");
  await checkViewer(gh, "cancelling", ACTIONS_SCOPE);
  const raw = await gh.send<RawRun>("GET", `/repos/${ref.owner}/${ref.repo}/actions/runs/${ref.id}`);
  const problem = sameRun(ref, raw) ?? (LIVE_STATUSES.includes(raw.status ?? "") ? undefined : `the run already finished (${raw.conclusion ?? raw.status ?? "unknown"})`);
  if (problem) throw new Error(`not cancelling ${ref.url}: ${problem}`);
  await write(gh, "POST", `/repos/${ref.owner}/${ref.repo}/actions/runs/${ref.id}/cancel`, `cancelling ${ref.url}`);
  return ref.url;
}

/** Rerun the failed jobs of a run the pass view lists, read fresh: only a completed, failed run with failed jobs. */
export async function retryRun(gh: GitHub, view: PassView, r: AgentRun): Promise<string> {
  if (!listed(view, r, false)) throw new Error(`not rerunning: the pass view doesn't list run ${r.run.id}`);
  const ref = runRef(r, "rerunning");
  await checkViewer(gh, "rerunning", ACTIONS_SCOPE);
  const { raw, jobs } = await readRun(gh, ref);
  const problem = rerunProblem(ref, raw, jobs);
  if (problem) throw new Error(`not rerunning ${ref.url}: ${problem}`);
  await recoveryPlan(gh, view, r, (raw as RawRun & { created_at?: string }).created_at, "rerunning");
  await postRerun(gh, ref);
  return ref.url;
}

interface PlanComment { body: string; url: string; author: { login: string } | null; editor: { login: string } | null; createdAt: string; lastEditedAt: string | null }

interface CommentConnection { nodes: PlanComment[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }

interface CommentPage { repository?: { issueOrPullRequest?: { comments: CommentConnection } } }

const COMMENT_FIELDS = `comments(first: 100, after: $after) {
  nodes { body url author { login } editor { login } createdAt lastEditedAt }
  pageInfo { hasNextPage endCursor }
}`;
const COMMENTS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      ... on Issue { ${COMMENT_FIELDS} }
      ... on PullRequest { ${COMMENT_FIELDS} }
    }
  }
}`;

/** One fresh snapshot supplies both text and edit evidence; never join REST text to older metadata. */
async function planComments(gh: GitHub, item: string): Promise<PlanComment[]> {
  const [repo, number] = item.split("#");
  const [owner, name] = repo!.split("/");
  const comments: PlanComment[] = [];
  let after: string | null = null;
  for (let page = 1; ; page++) {
    const data: CommentPage = await gh.graphql(COMMENTS_QUERY, { owner, name, number: Number(number), after });
    const connection = data.repository?.issueOrPullRequest?.comments;
    if (!connection || !Array.isArray(connection.nodes) || typeof connection.pageInfo?.hasNextPage !== "boolean") throw new Error(`not recovering ${item}: incomplete comment page`);
    for (const c of connection.nodes) {
      if (!c || typeof c.body !== "string" || typeof c.url !== "string" || !Number.isFinite(Date.parse(c.createdAt)) || !(c.lastEditedAt === null || (typeof c.lastEditedAt === "string" && Number.isFinite(Date.parse(c.lastEditedAt)))) || !("editor" in c)) throw new Error(`not recovering ${item}: incomplete comment edit evidence`);
      comments.push(c);
    }
    if (comments.length > MAX_COMMENTS || (page === MAX_COMMENTS / 100 && connection.pageInfo.hasNextPage)) throw new Error(`not recovering ${item}: it has over ${MAX_COMMENTS} comments, so its newest plan could be unread`);
    if (!connection.pageInfo.hasNextPage) return comments;
    const cursor = connection.pageInfo.endCursor;
    if (!cursor || cursor === after) throw new Error(`not recovering ${item}: missing comment cursor`);
    after = cursor;
  }
}

/**
 * The text of each `agent-board-plan` fence at the start of a line, outside
 * other fences and HTML comments, as agent-board reads them; a quoted plan
 * (`> `) doesn't start a line.
 */
export function planBlocks(body: string): (string | null)[] {
  const out: (string | null)[] = [];
  const lines = body.split(/\r?\n/);
  const codeFence = (line: string) => /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimEnd() === `\`\`\`${PLAN_INFO}`) {
      const text: string[] = [];
      while (++i < lines.length && lines[i]!.trimEnd() !== "```") text.push(lines[i]!);
      out.push(i < lines.length ? text.join("\n") : null);
    } else {
      const m = codeFence(line);
      if (m && !(m[2]![0] === "`" && m[3]!.includes("`"))) {
        while (++i < lines.length) {
          const close = codeFence(lines[i]!);
          if (close && close[2]![0] === m[2]![0] && close[2]!.length >= m[2]!.length && !close[3]!.trim()) break;
        }
      } else if (/^ {0,3}<!--/.test(line) && !line.slice(line.indexOf("<!--") + 4).includes("-->")) {
        while (++i < lines.length && !lines[i]!.includes("-->")) { /* skip the comment, not fenced task text */ }
      }
    }
  }
  return out;
}

/** Mirror JobPlan::from_json in agent-board's board-forge/src/plan.rs. */
function validPlan(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  const fields = ["schema", "repo", "item", "kind", "runner", "pool", "effort", "brief", "stacks_on"];
  const issue = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
  return Object.keys(p).every((k) => fields.includes(k)) && p.schema === PLAN_SCHEMA
    && typeof p.repo === "string" && /^(?!-)[a-z\d_-]{1,39}\/[a-z\d_.-]{1,100}$/i.test(p.repo) && ![".", ".."].includes(p.repo.split("/")[1]!)
    && issue(p.item) && typeof p.kind === "string" && ["implement", "triage", "research", "fix"].includes(p.kind) && p.runner === "hosted"
    && (!("pool" in p) || (typeof p.pool === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(p.pool) && !p.pool.startsWith("tier-")))
    && (!("effort" in p) || p.effort === "heavy")
    && typeof p.brief === "string" && !!p.brief.trim() && [...p.brief].length <= 16_000
    && (!("stacks_on" in p) || (issue(p.stacks_on) && p.stacks_on !== p.item && p.kind === "implement"));
}

/** Shared by both recovery actions: a new plan or dispatch also supersedes Retry after a reload. */
async function recoveryPlan(gh: GitHub, view: PassView, r: AgentRun, created: string | undefined, verb: string): Promise<{ text: string; where: string }> {
  const refuse = (why: string): never => { throw new Error(`not ${verb} ${r.item}: ${why}`); };
  if (view.in_flight.some((f) => f.state === "running" && f.item.toLowerCase() === r.item.toLowerCase())) refuse(`the pass view lists ${r.item} running`);
  const started = Date.parse(created ?? "");
  if (!Number.isFinite(started)) refuse("the run has no creation time");
  const comments = await planComments(gh, r.item);
  const trusted = (login: string | undefined) => [OPERATOR, BOT_LOGIN].some((w) => w.toLowerCase() === login?.toLowerCase());
  const foreignEdit = (c: PlanComment) => (c.lastEditedAt !== null || c.editor !== null) && !trusted(c.editor?.login);
  const changed = (c: PlanComment) => Date.parse(c.lastEditedAt ?? c.createdAt);
  const ref = runRef(r, verb);
  if (comments.some((c) => {
    if (!trusted(c.author?.login) || !/^<!-- agent-board-dispatch: .+ -->\s*$/.test(c.body.split("\n")[0]!)) return false;
    const at = Date.parse(c.createdAt);
    // The record precedes workflow creation, but GitHub can put both in the
    // same second. Only a record naming this run resolves that tie safely.
    const ownRecord = at === started && c.body.toLowerCase().includes(`(${ref.url.toLowerCase()})`);
    return at >= started && !ownRecord;
  })) refuse("the item has a newer dispatch record; check its run on GitHub");
  const plans = comments.filter((c) => trusted(c.author?.login))
    .map((c) => ({ c, blocks: planBlocks(c.body) }))
    .filter((p) => p.blocks.length || foreignEdit(p.c))
    .sort((a, b) => changed(a.c) - changed(b.c));
  const newest = plans.at(-1);
  if (!newest) return refuse(`it has no job plan by ${OPERATOR} or ${BOT_LOGIN}`);
  const where = newest.c.url;
  if (foreignEdit(newest.c)) refuse(`${where} was last edited by ${newest.c.editor?.login ?? "an unidentified account"}, who may not write plans`);
  if (!newest.blocks.length) refuse(`${where} holds no plan`);
  if (newest.blocks.length > 1) refuse(`${where} holds ${newest.blocks.length} plans`);
  if (changed(newest.c) > started) refuse(`its newest plan, ${where}, is newer than the run, so it was already redispatched or replaced`);
  const text = newest.blocks[0];
  if (text == null) return refuse(`${where} plan fence is not closed`);
  let plan: unknown;
  try { plan = JSON.parse(text); } catch { plan = undefined; }
  if (!validPlan(plan)) return refuse(`the newest plan, ${where}, is not an ${PLAN_SCHEMA} object with valid fields`);
  if (plan.kind !== r.kind) refuse(`the newest plan, ${where}, is for ${JSON.stringify(plan.kind)}, not the failed ${r.kind} run`);
  if (`${plan.repo}#${plan.item}`.toLowerCase() !== r.item.toLowerCase()) refuse(`${where} targets another item`);
  return { text, where };
}

/**
 * Redispatch a failed run's item: reply on it with the newest plan a writer
 * (OPERATOR or the planner, BOT_LOGIN) wrote or edited, repeated verbatim.
 * To agent-board that reply is a new plan, which the pass dispatches. The
 * run is read fresh and must have failed, and the item must have nothing
 * running and no plan newer than the run (an earlier redispatch, or a
 * writer's correction already dispatched), so one failure starts one job;
 * the plan must be well formed and of the run's kind, so the reply can't
 * start a different job than the one that failed. Resolves to the reply's URL.
 */
export async function redispatch(gh: GitHub, view: PassView, r: AgentRun): Promise<string> {
  if (!listed(view, r, false)) throw new Error(`not redispatching: the pass view doesn't list run ${r.run.id}`);
  if (view.in_flight.some((f) => f.state === "running" && f.item.toLowerCase() === r.item.toLowerCase())) throw new Error(`not redispatching: the pass view lists ${r.item} running`);
  const ref = runRef(r, "redispatching");
  const [repo, number] = r.item.split("#") as [string, string];
  await checkViewer(gh, "redispatching", COMMENT_SCOPE);
  const raw = await gh.send<RawRun & { created_at?: string }>("GET", `/repos/${ref.owner}/${ref.repo}/actions/runs/${ref.id}`);
  const problem = sameRun(ref, raw) ?? (raw.status !== "completed" ? `the run is ${raw.status ?? "in an unknown state"}, not finished`
    : FAILED_CONCLUSIONS.includes(raw.conclusion ?? "") ? undefined : `the run ended ${raw.conclusion ?? "without a conclusion"}; only a failed run is redispatched`);
  if (problem) throw new Error(`not redispatching ${r.item}: ${problem}`);
  const { text, where } = await recoveryPlan(gh, view, r, raw.created_at, "redispatching");
  const reply = `${ref.url} ended ${raw.conclusion}; this repeats the plan in ${where} to dispatch it again.\n\n\`\`\`${PLAN_INFO}\n${text}\n\`\`\`\n`;
  const posted = await write<{ html_url?: string }>(gh, "POST", `/repos/${repo}/issues/${number}/comments`, `redispatching ${r.item}`, { body: reply });
  return posted?.html_url ?? `https://github.com/${repo}/issues/${number}`;
}

/** What a dispatch asks for: a job plan's fields other than its schema and runner. */
export interface DispatchRequest { item: string; kind: string; pool?: string; brief: string }

/**
 * Dispatch an open issue or PR: comment on it with a new job plan, which
 * agent-board's next pass dispatches as it does redispatch's reply. Refused
 * when the pass view, if there is one, lists the item running, or the plan
 * isn't one agent-board would accept. Resolves to the comment's URL.
 */
export async function dispatchItem(gh: GitHub, view: PassView | undefined, d: DispatchRequest): Promise<string> {
  const [repo, number] = d.item.split("#") as [string, string | undefined];
  const plan = { schema: PLAN_SCHEMA, repo, item: Number(number), kind: d.kind, runner: "hosted", ...(d.pool === undefined ? {} : { pool: d.pool }), brief: d.brief };
  if (!/^[1-9]\d*$/.test(number ?? "") || !validPlan(plan)) throw new Error(`not dispatching ${d.item}: not a valid ${PLAN_SCHEMA} (kind implement, triage, research or fix; pool a lowercase name, not tier-*; a non-empty brief of at most 16000 characters)`);
  if (view?.in_flight.some((f) => f.state === "running" && f.item.toLowerCase() === d.item.toLowerCase())) throw new Error(`not dispatching: the pass view lists ${d.item} running`);
  await checkViewer(gh, "dispatching", COMMENT_SCOPE);
  const issue = await gh.send<{ state?: string; html_url?: string }>("GET", `/repos/${repo}/issues/${number}`);
  if (issue.state !== "open") throw new Error(`not dispatching ${d.item}: it is ${issue.state ?? "in an unknown state"}, not open`);
  const body = `\`\`\`${PLAN_INFO}\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n`;
  const posted = await write<{ html_url?: string }>(gh, "POST", `/repos/${repo}/issues/${number}/comments`, `dispatching ${d.item}`, { body });
  return posted?.html_url ?? issue.html_url ?? `https://github.com/${repo}/issues/${number}`;
}
