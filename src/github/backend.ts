// What the app does against GitHub: read the queue, read an item's
// context, and act on an ask: answer a question, comment on a review or
// chore, rerun a chore's failed runs. The views call these; tests drive
// them with a scripted fetch.

import { type Answer, formatAnswer, formatComment, parseQuestion } from "../answer.ts";
import { type GitHub, GitHubError, ReadOnlyError } from "./api.ts";
import {
  failedJobs,
  parseAskBody,
  parsePrUrl,
  parseRunUrl,
  type RawJob,
  type RawRun,
  rerunComment,
  rerunProblem,
  type ReviewTarget,
  type RunRef,
} from "./asks.ts";
import {
  answeredPending,
  askKind,
  askProblem,
  type AskKind,
  type AskScope,
  assigneeLogins,
  boardItems,
  fieldIds,
  type IssueRef,
  isAsk,
  isQuestion,
  type Item,
  labelNames,
  missingTriageFields,
  openItems,
  parseIssueUrl,
  parseItem,
  type RawContent,
  type RawField,
  type RawItem,
  repoOf,
  type SubIssueSummary,
  TRACKER_SCOPE,
} from "./board.ts";
import { BOARD_NUMBER, BOARD_OWNER, BOT_LOGIN, OPERATOR, QUESTION_LABEL, DONE, FETCH_CONCURRENCY, LINKED_STATUSES, PAGE_SIZE, QUEUE_STATUSES, RECENT_COMMENTS, TRACKER_REPO } from "./config.ts";
import { promoteProblem, refKey } from "./forge.ts";
import { mapLimit, readHeadCi, submitReview } from "./prs.ts";
import type { CiState, ReviewRequest } from "./forge.ts";
import { approveHead, approveSelected, type ApproveResult } from "./maintain.ts";

const PROJECT = `/orgs/${BOARD_OWNER}/projectsV2/${BOARD_NUMBER}`;

export interface Board {
  items: Item[];
  changed: boolean;
}

export interface ProjectStatus {
  body: string;
  createdAt: string;
}

/** Project updates are available through GraphQL, independently of board items. */
export async function loadProjectStatus(gh: GitHub): Promise<ProjectStatus | null> {
  const query = `query { organization(login: "${BOARD_OWNER}") { projectV2(number: ${BOARD_NUMBER}) { statusUpdates(first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { body createdAt } } } } }`;
  const result = await gh.graphql<{ organization?: { projectV2?: { statusUpdates: { nodes: ProjectStatus[] } } } }>(query);
  const updates = result.organization?.projectV2?.statusUpdates.nodes;
  if (!updates) throw new Error("the project's status updates could not be read");
  return updates[0] ?? null;
}

export interface Queue extends Board {
  /**
   * Items outside the queue whose Branch may hold a PR the queue lists
   * (In Review): they give it a priority and an org, never an entry.
   */
  linked: Item[];
}

/** Read the board's fields, and the items matching the board search `q`, conditionally: 304s cost nothing. */
async function readBoard(gh: GitHub, q?: string): Promise<{ fields: RawField[]; items: RawItem[]; changed: boolean }> {
  const fields = await gh.getAll<RawField>(`${PROJECT}/fields?per_page=${PAGE_SIZE}`);
  const ids = fieldIds(fields.data).join(",");
  const filter = q === undefined ? "" : `&q=${encodeURIComponent(q)}`;
  const items = await gh.getAll<RawItem>(`${PROJECT}/items?per_page=${PAGE_SIZE}&fields=${ids}${filter}`);
  return { fields: fields.data, items: items.data, changed: fields.changed || items.changed };
}

/** Read the board's items with one of `statuses`. */
export async function loadBoard(gh: GitHub, statuses: readonly string[]): Promise<Board> {
  // The server-side filter keeps the poll to one page; boardItems filters
  // again, in case the filter syntax ever stops matching.
  const r = await readBoard(gh, `status:${statuses.map((s) => `"${s}"`).join(",")}`);
  return { items: boardItems(r.items, statuses), changed: r.changed };
}

