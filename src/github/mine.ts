// "Make it mine": he takes over the text of one of the bot's forge PRs,
// for upstreams whose contribution policy is human-text (the title, body
// and commit messages must be his). With his own token the app sets the
// title and body, rewrites every commit of the branch with his message
// and him as committer (same tree, parents and author), moves the branch
// there with a compare-and-swap on the head he was shown, and comments
// `/promote --human-text`.
//
// `bot-pr promote` then checks what GitHub recorded, not what the text
// says: his login pushed the approved head (the fork's activity log
// records a Git Data API ref update as a push by the token's user), made
// the body's last edit, and set the title last; and the body lost the
// bot's `Generated-by` line. See human_text_problems in homegit's
// bin/bot-pr.
//
// Writing with his token is an exception to the app's review-only role,
// so it is kept narrow: only the bot's PRs within a jmarrero-forge fork,
// from a `bot/` branch; trees are never changed (each new commit is
// checked against the old one); the ref moves only from the head he saw;
// and nothing is written before he confirms the diff of the messages.
//
// Nor may it launder the bot's text: the fields start as the bot's,
// Generated-by lines included, and nothing saves while any field still
// has one, so he has to go through each; he also states that the text
// is his. And `/promote --human-text` approves the new head, so the form
// offers it by default only when he already approved the head it
// replaces (same trees, so that approval carries over).
//
// TODO: code edits (a blob, tree and commit per edited file) are out of
// scope for now; larger ones belong in a local checkout anyway.

import type { GitHub } from "./api.ts";
import type { IssueRef } from "./board.ts";
import { BOT_LOGIN, FORGE_ORG } from "./config.ts";
import { META_START, parseBotMeta } from "./forge.ts";
import { type PrDetail, pullPath } from "./prs.ts";

/** The comment that approves with his text, as bot-pr reads it. */
export const HUMAN_TEXT_LINE = "/promote --human-text";
/** The bot's branches, the only ones rewritten. */
export const BRANCH_PREFIX = "bot/";
/** Commits rewritten at most: more is a job for a checkout. */
export const MAX_COMMITS = 50;
/** The bot's trailer in PR bodies, which promote refuses in his text. */
export const LLMS_TRAILER = "Generated-by: https://github.com/jmarrero-bot#llms";
/**
 * bot-pr counts a `/promote` comment only if it is strictly later, to
 * the second, than the push: the latest of the fork's activity log entry
 * and the PR's `head_ref_force_pushed` event, which GitHub adds some
 * seconds after the ref moved. So the comment waits for that event, and
 * then this long.
 */
export const PROMOTE_GAP_MS = 1500;
/** How often, and how many times, to look for that event. */
export const PUSH_EVENT_WAIT_MS = 2000;
export const PUSH_EVENT_TRIES = 30;

const SHA_RE = /^[0-9a-f]{40}$/;
const GENERATED_BY_RE = /^\s*Generated-by:/i;

/** Whether text still has a `Generated-by:` line, the bot's mark. */
export function hasGeneratedBy(text: string): boolean {
  return text.split(/\r\n?|\n/).some((l) => GENERATED_BY_RE.test(l));
}

/** The committer promote signs off as; the form starts with it. */
export const DEFAULT_COMMITTER: Readonly<Identity> = { name: "Joseph Marrero Corchado", email: "jmarrero@redhat.com" };

/** Where GitHub keeps workflows: pushing changes there needs the workflow scope. */
export const WORKFLOWS_DIR = ".github/workflows/";

/** Whether the PR's diff touches a workflow. */
export function touchesWorkflows(d: PrDetail): boolean {
  return d.files.some((f) => f.filename.startsWith(WORKFLOWS_DIR) || (f.previous?.startsWith(WORKFLOWS_DIR) ?? false));
}

/**
 * Why the token can't move a branch whose commits change workflows, if it
 * can't: a classic token (whose scopes GitHub reports) without the
 * workflow scope. For other tokens, undefined; the form says what they need.
 */
export function workflowScopeProblem(d: PrDetail, scopes: string | undefined): string | undefined {
  if (!touchesWorkflows(d) || scopes === undefined) return undefined;
  if (scopes.split(",").map((x) => x.trim()).includes("workflow")) return undefined;
  return `this PR changes ${WORKFLOWS_DIR}, and GitHub moves such a branch only for a token with the workflow scope, which yours lacks; sign in with one that has it`;
}

