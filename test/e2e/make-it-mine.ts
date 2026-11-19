// End-to-end check of "Make it mine" against a real scratch PR: runs
// saveMine with a real token, then reads back what `bot-pr promote`
// checks for a human-text approval (see human_text_problems in homegit's
// bin/bot-pr): who pushed the new head per the fork's activity log, who
// set the title last, who made the body's last edit, and the comment.
//
// It writes to the PR, so use a throwaway one, e.g. a draft PR from a
// bot/ branch in a cgwalters-forge fork with a bot-meta section. Run it
// with a token of the login that should own the text (the bot's own
// stands in for cgwalters' in tests); it only imports the app's
// dependency-free modules, so no install is needed:
//
//   GH_TOKEN=... node test/e2e/make-it-mine.ts https://github.com/cgwalters-forge/REPO/pull/N "Committer Name" committer@example.com
//
// Then `bot-pr promote --dry-run URL`, with its REVIEWER set to that
// login, should report no policy refusal.

import { GitHub } from "../../src/github/api.ts";
import { parseIssueUrl } from "../../src/github/board.ts";
import { hasGeneratedBy, HUMAN_TEXT_LINE, type MineEdit, saveMine, splitBody } from "../../src/github/mine.ts";
import { loadPrDetail } from "../../src/github/prs.ts";

const ACTIVITY_TRIES = 10;

/** The text without its Generated-by lines: the e2e's stand-in for his rewrite. */
const mine = (text: string) =>
  text
    .split(/\r?\n/)
    .filter((l) => !hasGeneratedBy(l))
    .join("\n")
    .trimEnd();
const ACTIVITY_WAIT_MS = 3000;

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const [url, name, email] = process.argv.slice(2);
const token = process.env.GH_TOKEN ?? fail("set GH_TOKEN");
if (!url || !name || !email) fail("usage: make-it-mine.ts PR_URL COMMITTER_NAME COMMITTER_EMAIL");
const ref = parseIssueUrl(url) ?? fail(`not a PR URL: ${url}`);
const gh = new GitHub(async () => token);
const login = (await gh.get<{ login: string }>("/user")).data.login;
const repo = `${ref.owner}/${ref.repo}`;
const stamp = new Date().toISOString();

const d = await loadPrDetail(gh, ref);
const edit: MineEdit = {
  title: `scratch: make-it-mine e2e ${stamp}`,
  body: `${mine(splitBody(d.body).text)}\n\nRewritten by the e2e test at ${stamp}.`,
  messages: new Map(d.commits.map((c) => [c.sha, `${mine(c.message)}\n\nReworded by the e2e test at ${stamp}.`])),
};
console.log(`${repo}#${ref.number}: ${d.commits.length} commits, head ${d.head.slice(0, 12)}, as ${login}`);
const r = await saveMine(gh, d, edit, { committer: { name, email }, ownText: true, promote: true, progress: (s) => console.log(`- ${s}`) });
console.log(`new head ${r.head}, comment ${r.commentUrl ?? "(none)"}`);

const problems: string[] = [];
const after = await loadPrDetail(gh, ref);
if (after.head !== r.head) problems.push(`the PR's head is ${after.head}, not ${r.head}`);
for (const [i, c] of after.commits.entries()) {
  const g = (await gh.get<{ tree: { sha: string }; committer: { name: string; email: string }; author: { email: string } }>(`/repos/${repo}/git/commits/${c.sha}`)).data;
  const o = (await gh.get<{ tree: { sha: string }; author: { email: string } }>(`/repos/${repo}/git/commits/${d.commits[i]?.sha}`)).data;
  if (g.tree.sha !== o.tree.sha) problems.push(`commit ${i} has tree ${g.tree.sha}, was ${o.tree.sha}`);
  if (g.author.email !== o.author.email) problems.push(`commit ${i} has author ${g.author.email}, was ${o.author.email}`);
  if (g.committer.name !== name || g.committer.email !== email) problems.push(`commit ${i} has committer ${g.committer.name} <${g.committer.email}>`);
}

// The activity log can lag the push by a few seconds.
let pusher: string | undefined;
for (let i = 0; i < ACTIVITY_TRIES && !pusher; i++) {
  const log = await gh.send<{ after?: string; actor?: { login?: string }; activity_type?: string }[]>(
    "GET",
    `/repos/${repo}/activity?ref=${encodeURIComponent(`refs/heads/${after.headRef}`)}&direction=desc&per_page=100`,
  );
  const hit = log.find((a) => a.after === r.head);
  if (hit) pusher = `${hit.actor?.login} (${hit.activity_type})`;
  else await new Promise((res) => setTimeout(res, ACTIVITY_WAIT_MS));
}
if (!pusher?.startsWith(`${login} `)) problems.push(`the push of ${r.head.slice(0, 12)} is by ${pusher ?? "no one in the activity log"}, not ${login}`);

const timeline = await gh.send<{ event?: string; actor?: { login?: string }; rename?: { to?: string } }[]>("GET", `/repos/${repo}/issues/${ref.number}/timeline?per_page=100`);
const rename = timeline.filter((e) => e.event === "renamed").at(-1);
if (rename?.actor?.login !== login || rename.rename?.to !== after.title) problems.push(`the title was last set by ${rename?.actor?.login ?? "no one"}`);

const edits = await gh.send<{ data?: { repository?: { pullRequest?: { userContentEdits?: { nodes?: { editor?: { login?: string } }[] } } } } }>("POST", "/graphql", {
  query: "query($o: String!, $n: String!, $p: Int!) { repository(owner: $o, name: $n) { pullRequest(number: $p) { userContentEdits(first: 1) { nodes { editor { login } } } } } }",
  variables: { o: ref.owner, n: ref.repo, p: ref.number },
});
const editor = edits.data?.repository?.pullRequest?.userContentEdits?.nodes?.[0]?.editor?.login;
if (editor !== login) problems.push(`the body was last edited by ${editor ?? "no one"}`);

const comments = await gh.send<{ user?: { login?: string }; body?: string }[]>("GET", `/repos/${repo}/issues/${ref.number}/comments?per_page=100`);
if (!comments.some((c) => c.user?.login === login && c.body === HUMAN_TEXT_LINE)) problems.push(`no ${HUMAN_TEXT_LINE} comment by ${login}`);

console.log(`pushed by: ${pusher ?? "?"}; title by: ${rename?.actor?.login ?? "?"}; body by: ${editor ?? "?"}`);
if (problems.length) fail(problems.join("; "));
console.log("OK: GitHub records the push, the title and the body edit as the token's user");