/** Read every unarchived board item, Done ones too (several pages, mostly 304s). */
export async function loadWholeBoard(gh: GitHub): Promise<Board> {
  const r = await readBoard(gh);
  return { items: r.items.filter((i) => !i.archived_at).map(parseItem), changed: r.changed };
}

export interface OpenBoard extends Board {
  /** Triage fields the board lacks, by name. */
  missing: string[];
}

/** Read every board item that isn't Done, with its triage fields. */
export async function loadOpenBoard(gh: GitHub): Promise<OpenBoard> {
  const r = await readBoard(gh, `-status:${DONE}`);
  return { items: openItems(r.items), changed: r.changed, missing: missingTriageFields(r.fields) };
}

/**
 * Read every open question in the tracker, including decision-labelled ones,
 * as items (not board items: their project fields are absent), so they
 * answer like any question.
 */
export async function loadDecisions(gh: GitHub): Promise<Board> {
  const r = await gh.getAll<RawContent>(`/repos/${TRACKER_REPO}/issues?labels=${encodeURIComponent(QUESTION_LABEL)}&state=open&per_page=${PAGE_SIZE}`);
  const items = r.data
    .filter((c) => !c.pull_request && c.html_url)
    .map((c) => parseItem({ id: 0, node_id: c.node_id ?? (c.html_url as string), content_type: "Issue", content: c }))
    // Only questions can be answered; a decision label on anything else is a mistake.
    .filter(isQuestion);
  return { items, changed: r.changed };
}

/** Read the items needing a human or ready for review, and in one request those linked to PRs the queue lists. */
export async function loadQueue(gh: GitHub): Promise<Queue> {
  const board = await loadBoard(gh, [...QUEUE_STATUSES, ...LINKED_STATUSES]);
  const queued = (i: Item) => i.status !== undefined && QUEUE_STATUSES.includes(i.status);
  return { items: board.items.filter(queued), linked: board.items.filter((i) => !queued(i)), changed: board.changed };
}

export interface Comment {
  author: string;
  createdAt: string;
  url: string;
  body: string;
}

interface RawComment {
  user?: { login?: string } | null;
  created_at: string;
  html_url: string;
  body?: string | null;
}

export interface GistFile {
  name: string;
  language?: string;
  content: string;
  truncated: boolean;
}

export interface Gist {
  url: string;
  owner?: string;
  files: GistFile[];
}

interface RawGist {
  html_url: string;
  owner?: { login?: string } | null;
  files?: Record<string, { filename?: string; language?: string | null; content?: string; truncated?: boolean }>;
}

/** A sub-issue, as listed under its parent. */
export interface SubIssue {
  ref: IssueRef;
  url: string;
  title: string;
  state: string;
  labels: string[];
  /** Its own sub-issue progress, when it has sub-issues. */
  progress?: SubIssueSummary;
}

export interface Context {
  comments: Comment[];
  gists: Gist[];
  /** A tracker issue's sub-issues, when it has any. */
  subIssues?: SubIssue[];
  /** A rerun chore's runs, in the order its body names them. */
  runs?: RunStatus[];
  /** On a question: he commented after the bot last did. */
  answered?: boolean;
  /** Problems reading optional context, shown but not fatal. */
  warnings: string[];
}

