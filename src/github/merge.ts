// Merge only the confirmed head, through GitHub's policy-enforcing endpoints.
// No auto-merge or administrator bypass: a queue admission is not a merge receipt.
import { GitHubError, type GitHub } from "./api.ts";
import { asOperator, MaybeSentError } from "./backend.ts";
import type { IssueRef } from "./board.ts";

const PREFLIGHT = `query($owner:String!,$repo:String!,$number:Int!) {
  repository(owner:$owner,name:$repo) {
    squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed
    pullRequest(number:$number) {
      id url state isDraft headRefOid mergeStateStatus viewerCanUpdate isMergeQueueEnabled
      mergeQueueEntry { id }
    }
  }
}`;
const ENQUEUE = `mutation($id:ID!,$head:GitObjectID!) {
  enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head}) {
    mergeQueueEntry { id }
  }
}`;

interface MergeRepository {
  squashMergeAllowed: boolean;
  mergeCommitAllowed: boolean;
  rebaseMergeAllowed: boolean;
  pullRequest: {
    id: string; url: string; state: string; isDraft: boolean; headRefOid: string;
    mergeStateStatus: string; viewerCanUpdate: boolean;
    mergeQueueEntry: { id: string } | null;
    isMergeQueueEnabled: boolean;
  } | null;
}

export interface MergeResult { state: "merged" | "enqueued"; url: string }

function confirmedQueueEntry(entry: unknown): boolean {
  return typeof entry === "object" && entry !== null && "id" in entry && typeof entry.id === "string" && entry.id.trim().length > 0;
}

/** Fresh, uncached preflight and policy check, then one SHA-bound write as the viewer. */
export async function mergeOrEnqueue(gh: GitHub, ref: IssueRef, head: string, policy: () => void): Promise<MergeResult> {
  return asOperator(gh, async () => {
    if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("No full head SHA; inspect the PR again.");
    policy();
    const read = await gh.send<{ data?: { repository: MergeRepository | null }; errors?: unknown[] }>("POST", "/graphql", {
      query: PREFLIGHT, variables: { owner: ref.owner, repo: ref.repo, number: ref.number },
    });
    const repository = read.data?.repository;
    const pr = repository?.pullRequest;
    if (read.errors?.length || !repository || !pr) throw new Error("Cannot read current merge policy; nothing sent.");
    if (pr.headRefOid !== head) throw new Error("PR head moved; reload and confirm the new head.");
    if (pr.state !== "OPEN" || pr.isDraft || !pr.viewerCanUpdate || typeof pr.isMergeQueueEnabled !== "boolean") throw new Error("PR is not an open, non-draft PR you may merge.");
    policy();
    if (pr.mergeQueueEntry !== null) {
      if (!confirmedQueueEntry(pr.mergeQueueEntry)) throw new Error("Cannot read current queue entry; nothing sent.");
      return { state: "enqueued", url: pr.url };
    }
    const queue = pr.isMergeQueueEnabled;
    // BLOCKED can mean the required queue itself. Queue admission enforces
    // current rules; never retry a refused enqueue as a direct merge.
    if (!(queue ? ["CLEAN", "BLOCKED", "BEHIND"].includes(pr.mergeStateStatus) : pr.mergeStateStatus === "CLEAN")) throw new Error(`Merge not ready: ${pr.mergeStateStatus}.`);
    const method = repository.squashMergeAllowed ? "squash" : repository.mergeCommitAllowed ? "merge" : repository.rebaseMergeAllowed ? "rebase" : undefined;
    if (!queue && !method) throw new Error("No permitted merge method.");
    try {
      if (queue) {
        const result = await gh.send<{ data?: { enqueuePullRequest?: { mergeQueueEntry?: { id: string } } }; errors?: unknown[] }>("POST", "/graphql", { query: ENQUEUE, variables: { id: pr.id, head } });
        if (result.errors?.length || !confirmedQueueEntry(result.data?.enqueuePullRequest?.mergeQueueEntry)) throw new MaybeSentError("Queue admission was not confirmed; inspect GitHub before retrying.");
        return { state: "enqueued", url: pr.url };
      }
      const result = await gh.send<{ merged: boolean; message: string }>("PUT", `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/merge`, { sha: head, merge_method: method });
      if (typeof result?.merged !== "boolean") throw new MaybeSentError("Merge was not confirmed; inspect GitHub before retrying.");
      if (!result.merged) throw new GitHubError(409, `Not merged: ${result.message}`);
      return { state: "merged", url: pr.url };
    } catch (e) {
      if (e instanceof GitHubError && e.status >= 400 && e.status < 500) throw e;
      throw new MaybeSentError(e instanceof Error ? e.message : String(e));
    }
  });
}
