// Quick capture: his notes for the bot, filed as issues in the tracker
// with CAPTURE_LABEL and added to the board. The label is what the bot
// routes on (bot-notify in homegit): an open tracker issue of his that
// carries it is a request to triage, and the bot removes the label once
// it has. The board add is a convenience on top, so a failed one leaves
// the issue filed and says why.

import { type GitHub, GitHubError } from "./api.ts";
import { type IssueRef, parseIssueUrl } from "./board.ts";
import { BOARD_NUMBER, BOARD_OWNER, BOARD_URL, CAPTURE_LABEL, FIELD, TRACKER_REPO } from "./config.ts";
import { refKey } from "./forge.ts";

/** What he typed into the capture bar. */
export interface CaptureDraft {
  title: string;
  body: string;
  url: string;
  priority?: "P0" | "P1" | "P2";
  epic?: number;
  labels?: string[];
  repo?: string;
}

export const EMPTY_DRAFT: CaptureDraft = { title: "", body: "", url: "" };

/** The issue to create, as POST /repos/{TRACKER_REPO}/issues takes it. */
export interface IssueRequest {
  title: string;
  body: string;
  labels: string[];
  parent?: number;
}

// Pages under an issue or PR (/files, /commits/SHA...) link to it too.
const GITHUB_LINK_RE = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(issues|pull)\/(\d+)(?:\/.*)?$/;

/**
 * The issue or PR a pasted github.com link points at, ignoring its
 * fragment, query and sub-pages; undefined for anything else.
 */
export function linkedRef(url: string): IssueRef | undefined {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" || u.hostname !== "github.com") return undefined;
  const m = GITHUB_LINK_RE.exec(u.pathname);
  return m ? parseIssueUrl(`https://github.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`) : undefined;
}

/** The link field, checked: empty, or an https URL. */
function checkedLink(url: string): string {
  const t = url.trim();
  if (!t) return "";
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    throw new Error(`"${t}" isn't a URL.`);
  }
  if (u.protocol !== "https:") throw new Error("The link must be an https URL.");
  return u.href;
}

/** The title a link suggests: `owner/repo#N: its title`, or just the reference. */
export function linkTitle(ref: IssueRef, title?: string): string {
  const t = title?.trim();
  return t ? `${refKey(ref)}: ${t}` : refKey(ref);
}

/**
 * The issue a draft files: his title (else the linked issue's
 * reference), his text, and the link on a line of its own, where GitHub
 * renders it as a link (a reference card, for an issue or PR).
 */