/** A PR body as his text and the bot-meta section after it (empty without one), which promote needs untouched. */
export interface BodyParts {
  text: string;
  meta: string;
}

export function splitBody(body: string): BodyParts {
  const at = body.indexOf(META_START);
  if (at < 0) return { text: body.trimEnd(), meta: "" };
  return { text: body.slice(0, at).trimEnd(), meta: body.slice(at) };
}

export function joinBody(parts: BodyParts): string {
  const text = parts.text.replace(/\r\n?/g, "\n").trimEnd();
  if (!parts.meta) return text;
  return text ? `${text}\n\n${parts.meta}` : parts.meta;
}

/** A commit message as git stores it: LF line ends, one trailing newline. */
export function normalizeMessage(message: string): string {
  const m = message.replace(/\r\n?/g, "\n").trimEnd();
  return m ? `${m}\n` : "";
}

/** Why the app won't rewrite this PR, or undefined if it may. */
export function mineRefusal(d: PrDetail): string | undefined {
  const repo = `${d.ref.owner}/${d.ref.repo}`;
  if (d.state !== "open") return `the PR is ${d.state}`;
  if (d.ref.owner !== FORGE_ORG) return `only PRs in ${FORGE_ORG} forks can be taken over here`;
  if (d.author !== BOT_LOGIN) return `only ${BOT_LOGIN}'s PRs can be taken over here`;
  if (!d.parent) return `${repo} is not a fork`;
  if (d.headRepo !== repo) return `its branch is in ${d.headRepo ?? "an unknown repository"}, not ${repo}`;
  if (!d.headRef?.startsWith(BRANCH_PREFIX)) return `its branch ${d.headRef ?? "(unknown)"} is not a ${BRANCH_PREFIX} branch`;
  if (!parseBotMeta(d.body).upstream) return "its body has no bot-meta section naming the upstream";
  if (!d.consistent) return "GitHub is still updating it after a push; reload first";
  if (d.commits.length === 0) return "it has no commits";
  if (d.commitCount !== d.commits.length || d.commitCount > MAX_COMMITS) return `it has ${d.commitCount} commits; at most ${MAX_COMMITS} are rewritten here`;
  return undefined;
}

export interface Identity {
  name: string;
  email: string;
}

/** An error message if the committer identity can't be used, else undefined. */
export function identityProblem(id: Identity): string | undefined {
  if (!id.name.trim()) return "the committer name is empty";
  // Git refuses <, > and newlines in an identity; keep the rest loose.
  if (/[<>\n]/.test(id.name + id.email)) return "the committer name and email can't contain <, > or line breaks";
  if (!/^[^\s@]+@[^\s@]+$/.test(id.email.trim())) return `${JSON.stringify(id.email)} is not an email address`;
  return undefined;
}

export interface GitPerson {
  name: string;
  email: string;
  date: string;
}

/** A commit as the Git Data API returns it. */
export interface GitCommit {
  sha: string;
  tree: { sha: string };
  parents: { sha: string }[];
  author: GitPerson;
  committer: GitPerson;
  message: string;
}

/**
 * The PR's commits in order, oldest first, walking first parents from
 * the head. Throws unless they form one line of single-parent commits.
 */
export function orderCommits(commits: readonly GitCommit[], head: string): GitCommit[] {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const out: GitCommit[] = [];
  for (let c = bySha.get(head); c; c = bySha.get(c.parents[0]?.sha ?? "")) {
    if (c.parents.length !== 1) throw new Error(`commit ${c.sha.slice(0, 10)} has ${c.parents.length} parents; only a line of plain commits is rewritten here`);
    if (out.includes(c)) throw new Error("the commits form a cycle");
    out.push(c);
  }
  if (out.length !== commits.length) throw new Error(`only ${out.length} of the PR's ${commits.length} commits lead to its head; rewrite it in a checkout`);
  return out.reverse();
}

/** One field before and after, for the confirmation. */
export interface Change {
  what: string;
  before: string;
  after: string;
  /** Whether it is written: may be true with before === after when only whitespace changes. */
  changed: boolean;
}

export interface MineEdit {
  title: string;
  /** The body's text, without the bot-meta section. */
  body: string;
  /** New commit messages by the old commit's sha. */
  messages: ReadonlyMap<string, string>;
}