/** The gist id in a gist URL, if it is one. */
export function gistId(url: string): string | undefined {
  return /^https:\/\/gist\.github\.com\/(?:[A-Za-z0-9-]+\/)?([0-9a-f]+)(?:[#?].*)?$/.exec(url)?.[1];
}

function commentsPath(ref: IssueRef): string {
  return `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments?per_page=${PAGE_SIZE}`;
}

/** Every comment on an issue or PR, oldest first, conditionally. */
async function loadComments(gh: GitHub, ref: IssueRef): Promise<Comment[]> {
  const r = await gh.getAll<RawComment>(commentsPath(ref));
  return r.data.map((c) => ({
    author: c.user?.login ?? "ghost",
    createdAt: c.created_at,
    url: c.html_url,
    body: c.body ?? "",
  }));
}

/**
 * A tracker issue's sub-issues, in GitHub's order, conditionally. Only
 * read for tracker issues whose summary says they have some; upstream
 * issues' trees aren't the bot's.
 */
export async function loadSubIssues(gh: GitHub, item: Item): Promise<SubIssue[] | undefined> {
  const ref = item.ref;
  if (!ref || item.kind !== "issue" || repoOf(ref) !== TRACKER_REPO.toLowerCase() || !item.subIssues) return undefined;
  const r = await gh.getAll<RawContent>(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/sub_issues?per_page=${PAGE_SIZE}`);
  return r.data.flatMap((c) => {
    const subRef = parseIssueUrl(c.html_url ?? "");
    if (!subRef || !c.html_url) return [];
    const sub: SubIssue = { ref: subRef, url: c.html_url, title: c.title ?? "(no title)", state: c.state ?? "open", labels: labelNames(c.labels) };
    if (c.sub_issues_summary && c.sub_issues_summary.total > 0) sub.progress = c.sub_issues_summary;
    return [sub];
  });
}

/** Read an item's comments, gists and, on a tracker issue, sub-issues. */
export async function loadContext(gh: GitHub, item: Item): Promise<Context> {
  const ctx: Context = { comments: [], gists: [], warnings: [] };
  const tasks: Promise<void>[] = [];
  if (item.ref) {
    tasks.push(
      loadComments(gh, item.ref).then((all) => {
        ctx.comments = all.slice(-RECENT_COMMENTS);
        if (isAsk(item)) ctx.answered = answeredPending(all);
      }),
      loadSubIssues(gh, item).then((subs) => {
        if (subs) ctx.subIssues = subs;
      }),
    );
  }
  const reruns = askKind(item) === "chore" && item.state === "open" ? parseAskBody(item.body) : undefined;
  if (reruns && reruns.problems.length === 0 && reruns.reruns.length > 0) {
    tasks.push(
      loadRuns(gh, reruns.reruns, reruns.blocks).then((runs) => {
        ctx.runs = runs;
      }),
    );
  }
  for (const url of item.gist) {
    const id = gistId(url);
    if (!id) continue;
    tasks.push(
      gh.get<RawGist>(`/gists/${id}`).then((r) => {
        ctx.gists.push({
          url: r.data.html_url,
          ...(r.data.owner?.login ? { owner: r.data.owner.login } : {}),
          files: Object.values(r.data.files ?? {}).map((f) => ({
            name: f.filename ?? "(unnamed)",
            ...(f.language ? { language: f.language } : {}),
            content: f.content ?? "",
            truncated: f.truncated === true,
          })),
        });
      }),
    );
  }
  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === "rejected") ctx.warnings.push(String(r.reason instanceof Error ? r.reason.message : r.reason));
  }
  return ctx;
}

/** The signed-in login. */
export async function viewer(gh: GitHub): Promise<string> {
  const r = await gh.get<{ login: string }>("/user");
  return r.data.login;
}

/**
 * Run an Inbox card's `write` only under the operator's own token, as
 * GitHub names it now: the page's login may be unconfirmed or stale, and
 * another token's approval or answer would count for nothing, or for
 * someone else.
 */
export async function asOperator<T>(gh: GitHub, write: () => Promise<T>): Promise<T> {
  const { login } = await gh.send<{ login: string }>("GET", "/user");
  if (login.toLowerCase() !== OPERATOR.toLowerCase()) throw new Error(`this token is ${login}'s, not ${OPERATOR}'s; nothing was sent`);
  return write();
}

/** Read the exact target, not a transferred issue, before showing or answering its ask. */
export async function readAnswerTarget(gh: GitHub, item: string): Promise<RawContent> {
  const [owner = "", repo = "", n] = item.split(/[/#]/);
  const issue = await gh.send<RawContent>("GET", `/repos/${owner}/${repo}/issues/${Number(n)}`);
  const actual = parseIssueUrl(issue.html_url ?? "");
  if (!actual || refKey(actual).toLowerCase() !== item.toLowerCase() || issue.state !== "open") throw new Error(`not answering: ${item} is ${issue.state === "open" ? `now ${issue.html_url}` : issue.state ?? "not open"}`);
  return issue;
}

/** Answer only the ask shown. A comment never releases arbitrary pass holds. */
export async function answerHold(gh: GitHub, item: string, text: string, shown: RawContent, release = false, check?: () => Promise<void>): Promise<Posted> {
  const [owner = "", repo = "", n] = item.split(/[/#]/);
  const ref = { owner, repo, number: Number(n) };
  const body = formatComment(text);
  const issue = await readAnswerTarget(gh, item);
  const identity = (i: RawContent) => JSON.stringify([i.title, i.body, labelNames(i.labels).sort(), assigneeLogins(i.assignees).sort(), i.user?.login, !!i.pull_request]);
  const same = (now: RawContent) => {
    if (release && !labelNames(now.labels).includes("needs-human")) throw new Error("The intended needs-human hold is no longer present");
    if (identity(now) !== identity(shown)) throw new Error("The ask changed; not answering or releasing it. Reload and read it again.");
  };
  same(issue);
  await check?.();
  // ask-created tracker questions may be closed, not arbitrary held work.
  // Never follow editable Blocks: text to unlabel a different target here.
  const question = parseQuestion(issue.body ?? "");
  const close = release && question.blocks !== undefined && askProblem({
    kind: issue.pull_request ? "pr" : "issue", ref, state: issue.state ?? "",
    labels: labelNames(issue.labels), assignees: assigneeLogins(issue.assignees), author: issue.user?.login ?? "",
  }, "question") === undefined;
  if (close) {
    const board = await loadWholeBoard(gh);
    if (!board.items.some((i) => i.ref && refKey(i.ref).toLowerCase() === item.toLowerCase())) throw new Error("The question is no longer on the board; not resolving it");
  }
  let posted: Posted;
  try {
    posted = await comment(gh, ref, body);
    const receipt = typeof posted.url === "string" ? /^(.*)#issuecomment-[1-9][0-9]*$/.exec(posted.url) : null;
    const target = receipt ? parseIssueUrl(receipt[1]!) : undefined;
    if (!target || refKey(target).toLowerCase() !== item.toLowerCase()) throw new Error("GitHub did not confirm a comment on this item");
  }
  catch (e) {
    if (e instanceof ReadOnlyError) throw e;
    throw new MaybeSentError(`Comment failed or uncertain: ${String(e)}. Check GitHub; do not repost.`);
  }
  if (release) {
    try {
      same(await readAnswerTarget(gh, item));
      await check?.();
      if (close) await gh.send("PATCH", `/repos/${owner}/${repo}/issues/${n}`, { state: "closed", state_reason: "completed" });
      await gh.send("DELETE", `/repos/${owner}/${repo}/issues/${n}/labels/needs-human`);
    } catch (e) { throw new MaybeSentError(`Answer posted: ${posted.url}; release failed: ${String(e)}. Finish on GitHub; do not repost.`); }
  }
  return posted;
}

/**
 * The open asks he has answered (or commented on) and the bot hasn't acted
 * on yet, by node id. Reads comments only of open asks that have any; the reads
 * are conditional, so an unchanged issue costs nothing, and at most
 * FETCH_CONCURRENCY run at once. A question whose comments can't be read
 * counts as unanswered.
 */
export async function loadAnswered(gh: GitHub, items: readonly Item[]): Promise<Set<string>> {
  const asked = items.filter((i) => isAsk(i) && i.state === "open" && i.ref && (i.comments ?? 1) > 0);
  const answered = await mapLimit(asked, FETCH_CONCURRENCY, async (i) => {
    try {
      return answeredPending(await loadComments(gh, i.ref as IssueRef)) ? [i.nodeId] : [];
    } catch {
      return [];
    }
  });
  return new Set(answered.flat());
}

export interface Posted {
  /** The comment. */
  url: string;
}

/**
 * Read an ask's issue fresh and check it is still one of `want`'s kind
 * in `scope`; anything else throws, before anything is written. A
 * transferred issue doesn't count: it would answer from its new home.
 */
async function freshAsk(gh: GitHub, ref: IssueRef, want: AskKind, scope: AskScope, verb = "answering"): Promise<RawContent> {
  const issue = await gh.send<RawContent>("GET", `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`);
  const actual = parseIssueUrl(issue.html_url ?? "");
  if (!actual || refKey(actual).toLowerCase() !== refKey(ref).toLowerCase()) {
    throw new Error(`not ${verb}: ${refKey(ref)} is now ${issue.html_url ?? "somewhere unknown"}`);
  }
  const facts = {
    kind: issue.pull_request ? "pr" : "issue",
    ref: actual,
    labels: labelNames(issue.labels),
    assignees: assigneeLogins(issue.assignees),
    ...(issue.user?.login ? { author: issue.user.login } : {}),
    ...(issue.state ? { state: issue.state } : {}),
  } as const;
  const problem = askProblem(facts, want, scope);
  if (problem !== undefined) throw new Error(`not ${verb}: ${problem}`);
  return issue;
}

async function comment(gh: GitHub, ref: IssueRef, body: string): Promise<Posted> {
  const c = await gh.send<{ html_url: string }>("POST", `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`, { body });
  return { url: c.html_url };
}

/**
 * Answer a question: one comment by you on its issue. The issue is read
 * fresh first and must be an open question in `scope` (the tracker,
 * opened by the bot and assigned to him, unless overridden, e.g. by a
 * test against a sandbox repository), and a picked letter must be one of
 * the options its body offers now; anything else is refused before
 * writing. A plain function of a client and an issue, so a script can
 * drive it with any token.
 */
export async function postAnswer(gh: GitHub, ref: IssueRef, answer: Answer, scope: AskScope = TRACKER_SCOPE): Promise<Posted> {
  const body = formatAnswer(answer);
  const issue = await freshAsk(gh, ref, "question", scope);
  // The options may have changed since the view was rendered.
  if (answer.choice !== undefined) {
    const letters = parseQuestion(issue.body ?? "").options.map((o) => o.letter);
    if (!letters.includes(answer.choice)) {
      const now = letters.length ? `it now offers ${letters.join(", ")}` : "it no longer offers options";
      throw new Error(`not answering: ${refKey(ref)} has no option ${answer.choice}; ${now}. Reload it.`);
    }
  }
  return comment(gh, ref, body);
}

/**
 * Comment on a review or chore ask: his own words (bot command lines
 * refused, as in an answer), or what the app did for him. The issue is
 * read fresh and checked as postAnswer does.
 */
export async function postAskComment(gh: GitHub, ref: IssueRef, kind: "review" | "chore", text: string, scope: AskScope = TRACKER_SCOPE): Promise<Posted> {
  const body = formatComment(text);
  await freshAsk(gh, ref, kind, scope);
  return comment(gh, ref, body);
}

/**
 * Read a review ask fresh and return its `Review:` target for this PR:
 * it must still be an open review ask in `scope` naming `pr` (and no
 * line the app can't read), at the head the pane showed as asked about.
 * The review pane offers its form on an upstream PR only because of the
 * ask, so this runs before anything is written, not just before telling
 * the bot.
 */
export async function freshReviewAsk(gh: GitHub, ask: IssueRef, pr: IssueRef, askedHead: string, scope: AskScope = TRACKER_SCOPE): Promise<ReviewTarget> {
  const issue = await freshAsk(gh, ask, "review", scope, "reviewing");
  const body = parseAskBody(issue.body ?? "");
  if (body.problems.length) throw new Error(`not reviewing: ${refKey(ask)} ${body.problems[0]}`);
  const target = body.reviews.find((r) => refKey(r.ref).toLowerCase() === refKey(pr).toLowerCase());
  if (!target) throw new Error(`not reviewing: ${refKey(ask)} no longer asks for a review of ${refKey(pr)}`);
  if (target.head !== askedHead) {
    throw new Error(`not reviewing: ${refKey(ask)} now asks about ${target.head.slice(0, 12)}, not the ${askedHead.slice(0, 12)} shown; reload (r)`);
  }
  return target;
}

/**
 * Submit a review that only a review ask allows (an upstream PR): the ask
 * is re-read first (see freshReviewAsk), and a closed, changed or
 * reassigned one sends nothing.
 */
export async function submitAskedReview(
  gh: GitHub,
  ask: IssueRef,
  pr: IssueRef,
  askedHead: string,
  reviews: readonly ReviewRequest[],
  onSent: (index: number) => void = () => {},
  scope: AskScope = TRACKER_SCOPE,
): Promise<string> {
  await freshReviewAsk(gh, ask, pr, askedHead, scope);
  return submitReview(gh, pr, reviews, onSent);
}

/**
 * Approve `pr` at `head`, the head an Inbox card read: through its review
 * ask when one names it. Without the PR pane's prompt, an ask about
 * another head refuses rather than approving one the bot didn't ask about.
 * Preserve the structured outcome, including possibly sent writes.
 */
export async function approveAt(gh: GitHub, pr: IssueRef, head: string, ask?: { ref: IssueRef; head: string }): Promise<ApproveResult> {
  if (ask && ask.head !== head) throw new Error(`not approving: ${refKey(ask.ref)} asks about ${ask.head.slice(0, 12)}, but the head is ${head.slice(0, 12)}; open the PR to review it`);
  if (ask) await freshReviewAsk(gh, ask.ref, pr, ask.head);
  const [result] = await approveSelected(gh, [{ pr, head, reason: "" }]);
  return result!;
}

/** A member of a card's PRs, as one read of it shows it. */
export interface MemberPr {
  ci: CiState | "unknown";
  ref: IssueRef;
  url: string;
  title: string;
  /** open, closed or merged, and draft. */
  state: string;
  head: string;
  author: string;
  /** Why bot-pr would not promote it on a plain `/promote`; undefined when it would. */
  problem?: string;
}

/** One PR read now, for a card's member: a single request, made when he opens it. */
export async function readMember(gh: GitHub, ref: IssueRef): Promise<MemberPr> {
  const pr = await gh.send<{ html_url: string; title: string; state: string; merged?: boolean; draft?: boolean; body?: string | null; user?: { login?: string } | null; head: { sha: string } }>("GET", `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`);
  const actual = parseIssueUrl(pr.html_url);
  if (!actual || refKey(actual).toLowerCase() !== refKey(ref).toLowerCase()) throw new Error(`${refKey(ref)} is now ${pr.html_url}`);
  const author = pr.user?.login ?? "ghost";
  const problem = promoteProblem({ ref: actual, author, body: pr.body ?? "" });
  const ci = await readHeadCi(gh, ref, pr.head.sha);
  return { ref: actual, url: pr.html_url, title: pr.title, state: `${pr.merged ? "merged" : pr.state}${pr.draft ? " draft" : ""}`, head: pr.head.sha, author, ci, ...(problem ? { problem } : {}) };
}

/** A push after this check can only leave an approval of the old commit, never its replacement. */
export async function promoteMember(gh: GitHub, ref: IssueRef, head: string, policy: () => void, ci: MemberPr["ci"] = "unknown"): Promise<string | undefined> {
  return asOperator(gh, async () => {
    const check = async () => {
      policy();
      const now = await readMember(gh, ref);
      if (now.head !== head) throw new Error("This member changed: head moved. Reload, reread and confirm again.");
      if (now.ci !== ci) throw new Error("This member changed: CI moved. Reload, reread and confirm again.");
      if (now.state !== "open draft" || now.problem || !/^[0-9a-f]{40}$/.test(head)) throw new Error(now.problem ?? `Member is ${now.state}, not an eligible open draft`);
      policy();
    };
    await check();
    return approveHead(gh, { pr: ref, head, reason: "promote" }, check);
  });
}

/**
 * The rerun request went out, or may have: the network failed, or GitHub
 * answered with a server error, after it was sent. Don't retry blindly.
 */
export class MaybeSentError extends Error {
  override name = "MaybeSentError";
}

/** A run a chore asks to rerun, as last read. */
export interface RunStatus {
  run: RunRef;
  name?: string;
  status?: string;
  conclusion?: string;
  attempt?: number;
  /** The commit the run ran on. */
  headSha?: string;
  /** The current head of the PR the chore blocks, when it blocks one and it could be read. */
  prHead?: string;
  /** The latest attempt's failed jobs. */
  failed: { name: string; url?: string }[];
  /** Why its failed jobs can't be rerun now, if they can't. */
  problem?: string;
}

export async function readRun(gh: GitHub, run: RunRef): Promise<{ raw: RawRun; jobs: RawJob[] }> {
  const path = `/repos/${run.owner}/${run.repo}/actions/runs/${run.id}`;
  const raw = await gh.send<RawRun>("GET", path);
  const jobs = await gh.send<{ jobs?: RawJob[] }>("GET", `${path}/jobs?filter=latest&per_page=${PAGE_SIZE}`);
  return { raw, jobs: jobs.jobs ?? [] };
}

/** The current head of a PR, or undefined if it can't be read. */
async function prHead(gh: GitHub, pr: IssueRef): Promise<string | undefined> {
  try {
    const r = await gh.get<{ head?: { sha?: string } }>(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`);
    return r.data.head?.sha;
  } catch {
    return undefined;
  }
}

/**
 * Read the runs a chore names, and whether each one's failed jobs can be
 * rerun. When the chore blocks a PR (`blocks`), its current head is read
 * too, so a run on an older head can be pointed out.
 */
export async function loadRuns(gh: GitHub, runs: readonly RunRef[], blocks?: string): Promise<RunStatus[]> {
  const pr = blocks ? parsePrUrl(blocks) : undefined;
  const head = pr ? await prHead(gh, pr) : undefined;
  return mapLimit(runs, FETCH_CONCURRENCY, async (run) => {
    try {
      const { raw, jobs } = await readRun(gh, run);
      const out: RunStatus = {
        run,
        failed: failedJobs(jobs).map((j) => ({ name: j.name ?? "(unnamed job)", ...(j.html_url ? { url: j.html_url } : {}) })),
      };
      if (raw.name) out.name = raw.name;
      if (raw.status) out.status = raw.status;
      if (raw.conclusion) out.conclusion = raw.conclusion;
      if (typeof raw.run_attempt === "number") out.attempt = raw.run_attempt;
      if (raw.head_sha) out.headSha = raw.head_sha;
      if (head) out.prHead = head;
      const problem = rerunProblem(run, raw, jobs);
      if (problem) out.problem = problem;
      return out;
    } catch (e) {
      return { run, failed: [], problem: `couldn't read the run: ${e instanceof Error ? e.message : String(e)}` };
    }
  });
}

/**
 * Rerun the failed jobs of one run a chore names, with your token, then
 * say so on the chore. Strict, since it writes upstream: the chore is
 * read fresh and must be an open chore in `scope` whose body names this
 * exact run URL (and no line it can't read); the run is read fresh and
 * must be that run, in that repository, completed and failed, with
 * failed jobs. Only then the one endpoint that reruns failed jobs is
 * called, built from the parsed URL's parts.
 */
export async function rerunFailedJobs(gh: GitHub, ask: IssueRef, runUrl: string, scope: AskScope = TRACKER_SCOPE): Promise<Posted> {
  const run = parseRunUrl(runUrl);
  if (!run) throw new Error(`not rerunning: ${JSON.stringify(runUrl)} is not a workflow run URL`);
  const issue = await freshAsk(gh, ask, "chore", scope);
  const body = parseAskBody(issue.body ?? "");
  if (body.problems.length) throw new Error(`not rerunning: ${refKey(ask)} ${body.problems[0]}`);
  if (!body.reruns.some((r) => r.url === run.url)) throw new Error(`not rerunning: ${refKey(ask)} doesn't ask to rerun ${run.url}`);
  const { raw, jobs } = await readRun(gh, run);
  const problem = rerunProblem(run, raw, jobs);
  if (problem) throw new Error(`not rerunning ${run.url}: ${problem}`);
  await postRerun(gh, run);
  try {
    return await comment(gh, ask, formatComment(rerunComment(run)));
  } catch (e) {
    throw new Error(`reran the failed jobs of ${run.url}, but couldn't say so on ${refKey(ask)}: ${e instanceof Error ? e.message : String(e)}. Comment there yourself.`);
  }
}

/**
 * Rerun the failed jobs of one run behind a failed required check of a
 * PR the queue lists for a rerun (the app, not a chore, found it). As
 * strict as rerunFailedJobs: `allowed` must name this exact run URL (the
 * runs the queue found for the PR); the PR is read fresh and must be
 * open; the run is read fresh and must be that run, in the PR's base
 * repository, on the PR's current head, completed and failed, with
 * failed jobs. Only then the one endpoint that reruns failed jobs is
 * called. Nothing is commented anywhere: the checks turning green (or
 * red again) is the record. Resolves to the run's URL.
 */
export async function rerunPrRun(gh: GitHub, pr: IssueRef, runUrl: string, allowed: readonly RunRef[]): Promise<string> {
  const run = parseRunUrl(runUrl);
  if (!run) throw new Error(`not rerunning: ${JSON.stringify(runUrl)} is not a workflow run URL`);
  if (!allowed.some((r) => r.url === run.url)) throw new Error(`not rerunning: ${run.url} isn't a failed required check of ${refKey(pr)}`);
  if (run.owner.toLowerCase() !== pr.owner.toLowerCase() || run.repo.toLowerCase() !== pr.repo.toLowerCase()) {
    throw new Error(`not rerunning: ${run.url} is not in ${pr.owner}/${pr.repo}`);
  }
  const fresh = await gh.send<{ state?: string; head?: { sha?: string }; user?: { login?: string } | null }>("GET", `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`);
  if (fresh.state !== "open") throw new Error(`not rerunning: ${refKey(pr)} is ${fresh.state ?? "not open"}`);
  if (fresh.user?.login !== BOT_LOGIN) throw new Error(`not rerunning: ${refKey(pr)} is not ${BOT_LOGIN}'s`);
  const { raw, jobs } = await readRun(gh, run);
  const problem = rerunProblem(run, raw, jobs);
  if (problem) throw new Error(`not rerunning ${run.url}: ${problem}`);
  if (!raw.head_sha || raw.head_sha !== fresh.head?.sha) {
    throw new Error(`not rerunning ${run.url}: it ran on ${(raw.head_sha ?? "an unknown commit").slice(0, 12)}, and ${refKey(pr)} is now at ${(fresh.head?.sha ?? "?").slice(0, 12)}`);
  }
  await postRerun(gh, run);
  return run.url;
}

/** Ask GitHub to rerun a run's failed jobs; a clear refusal (4xx) means nothing happened, anything else may have. */
export async function postRerun(gh: GitHub, run: RunRef): Promise<void> {
  try {
    await gh.send("POST", `/repos/${run.owner}/${run.repo}/actions/runs/${run.id}/rerun-failed-jobs`);
  } catch (e) {
    if (e instanceof GitHubError && e.status < 500) throw e;
    const why = e instanceof Error ? e.message : String(e);
    throw new MaybeSentError(`the rerun request for ${run.url} may or may not have gone out (${why}); check the run on GitHub before trying again`);
  }
}
