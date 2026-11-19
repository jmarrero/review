// On-demand reads for item links, independent of the needs-you queue.
import type { GitHub } from "./api.ts";
import { type Item, parseItem } from "./board.ts";
import { BOARD_NUMBER, BOARD_OWNER } from "./config.ts";
import { refKey } from "./forge.ts";
import type { RouteInfo } from "./keys.ts";

type ItemRoute = Extract<RouteInfo, { route: "item" }>;

export function findRouteItem(items: readonly Item[], id: string): Item | undefined {
  return items.find((i) => i.nodeId === id || (i.nodeId.startsWith("PVTI_") && i.ref && refKey(i.ref).toLowerCase() === id));
}

interface Content {
  __typename: string;
  id: string;
  title: string;
  body: string;
  url?: string;
  state?: string;
  prState?: string;
  createdAt?: string;
  updatedAt?: string;
  author?: { login: string };
  labels?: { nodes: { name: string }[] };
  assignees?: { nodes: { login: string }[] };
  comments?: { totalCount: number };
  subIssuesSummary?: { total: number; completed: number; percentCompleted: number };
  projectItems?: { nodes: ProjectItem[]; pageInfo: { hasNextPage: boolean } };
}

interface ProjectItem {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  content?: Content;
  project: { number: number; owner: { login: string } };
  fieldValues: { nodes: { text?: string; name?: string; field?: { name: string } }[] };
}

const CONTENT = `__typename id title body createdAt updatedAt`;
const DETAILS = `url author { login } labels(first:100) { nodes { name } } assignees(first:100) { nodes { login } } comments { totalCount }`;
const ISSUE = `${CONTENT} state ${DETAILS} subIssuesSummary { total completed percentCompleted }`;
const PROJECT_ITEM = `id createdAt updatedAt project { number owner { ... on Organization { login } ... on User { login } } }
  fieldValues(first:100) { nodes {
    ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { name } } }
    ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }
  } }`;

function asItem(content: Content, board?: ProjectItem): Item {
  return parseItem({
    id: 0, node_id: board?.id ?? content.id, content_type: content.__typename,
    ...(board?.createdAt ? { created_at: board.createdAt } : {}),
    ...(board?.updatedAt ? { updated_at: board.updatedAt } : {}),
    content: {
      node_id: content.id, title: content.title, body: content.body, html_url: content.url ?? "",
      state: (content.state ?? content.prState)?.toLowerCase() ?? "open",
      ...(content.createdAt ? { created_at: content.createdAt } : {}),
      ...(content.updatedAt ? { updated_at: content.updatedAt } : {}),
      user: content.author ?? null, labels: content.labels?.nodes ?? [], assignees: content.assignees?.nodes ?? [],
      ...(content.comments ? { comments: content.comments.totalCount } : {}),
      ...(content.subIssuesSummary ? { sub_issues_summary: { total: content.subIssuesSummary.total, completed: content.subIssuesSummary.completed, percent_completed: content.subIssuesSummary.percentCompleted } } : {}),
    },
    fields: board?.fieldValues.nodes.flatMap((v) => v.field ? [{ name: v.field.name, value: v.text ?? v.name ?? null }] : []) ?? [],
  });
}

/** One bounded GraphQL read, only when an opened link misses loaded items. */
export async function loadRouteItem(gh: GitHub, route: ItemRoute): Promise<Item> {
  const projects = `projectItems(first:100) { nodes { ${PROJECT_ITEM} } pageInfo { hasNextPage } }`;
  const query = route.ref
    ? `query($owner:String!,$repo:String!,$number:Int!) { repository(owner:$owner,name:$repo) { issue(number:$number) { ${ISSUE} ${projects} } } }`
    // IssueState and PullRequestState are different enums: don't merge their response fields.
    : `query($id:ID!) { node(id:$id) { ... on ProjectV2Item { ${PROJECT_ITEM} content { ... on Issue { ${ISSUE} } ... on PullRequest { ${CONTENT} prState:state ${DETAILS} } ... on DraftIssue { ${CONTENT} } } } ... on Issue { ${ISSUE} ${projects} } } }`;
  const result = await gh.graphql<{ node?: ProjectItem | Content | null; repository?: { issue: Content | null } | null }>(query, route.ref ? { ...route.ref } : { id: route.id });
  const node = route.ref ? result.repository?.issue : result.node;
  if (!node) throw new Error("Item not found or not accessible with this token.");
  if ("fieldValues" in node) {
    if (!node.content) throw new Error("The board item's content is not accessible with this token.");
    return asItem(node.content, node);
  }
  const board = node.projectItems?.nodes.find((p) => p.project.number === BOARD_NUMBER && p.project.owner.login.toLowerCase() === BOARD_OWNER.toLowerCase());
  if (!board && node.projectItems?.pageInfo.hasNextPage) throw new Error("Board membership could not be determined from the first 100 projects.");
  return asItem(node, board);
}