/** The body saveMine writes for his text: `body` with the bot-meta section of `d.body`. */
export function newBody(d: PrDetail, edit: MineEdit): string {
  return joinBody({ text: edit.body, meta: splitBody(d.body).meta });
}

/** Everything the save will change, unchanged fields included (so the confirmation can say so). */
export function changes(d: PrDetail, edit: MineEdit): Change[] {
  const title = edit.title.trim();
  const out: Change[] = [
    { what: "Title", before: d.title, after: title, changed: title !== d.title },
    { what: "Description", before: splitBody(d.body).text, after: edit.body.replace(/\r\n?/g, "\n").trimEnd(), changed: newBody(d, edit) !== d.body },
  ];
  for (const c of d.commits) {
    const before = normalizeMessage(c.message);
    const after = normalizeMessage(edit.messages.get(c.sha) ?? c.message);
    // Every commit is rewritten (him as committer); `changed` is about the message.
    out.push({ what: `Commit ${c.sha.slice(0, 10)}`, before, after, changed: before !== after });
  }
  return out;
}

/**
 * Problems with his edit that promote would refuse, or that can't be
 * saved; empty if none. `promote` is whether `/promote --human-text`
 * follows: promote then needs a title he set.
 */
export function editProblems(d: PrDetail, edit: MineEdit, promote: boolean): string[] {
  const out: string[] = [];
  const title = edit.title.trim();
  if (!title) out.push("the title is empty");
  else if (promote && title === d.title) out.push("the title is the bot's: promote needs a title you set");
  if (hasGeneratedBy(edit.title)) out.push("the title has a Generated-by line");
  if (hasGeneratedBy(edit.body)) out.push("the description still has a Generated-by line: the text must be yours");
  for (const c of d.commits) {
    const m = normalizeMessage(edit.messages.get(c.sha) ?? c.message);
    if (!m.split("\n", 1)[0]?.trim()) out.push(`commit ${c.sha.slice(0, 10)} has no subject line`);
    if (hasGeneratedBy(m)) out.push(`commit ${c.sha.slice(0, 10)} still has a Generated-by line: the text must be yours`);
  }
  return out;
}

