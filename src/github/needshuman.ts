// The concrete failure this stops: an incomplete or failed publication
// leaving Act now empty while a labelled operator decision blocks work
// (#305). It is a read, never a write: the label alone does not establish
// a question, an answer or permission to release the hold.
import type { GitHub } from "./api.ts";
import { parseIssueUrl } from "./board.ts";
import { FORGE_ORG, PAGE_SIZE } from "./config.ts";

export const NEEDS_HUMAN_LABEL = "needs-human";

/** The app's existing scope, the forge organization; never wider. */
export const NEEDS_HUMAN_QUERY = `is:issue is:open label:${NEEDS_HUMAN_LABEL} org:${FORGE_ORG}`;

/** At most this many search pages (of PAGE_SIZE) per read. */
export const NEEDS_HUMAN_PAGES = 3;

export const NEEDS_HUMAN_SEARCH_URL = `https://github.com/search?type=issues&q=${encodeURIComponent(NEEDS_HUMAN_QUERY)}`;

export interface LabelledIssue {
  /** Canonical identity: `owner/repo#n`, lowercased. */
  key: string;
  item: string;
  title: string;
  url: string;
}

export interface NeedsHumanRead {
  issues: readonly LabelledIssue[];
  /** Why the issues may not be all of them: a failed page, cap or incomplete search. */
  partial?: string;
  /** Why nothing could be read; `issues` is then empty and says nothing about whether any exist. */
  error?: string;
}

interface SearchIssue {
  html_url?: unknown;
  title?: unknown;
  pull_request?: unknown;
}

export const issueKey = (repository: string, number: number): string => `${repository}#${number}`.toLowerCase();

/** One bounded search; keep known decisions if a later page cannot be read. */
export async function loadNeedsHuman(gh: GitHub): Promise<NeedsHumanRead> {
  const issues = new Map<string, LabelledIssue>();
  const notes: string[] = [];
  let malformed = false;
  let total = 0;
  for (let page = 1; page <= NEEDS_HUMAN_PAGES; page++) {
    let data: { items?: SearchIssue[]; total_count?: number; incomplete_results?: boolean };
    try {
      ({ data } = await gh.get<typeof data>(
        `/search/issues?q=${encodeURIComponent(NEEDS_HUMAN_QUERY)}&sort=created&order=asc&per_page=${PAGE_SIZE}&page=${page}`));
      if (!Array.isArray(data?.items)) throw new Error("GitHub's search response has no valid items array");
    } catch (e) {
      if (page === 1) throw e;
      notes.push(`Could not read search page ${page}; only earlier pages are shown`);
      break;
    }
    const items = data.items!;
    total = Math.max(total, data.total_count ?? 0);
    if (data.incomplete_results && !notes.length) notes.push("GitHub's search returned incomplete results");
    for (const raw of items) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)
        || typeof raw.html_url !== "string" || (raw.title != null && typeof raw.title !== "string")) {
        malformed = true;
        continue;
      }
      const url = raw.html_url;
      const ref = raw.pull_request || !url?.includes("/issues/") ? undefined : parseIssueUrl(url);
      // Only issues, and only in the configured organization.
      if (!url || !ref || ref.owner.toLowerCase() !== FORGE_ORG.toLowerCase()) continue;
      const key = issueKey(`${ref.owner}/${ref.repo}`, ref.number);
      issues.set(key, { key, item: `${ref.owner}/${ref.repo}#${ref.number}`, title: raw.title?.trim() || "(no title)", url });
    }
    if (items.length < PAGE_SIZE) break;
    if (page === NEEDS_HUMAN_PAGES && total > page * PAGE_SIZE) notes.push(`read the first ${page * PAGE_SIZE} of ${total}`);
  }
  if (malformed) notes.push("Some search records could not be read");
  return { issues: [...issues.values()].sort((a, b) => a.key.localeCompare(b.key, "en", { numeric: true })), ...(notes.length ? { partial: notes.join("; ") } : {}) };
}