export function captureRequest(draft: CaptureDraft): IssueRequest {
  const link = checkedLink(draft.url);
  const ref = link ? linkedRef(link) : undefined;
  const title = draft.title.replace(/\s*[\r\n]+\s*/g, " ").trim() || (ref ? linkTitle(ref) : "");
  if (!title) throw new Error("Type a title first (or paste a GitHub link).");
  const repo = draft.repo?.trim() ?? "";
  if (repo && !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw new Error("Repo must be owner/repo.");
  if (repo.split("/")[1] === "." || repo.split("/")[1] === "..") throw new Error("Repo must be owner/repo.");
  const labels = [...new Set([CAPTURE_LABEL, ...(draft.labels ?? []).map((l) => l.trim()).filter(Boolean)])];
  if (labels.includes("dispatch") && !repo) throw new Error("Repo is required for dispatch.");
  if (draft.priority && !["P0", "P1", "P2"].includes(draft.priority)) throw new Error("Choose Priority P0, P1 or P2.");
  if (draft.epic !== undefined && (!Number.isSafeInteger(draft.epic) || draft.epic <= 0)) throw new Error("Choose an epic issue.");
  const metadata = [draft.priority ? `Priority: ${draft.priority}` : "", repo ? `Repo: ${repo}` : ""].filter(Boolean).join("\n");
  const body = [draft.body.trim(), link, metadata].filter(Boolean).join("\n\n");
  return { title, body, labels, ...(draft.epic !== undefined ? { parent: draft.epic } : {}) };
}

/** The filed issue, and why it isn't on the board, if it isn't. */
export interface Filed {
  number: number;
  url: string;
  /** Set when the board add failed: the issue is filed regardless. */
  boardError?: string;
  parentError?: string;
  /** The item is on the board, but its requested Priority wasn't confirmed. */
  priorityError?: string;
}

interface CreatedIssue {
  id: number;
  number: number;
  html_url: string;
}

/** A lost response to creation cannot safely be retried as a new issue. */
export class CaptureUncertain extends Error {
  override name = "CaptureUncertain";
}

/** What a failed board add means, and what the token lacks. */
export const BOARD_ADD_HELP =
  `The bot adds it when it triages the issue. For this app to add it (to ${BOARD_URL}), the token needs the project scope, or on a fine-grained token the organization's Projects: read and write.`;

interface ProjectPriority {
  id: string;
  field: { id: string; options: { id: string; name: string }[] } | null;
}

/** Resolve field and option IDs by name; neither their IDs nor ordering are fixed. */
async function setCapturePriority(gh: GitHub, itemId: string, priority: NonNullable<CaptureDraft["priority"]>): Promise<void> {
  const result = await gh.graphql<{ organization: { projectV2: ProjectPriority | null } | null }>(
    `query CapturePriority($owner: String!, $number: Int!, $field: String!) {
      organization(login: $owner) {
        projectV2(number: $number) {
          id
          field(name: $field) {
            ... on ProjectV2SingleSelectField { id options { id name } }
          }
        }
      }
    }`,
    { owner: BOARD_OWNER, number: BOARD_NUMBER, field: FIELD.priority },
  );
  const project = result.organization?.projectV2;
  const field = project?.field;
  if (!project || !field?.id || !field.options) throw new Error(`The board has no single-select field named "${FIELD.priority}".`);
  const option = field.options.find((option) => option.name === priority);
  if (!option) throw new Error(`The board's ${FIELD.priority} field has no option named "${priority}".`);
  const itemsPath = `/orgs/${BOARD_OWNER}/projectsV2/${BOARD_NUMBER}/items`;
  const staleItems = (url: string) => new URL(url).pathname.startsWith(itemsPath);
  gh.cache.invalidate(staleItems);
  let updated: { updateProjectV2ItemFieldValue: { projectV2Item: { id: string } } | null };
  try {
    updated = await gh.graphql(
      `mutation CaptureSetPriority($project: ID!, $item: ID!, $field: ID!, $option: String!) {
        updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) {
          projectV2Item { id }
        }
      }`,
      { project: project.id, item: itemId, field: field.id, option: option.id },
    );
  } finally {
    gh.cache.invalidate(staleItems);
  }
  if (updated.updateProjectV2ItemFieldValue?.projectV2Item.id !== itemId) throw new Error("GitHub didn't confirm the item's Priority update.");
}

/**
 * File a draft: create the issue, then add it to the board over REST
 * (an organization's project takes items there). A selected Priority
 * updates its single-select field using the existing GraphQL write
 * conventions. Failed follow-up writes never undo the created issue.
 */
export async function fileCapture(gh: GitHub, draft: CaptureDraft): Promise<Filed> {
  const { parent, ...req } = captureRequest(draft);
  if (parent !== undefined) {
    const epic = await gh.send<{ state: string; labels: { name: string }[]; pull_request?: unknown }>("GET", `/repos/${TRACKER_REPO}/issues/${parent}`);
    if (epic.state !== "open" || epic.pull_request || !epic.labels.some((label) => label.name === "epic")) throw new Error("The selected epic must be an open tracker issue labelled epic. Reselect it before filing.");
  }
  let issue: CreatedIssue;
  try {
    issue = await gh.send<CreatedIssue>("POST", `/repos/${TRACKER_REPO}/issues`, req);
  } catch (e) {
    if (e instanceof GitHubError && e.status >= 400 && e.status < 500 && e.status !== 408) throw e;
    throw new CaptureUncertain(`${e instanceof Error ? e.message : String(e)}. The issue may have been created. Check the tracker before reloading to retry.`);
  }
  const filed: Filed = { number: issue.number, url: issue.html_url };
  if (parent !== undefined) {
    try {
      await gh.send("POST", `/repos/${TRACKER_REPO}/issues/${parent}/sub_issues`, { sub_issue_id: issue.id });
    } catch (e) {
      filed.parentError = `${e instanceof Error ? e.message : String(e)}. Attach the filed issue to epic #${parent} on GitHub; do not file it again.`;
    }
  }
  let item: { node_id?: string } | undefined;
  try {
    item = await gh.send<{ node_id?: string }>("POST", `/orgs/${BOARD_OWNER}/projectsV2/${BOARD_NUMBER}/items`, { type: "Issue", id: issue.id });
  } catch (e) {
    filed.boardError = `${e instanceof Error ? e.message : String(e)}. ${BOARD_ADD_HELP}`;
  }
  if (draft.priority && !filed.boardError) {
    try {
      if (!item?.node_id) throw new Error("GitHub returned no board item node ID.");
      await setCapturePriority(gh, item.node_id, draft.priority);
    } catch (e) {
      filed.priorityError = `${e instanceof Error ? e.message : String(e)}. The issue is filed on the board; check or set Priority ${draft.priority} there. Do not file it again.`;
    }
  }
  return filed;
}

export interface CaptureEpic {
  number: number;
  title: string;
}

/** Paginated, conditional reads use the client's existing response cache. */
export async function loadCaptureLabels(gh: GitHub): Promise<string[]> {
  const path = `/repos/${TRACKER_REPO}/labels?per_page=100`;
  const result = await gh.getAll<{ name: string }>(path).catch(() => gh.cacheOnly().getAll<{ name: string }>(path));
  return result.data.map((label) => label.name).sort();
}

export async function loadCaptureEpics(gh: GitHub): Promise<CaptureEpic[]> {
  const path = `/repos/${TRACKER_REPO}/issues?state=open&labels=epic&per_page=100`;
  const result = await gh.getAll<CaptureEpic & { pull_request?: unknown }>(path).catch(() => gh.cacheOnly().getAll<CaptureEpic & { pull_request?: unknown }>(path));
  return result.data.filter((issue) => !issue.pull_request).map(({ number, title }) => ({ number, title }));
}

/** The title of a linked issue or PR, to suggest one; undefined if it can't be read. */
export async function loadLinkTitle(gh: GitHub, ref: IssueRef): Promise<string | undefined> {
  try {
    const r = await gh.get<{ title?: string }>(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`);
    return r.data.title;
  } catch {
    return undefined;
  }
}