function sameParents(a: readonly { sha: string }[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((p, i) => p.sha === b[i]);
}

/**
 * Write the new commits, oldest first, each on the previous new one:
 * same tree and author, his message, committer `committer` (dated by
 * GitHub, so its clock and the push log's agree). Every commit GitHub
 * returns is checked against what was asked for. Returns the new shas;
 * nothing points at them yet.
 */
export async function writeCommits(gh: GitHub, repo: string, ordered: readonly GitCommit[], messages: readonly string[], committer: Identity): Promise<string[]> {
  const out: string[] = [];
  for (const [i, c] of ordered.entries()) {
    const message = messages[i];
    if (message === undefined || !message.trim()) throw new Error(`no message for ${c.sha.slice(0, 10)}`);
    const parents = i === 0 ? c.parents.map((p) => p.sha) : [out[i - 1] as string];
    const author = { name: c.author.name, email: c.author.email, date: c.author.date };
    const made = await gh.send<GitCommit>("POST", `/repos/${repo}/git/commits`, {
      message,
      tree: c.tree.sha,
      parents,
      author,
      committer: { name: committer.name.trim(), email: committer.email.trim() },
    });
    const wrong =
      !SHA_RE.test(made.sha ?? "")
        ? "no commit id"
        : made.tree?.sha !== c.tree.sha
          ? `tree ${made.tree?.sha} instead of ${c.tree.sha}`
          : !sameParents(made.parents ?? [], parents)
            ? "different parents"
            : made.author?.name !== author.name || made.author?.email !== author.email || Date.parse(made.author?.date ?? "") !== Date.parse(author.date)
              ? "a different author"
              : (made.message ?? "").trimEnd() !== message.trimEnd()
                ? "a different message"
                : "";
    if (wrong) throw new Error(`GitHub wrote the new ${c.sha.slice(0, 10)} with ${wrong}; the branch was not touched`);
    out.push(made.sha);
  }
  return out;
}

const UPDATE_REFS = `mutation($repo: ID!, $ref: GitRefname!, $before: GitObjectID!, $after: GitObjectID!) {
  updateRefs(input: {repositoryId: $repo, refUpdates: [{name: $ref, beforeOid: $before, afterOid: $after, force: true}]}) { clientMutationId }
}`;

/**
 * Move `refs/heads/BRANCH` from `before` to `after`, only if it still
 * is `before`. REST's `PATCH git/refs` has no such precondition, so this
 * is GraphQL's updateRefs. GitHub answers a failed precondition with a
 * generic error, so on any error the branch is re-read to say whether
 * it moved.
 */
export async function moveBranch(gh: GitHub, repo: string, repoId: string, branch: string, before: string, after: string): Promise<void> {
  let problem: string | undefined;
  try {
    const r = await gh.send<{ errors?: { message?: string }[] }>("POST", "/graphql", {
      query: UPDATE_REFS,
      variables: { repo: repoId, ref: `refs/heads/${branch}`, before, after },
    });
    if (r.errors?.length) problem = r.errors.map((e) => e.message ?? "error").join("; ");
  } catch (e) {
    problem = e instanceof Error ? e.message : String(e);
  }
  if (problem === undefined) return;
  let now: string | undefined;
  try {
    now = (await gh.send<{ object?: { sha?: string } }>("GET", `/repos/${repo}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`)).object?.sha;
  } catch {
    // Report the original problem.
  }
  if (now === after) return;
  if (now && now !== before) throw new Error(`${branch} moved to ${now.slice(0, 12)} since you opened the PR; nothing was pushed. Reload (r) and redo your edits on the new commits.`);
  throw new Error(`updating ${branch} failed: ${problem}; nothing was pushed`);
}

interface RawPullState {
  state?: string;
  title?: string;
  body?: string | null;
  html_url?: string;
  head: { sha: string; ref?: string; repo?: { full_name?: string } | null };
}

export interface MineOptions {
  committer: Identity;
  /** He stated that the text is his; nothing saves without it. */
  ownText: boolean;
  /** Comment HUMAN_TEXT_LINE once saved. */
  promote: boolean;
  /** The token's classic scopes (X-OAuth-Scopes), if GitHub reported them. */
  scopes?: string | undefined;
  /** Reports each step as it starts. */
  progress?: (step: string) => void;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface MineResult {
  /** The new head, now the branch's. */
  head: string;
  /** What was written besides the commits. */
  titleSet: boolean;
  bodySet: boolean;
  /** The `/promote --human-text` comment, if posted. */
  commentUrl?: string;
}

/**
 * Save his edit of the PR `d` he was shown. First checks that GitHub
 * still has what he saw (head, title and body); then writes the commits
 * and moves the branch (the step a race can refuse, so it goes before
 * any visible change); then sets the title and body; then, if asked,
 * comments `/promote --human-text`, which must come after all of it.
 */
export async function saveMine(gh: GitHub, d: PrDetail, edit: MineEdit, opts: MineOptions): Promise<MineResult> {
  const refusal = mineRefusal(d);
  if (refusal) throw new Error(`not taking this PR over: ${refusal}`);
  const problems = [...editProblems(d, edit, opts.promote)];
  const idProblem = identityProblem(opts.committer);
  if (idProblem) problems.push(idProblem);
  const scopeProblem = workflowScopeProblem(d, opts.scopes);
  if (scopeProblem) problems.push(scopeProblem);
  if (!opts.ownText) problems.push("you haven't stated that the text is yours");
  if (problems.length) throw new Error(`not saved: ${problems.join("; ")}`);
  const step = opts.progress ?? (() => {});
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const repo = `${d.ref.owner}/${d.ref.repo}`;
  const branch = d.headRef as string;

  step("Checking the PR is as you saw it");
  const fresh = await gh.send<RawPullState>("GET", pullPath(d.ref));
  if (fresh.state !== "open") throw new Error(`the PR is ${fresh.state ?? "not open"}; nothing was changed`);
  if (fresh.head.sha !== d.head) throw new Error(`the PR's head moved to ${fresh.head.sha.slice(0, 12)} since you opened it; nothing was changed. Reload (r).`);
  if (fresh.head.ref !== branch || fresh.head.repo?.full_name !== repo) throw new Error("the PR's branch changed; nothing was changed. Reload (r).");
  if ((fresh.body ?? "") !== d.body || (fresh.title ?? "") !== d.title) {
    throw new Error("the PR's title or description changed since you opened it; nothing was changed. Reload (r) and redo your edits.");
  }
  const repoId = (await gh.send<{ node_id?: string }>("GET", `/repos/${repo}`)).node_id;
  if (!repoId) throw new Error(`cannot read ${repo}'s id; nothing was changed`);

  step("Reading the commits");
  const raw: GitCommit[] = [];
  for (const c of d.commits) raw.push((await gh.get<GitCommit>(`/repos/${repo}/git/commits/${c.sha}`)).data);
  const ordered = orderCommits(raw, d.head);
  const messages = ordered.map((c) => normalizeMessage(edit.messages.get(c.sha) ?? c.message));

  step(`Writing ${ordered.length} commit${ordered.length > 1 ? "s" : ""}`);
  const shas = await writeCommits(gh, repo, ordered, messages, opts.committer);
  const head = shas.at(-1) as string;

  step(`Moving ${branch} to ${head.slice(0, 10)}`);
  await moveBranch(gh, repo, repoId, branch, d.head, head);

  const title = edit.title.trim();
  const body = newBody(d, edit);
  const patch: { title?: string; body?: string } = {};
  if (title !== d.title) patch.title = title;
  if (body !== d.body) patch.body = body;
  if (patch.title !== undefined || patch.body !== undefined) {
    step("Setting the title and description");
    // PATCH has no precondition: re-read right before it, so an edit
    // made since (say, the bot's to its bot-meta section) isn't lost.
    const now = await gh.send<RawPullState>("GET", pullPath(d.ref));
    if ((now.body ?? "") !== d.body || (now.title ?? "") !== d.title) {
      throw new Error(`the commits were pushed (${head.slice(0, 12)}), but the title or description changed meanwhile, so yours weren't saved; reload (r) and set them again`);
    }
    try {
      await gh.send("PATCH", pullPath(d.ref), patch);
    } catch (e) {
      throw new Error(`the commits were pushed (${head.slice(0, 12)}), but setting the title and description failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const result: MineResult = { head, titleSet: patch.title !== undefined, bodySet: patch.body !== undefined };
  if (!opts.promote) return result;

  step("Waiting for GitHub to record the push on the PR");
  const pushed = await pushRecordedAt(gh, d.ref, head, sleep);
  if (!pushed) throw new Error(`the commits, title and description were saved, but GitHub hasn't shown the push on the PR yet, and ${HUMAN_TEXT_LINE} counts only after it. Comment it yourself in a minute.`);
  await sleep(PROMOTE_GAP_MS);
  step(`Commenting ${HUMAN_TEXT_LINE}`);
  let c: { html_url?: string; created_at?: string };
  try {
    c = await gh.send<{ html_url?: string; created_at?: string }>("POST", `/repos/${repo}/issues/${d.ref.number}/comments`, { body: HUMAN_TEXT_LINE });
  } catch (e) {
    throw new Error(`the commits, title and description were saved, but commenting ${HUMAN_TEXT_LINE} failed: ${e instanceof Error ? e.message : String(e)}. Comment it yourself.`);
  }
  if (c.html_url) result.commentUrl = c.html_url;
  // ISO 8601 times compare as strings, as bot-pr compares them.
  if (!c.created_at || c.created_at <= pushed) {
    throw new Error(`${HUMAN_TEXT_LINE} was posted at ${c.created_at ?? "an unknown time"}, not after the push (${pushed}), so promote won't count it. Comment it again.`);
  }
  return result;
}

interface RawIssueEvent {
  event?: string;
  commit_id?: string | null;
  created_at?: string;
}

/** When the PR's timeline shows the push of `head`, polling until it does; undefined if it never did. */
export async function pushRecordedAt(gh: GitHub, ref: IssueRef, head: string, sleep: (ms: number) => Promise<void>): Promise<string | undefined> {
  for (let i = 0; i < PUSH_EVENT_TRIES; i++) {
    if (i > 0) await sleep(PUSH_EVENT_WAIT_MS);
    const events = await gh.getAll<RawIssueEvent>(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/events?per_page=100`);
    const hit = events.data.filter((e) => e.event === "head_ref_force_pushed" && e.commit_id === head).at(-1);
    if (hit?.created_at) return hit.created_at;
  }
  return undefined;
}
