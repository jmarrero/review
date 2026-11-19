# Command UI: a forge-native operator cockpit

> This text is LLM generated.

Status: **proposal**, researched 2026-10-03. **Recommendation:** keep the
TypeScript client, introduce board-scoped navigation, and ship Command first.
Evaluate one Rust/WASM view after the navigation and data contract settle.
Observations below describe inspected code or published sources; everything
labelled proposal describes future work.

The sidebar plan is superseded by [tracker#976](https://github.com/cgwalters-forge/tracker/issues/976) and [tracker#1414](https://github.com/cgwalters-forge/tracker/issues/1414).

## 1. Architecture and the Paperclip comparison

**Observed here.** The [documentation](index.md) describes the running GitHub v0.
It also claims Forgejo support, but current `src/` and [build.ts](../build.ts)
implement/build only the GitHub app.
[main.ts](../src/github/main.ts), [homeview.ts](../src/github/homeview.ts) and
[sections.ts](../src/github/sections.ts) implement a single-page dashboard:
Decisions, Status, Focus, Agents, Changes, By priority and Usage. It uses
[strict TypeScript](../tsconfig.json), [direct DOM construction](../src/dom.ts)
and [esbuild](../build.ts). The [chat hook](../src/github/chat.ts) returns
`undefined`; “Ask anything” currently files tracker issues. ProjectV2 items
are read through REST, status updates through GraphQL. The
[static shell](../static/index.html) and [CSS](../static/style.css) implement
the current responsive layout. The old [design](design.md) contains proposals,
including hosting and Forgejo directions; these are not evidence of deployed
features. Only the GitHub entry point is built today.

**Observed in Paperclip's published material.** The [site](https://paperclip.ing),
[README](https://raw.githubusercontent.com/paperclipai/paperclip/master/README.md),
[product walkthrough](https://paperclip.ing/product/) and
[dashboard guide](https://docs.paperclip.ing/guides/day-to-day/dashboard/)
describe an integrated control plane: its own companies, tracker, goals,
human/agent identities, reporting lines, permissions, heartbeat execution,
budgets, approvals and activity history. It is a Node.js server with a React
UI, PostgreSQL (embedded locally or external), and local/S3-compatible file
storage. Agent API keys and run JWTs are distinct from human memberships;
managed connections can attribute supported operations to a responsible user.
The README qualifies budget stops: recorded spend and in-flight usage can
delay enforcement, despite the site's simpler “hard limits” wording.

The [dashboard screenshot](https://docs.paperclip.ing/user-guides/screenshots/dark/dashboard/dashboard-overview.png)
shows a persistent company sidebar, separate Decisions and Projects entries,
live agent cards, budget incidents and summary counts. Borrow its stable
navigation and quick health/attention scan. Do not copy its entire company
administration tree. Research covered written walkthroughs and the screenshot;
**the full-tour.webm video could not be watched**, so no timing, animation or
interaction claims are inferred from it. These are source observations, not
results from independently testing a Paperclip installation.

**Observed in homegit.** Its [README](https://github.com/cgwalters-bot/homegit)
puts the forge board, issues and PRs in charge. The
[coordinator](https://raw.githubusercontent.com/cgwalters-bot/homegit/main/dotfiles/.agents/skills/coordinator/SKILL.md)
handles judgment; the
[dispatcher](https://raw.githubusercontent.com/cgwalters-bot/homegit/main/dotfiles/.agents/skills/dispatcher/SKILL.md)
handles mechanical reconciliation and escalates on tracker issues. The
[scheduled-dispatcher design](https://raw.githubusercontent.com/cgwalters-bot/homegit/main/docs/scheduled-dispatcher.md)
explicitly says a hosted controller does not yet exist. Its level-triggered
scheduled/event-driven Actions job is a target, not a current service.
The newer [devspace run contract](https://raw.githubusercontent.com/cgwalters-bot/homegit/main/docs/devspace-agent-runs.md)
specifies `agent.yml`, credential-free agent execution, run summaries and
capped safe-outputs validated on a fresh runner and again at apply. It
supersedes the scheduled design's older `agent-out` artifact reference.
The run contract still reports open egress; safe-output validation does not
establish complete network containment.

**Proposal: authoritative work stays on the forge.** Boards, issues and PRs
are the only authoritative work store/control plane; git holds reviewed code
and policy, Actions holds execution evidence. The UI is a projection and an
operator client, not another tracker, scheduler or approval database. Existing
browser caches, unsent drafts and seen snapshots are disposable local state;
homegit's local sweep files and expiring run artifacts are execution state,
not replacement work records. Persist important outcomes on the issue/PR.

```text
Operator browser -- own token --> Forge boards / issues / PR reviews
                                      ^                  |
                         trusted controller / apply      | work brief
                                      ^                  v
                         validated safe-outputs <-- sandboxed agent run
                                      |
                         tested draft PR --> independent review
                                      |
                         operator exact-head approval --> upstream/signoff
```

No forge write credentials belong in an agent sandbox. The browser's token
does not dispatch an unrestricted agent. Applying a patch proposes a draft PR,
not a merge. Upstream promotion and DCO sign-off require the verified operator
approval of the exact head, through the existing tools. Harness PRs follow
homegit's separate standing rule: independent review of that head plus green
CI, with authority/credential/containment changes escalated to the operator.
UI cards must distinguish “run succeeded”, “patch validated”, “reviewed” and
“approved”; none implies the next.

| Paperclip concept | Forge-native counterpart (proposal where not already present) |
| --- | --- |
| Company | Forge organization/operator boundary; not an invented UI tenant |
| Project | A literal GitHub ProjectV2 board now; a Forgejo project board later |
| Goal | Epic issue with rationale and acceptance criteria; nested goals become sub-issues |
| Issue | Forge issue/sub-issue, linked PR and board item; no synchronized shadow ticket |
| Agent | Actions run or heartbeat worker attached to an item, with engine and placement |
| Role | Coordinator/dispatcher/reviewer responsibilities; `Lead` records ownership, not authorization |
| Budget | `Est. cost`, `Budget tokens`, `Actual tokens`; run AIC/token caps and private plan usage |
| Approval | Issue answer or exact-head PR review; operator promotion/signoff and independent harness review |

Paperclip's strengths are coherent identity, atomic checkout, goal context,
budget incidents and a durable activity trail in one product. Its tradeoff
here is a second tracker and policy system alongside the forge. The forge
model uses existing collaboration, review authorship, CI and issue URLs,
and keeps the operator's review in the same place as the code. Its gaps are
distributed telemetry, expiring artifacts, incomplete board field history,
and no settled per-role execution identity. `Budget tokens` is planning and
escalation state, not proof of a hard runtime stop; display run caps separately.

Identity remains open in [tracker#304](https://github.com/cgwalters-forge/tracker/issues/304):
GitHub Apps per role give real attribution and scoped permissions; labels and
fields express routing but cannot by themselves enforce access control.
A hybrid is plausible, with enforcement in the trusted dispatcher/apply step.
Do not present a `Lead` chip as a security boundary. Multiple per-project
boards improve focus but introduce overlapping items, field differences and
cross-board dependencies. A global Workstream board can coexist with focused
boards; selecting one must not claim exclusive ownership of its issues.

## 2. Navigation and exact read contract

**Proposal.** The sidebar's **Projects** list contains only forge
project boards, not repositories, themes or epics. Show approximately five
board links, then **View all**. Within the selected board show five destinations:
**Command** (status + Decisions), **Epics / focus areas**, **Agents / runs**,
**Activity**, **Backlog**. Command has roughly five rows per preview with
View all, plus compact agent health and private Usage disclosure. Preserve
existing action forms and review panes. Backlog carries priority, Theme and
Verdict filters; Activity brings together Changes and run outcomes.

```text
Desktop
+------------------------+------------------------------------------+
| Projects               | Workstream / Command      refreshed 20s |
| > Workstream            | + File note                              |
|   Composefs Stable      | Status: latest update [Expand]           |
|   ... (up to five)      | Decisions (8)                            |
|   View all              | P0 Answer ...                            |
|                        | P1 Review ... (about five) [View all]    |
| Selected board         | Focus: epic / progress / blocker         |
| > Command              | Agents: 3 confirmed / target 4           |
|   Epics / focus areas   | Usage [private, Expand]                  |
|   Agents / runs         |                                          |
|   Activity              | Row opens existing issue or PR pane     |
|   Backlog               |                                          |
+------------------------+------------------------------------------+

Phone: drawer closed                 Phone: drawer open
+----------------------------+       +----------------------------+
| [Menu] Workstream / Command |       | Projects             [Close]|
| + File   refreshed 20s     |       | > Workstream               |
| Status [Expand]            |       |   Composefs Stable         |
| Decisions (8)              |       |   ... five / View all      |
| P0 Answer ...              |       | Command                    |
| P1 Review ...              |       | Epics / focus areas        |
| ... five / View all        |       | Agents / runs              |
| Focus / Agents / Usage     |       | Activity / Backlog         |
+----------------------------+       +----------------------------+
```

Use the same navigation DOM in a modal phone drawer: labelled toggle,
`aria-expanded`, focus containment, Escape/Close, restored focus and large tap
targets. Selection closes the drawer. URL routes encode forge, owner kind,
owner, board number and view; old hashes default to Workstream. Back and
forward work. Keep an unsent form mounted or explicitly resolve navigation
before replacing it. Key all in-memory results and existing caches/snapshots
by viewer + forge + board; ignore late responses from a previous selection.
The selection is stored in the URL; it doesn't need a new storage service
or durable UI model.

### Reads by destination

This is a proposed API contract, **not API calls performed during research**.
All GitHub requests use `https://api.github.com`, the viewer's token and the
existing [API client](../src/github/api.ts). `{R}` is `owner/repo`, `{N}` an
issue/PR number, `{D}` the configured runs repository, `{I}` a run id. Follow
REST Link pagination (`per_page=100`) and GraphQL cursors; previews truncate
rendering, not membership or counts. Bound expensive detail reads and label
partial results. Names/field IDs are discovered per board, never reused from
Workstream. Missing optional fields show unknown; a board without required
workstream fields gets a readable capability warning rather than guessed state.

**Projects sidebar / View all (new).** `POST /graphql` with this read-only
query, using `organization` or `user` according to owner kind:

```graphql
query Boards($owner: String!, $after: String) {
  organization(login: $owner) {
    projectsV2(first: 100, after: $after) {
      nodes { id number title url closed }
      pageInfo { hasNextPage endCursor }
    }
  }
}
```

For a user board replace `organization(login: $owner)` with `user(login:
$owner)`; its status query follows the same substitution. Discovery is for
configured owners, not a search of all GitHub. Hide closed boards by default.
Workstream is the initial configured org board; user-owned focused boards
remain readable even though bot App write support differs.

**Shared board read (existing org implementation, generalized proposal).**
`GET /orgs/{owner}/projectsV2/{number}/fields?per_page=100`, then
`GET /orgs/{owner}/projectsV2/{number}/items?per_page=100&fields={comma-separated-ids}`.
Read Status, Priority, Why, Org, Branch, Gist, Theme, Verdict, Verdict target,
Lead, News, Run and Engine. Add optional budget fields to the parser: they
are not currently parsed by [board.ts](../src/github/board.ts). For user-owned
boards propose the GraphQL fallback `user(login:$owner).projectV2(number:$n)`:
page `fields(first:100,after:$f)` with `ProjectV2Field` and
`ProjectV2SingleSelectField` fragments (`id name`, plus `options { id name }`);
page `items(first:100,after:$i)` with `id isArchived createdAt updatedAt`,
`content` fragments for Issue/PullRequest/DraftIssue (`title body`, issue/PR
`url state repository { nameWithOwner }`, issue labels/assignees, PR `headRefOid`),
and `fieldValues(first:100,after:$v)` fragments for text, number and single
select (`field { ... on ProjectV2FieldCommon { id name } }`, and respectively
`text`, `number`, `name optionId`). Page nested connections too and normalize
node IDs rather than pretending they are numeric REST IDs. This fallback
needs fixture/schema verification before user boards ship.

| Destination | Exact additional reads and derivation |
| --- | --- |
| **Command** | Status: `POST /graphql`, `organization(login:$owner).projectV2(number:$n).statusUpdates(first:1,orderBy:{field:CREATED_AT,direction:DESC}) { nodes { body createdAt } }` (as in [backend.ts](../src/github/backend.ts)). Decisions: `GET /repos/{tracker}/issues?labels=question&state=open&per_page=100`, plus `labels=escalate&assignee={operator}&state=open&per_page=100`; comments via `/repos/{R}/issues/{N}/comments?per_page=100` establish unanswered state. PR requests: `GET /search/issues?q={encoded is:pr is:open draft:false user-review-requested:OPERATOR}&sort=created&order=asc&per_page=100&page={p}`; also reuse the existing bot draft/open-PR searches in [prs.ts](../src/github/prs.ts). Read `/repos/{R}/pulls?state=open&per_page=100`, `/repos/{R}/pulls/{N}/reviews?per_page=100` and `/repos/{R}/issues/{N}/timeline?per_page=100` for current head, verdict and request age. Join by board content/Branch URL or blocked parent/`Blocks:` relation, never just repository name. Keep unassociated asks in an explicitly global Workstream fallback, not every board. Reuse Focus/Agents reads below for previews; Usage uses the private comments endpoint below. |
| **Epics / focus areas** | Shared board items labelled `epic`, ordered by priority, with issue progress summaries. `GET /repos/{R}/issues/{N}` refreshes epic state/body; `/repos/{R}/issues/{N}/sub_issues?per_page=100` reads children; `/repos/{R}/issues/{N}/comments?per_page=100` reads context. Match children to selected-board items for Status/Run/Lead. Children outside the board remain links, not guessed workstream states. Theme is a fallback focus grouping, not a project. |
| **Agents / runs** | Shared In Progress items plus `GET /repos/cgwalters-forge/tracker/issues/176/comments?per_page=100` (trusted bot heartbeat), intersecting worker item links with this board. `GET /repos/{D}/actions/workflows/agent.yml/runs?per_page=100` and `/repos/{D}/actions/workflows/devspace.yml/runs?per_page=100`; detail `/repos/{D}/actions/runs/{I}` and `/repos/{D}/actions/runs/{I}/jobs?filter=latest&per_page=100`. Join Run URL/item ID, with unrelated devspaces only in labelled global detail. Engine absent means unknown; stale heartbeat workers are unconfirmed, not working capacity. Private Usage: `GET /repos/cgwalters-forge/bot-ops/issues/1/comments?per_page=100`; show unavailable on denied access, never copy it into public status. It is operator-wide, not a per-board spend total. |
| **Activity** | Shared News/current state, selected-item issue comments/timelines and the run reads above. Reuse `GET /repos/{R}/pulls?state=closed&sort=updated&direction=desc&per_page=30` for configured news repositories; `/repos/{R}/pulls/{N}/files?per_page=100` identifies harness changes. `GET /users/{bot}/events/public?per_page=50` is a bounded public pulse, filtered to associated board work. Existing browser snapshot diffs in [boardfeed.ts](../src/github/boardfeed.ts) remain explicitly “since last seen in this browser”; News is only the latest line. This is not an immutable audit history or evidence of every field transition. |
| **Backlog** | Shared board items (including missing Status), excluding archived and Done for the default list; filter locally by priority, Theme and Verdict. `GET /repos/{R}/issues/{N}`, comments/sub-issues as above, and `GET /gists/{id}` for an item's Gist field on demand. Missing/truncated gist content gets a link; no fetch from raw gist hosts under the current CSP. |

**Shared PR detail**, opened from any view, keeps the existing readers in
[prs.ts](../src/github/prs.ts): `GET /repos/{R}` (fork/private metadata),
`GET /repos/{R}/pulls/{N}`, then
`/commits`, `/files`, `/reviews`, `/comments` under that pull path, and issue
comments under `/repos/{R}/issues/{N}/comments` (propose paging every collection).
CI detail reads `/repos/{R}/commits/{head}/check-runs?per_page=100`,
`/repos/{R}/commits/{head}/status` and
`/repos/{R}/rules/branches/{encoded-base}?per_page=100`.
Commit ranges use `/repos/{R}/compare/{base}...{to}?per_page=1`; expanded file
context uses `/repos/{R}/contents/{encoded-path}?ref={head}`. Keep the
head-checked approval and author validation; navigation does not relax them.
Run transcripts/artifact download remain links to Actions initially: artifact
redirect hosts are not allowed by today's CSP, and the app does not yet parse
`summary.json`. Persisted run footers on PRs are available through the PR body.

**Shared sign-in/capture reads:** `GET /user` establishes the viewer. The
existing composer reads `GET /repos/{tracker}/labels?per_page=100` and
`GET /repos/{tracker}/issues?state=open&labels=epic&per_page=100`; a pasted link
reads `GET /repos/{R}/issues/{N}` or `/repos/{R}/pulls/{N}` for its title.
Retain the existing filing flow; selecting a board does not silently change
the tracker or authorize a new dispatch policy.

No new server storage is needed for any destination in the recommended browser
client. The conditional server-held-token design in section 3 adds operational
credentials and session state, even without an application work database;
the forge remains authoritative for work. Reuse visibility-aware
polling, ETags where offered, rate-limit backoff and sign-out cache deletion.
Set an explicit schedule for GraphQL/search reads rather than assuming conditional
caching. Render last-confirmed times, stale/partial/access errors and empty
states independently. Board polling, searches and runs remain about
60s while visible; discovering boards is on selection/refresh, not every tick.

## 3. TypeScript, Rust/WASM and a conditional Datastar server

**Primary recommendation: keep the existing TypeScript browser client for the
initial Command milestones.** Rust/WASM is an optional, bounded sharing
experiment, not a parallel primary implementation. TypeScript is already
strict, has a tested API/cache/review boundary, and directly updates the DOM.
The navigation change does not require a framework. Rust's strongest benefit
here would be sharing typed parsing/derivation with native tools, not making
the browser a more trusted operator. Neither language prevents stale-head
approval, malicious Markdown or a confused authorization rule by itself.

| Option | Fit and cost (proposal assessment, no measured bundle ranking) |
| --- | --- |
| Existing TS/direct DOM | One esbuild pipeline and current tests; lowest migration surface. Large view/state modules still need clear boundaries. |
| Rust axum + Datastar/SSE | Conditional standalone choice if keeping forge credentials server-side becomes a requirement. Native Rust can share parsing/derivation without WASM, but adds server rendering, authenticated sessions and streaming operations; not a static Pages deployment. |
| [Leptos](https://leptos.dev) CSR | Fine-grained reactive DOM suits independently refreshing panels. Best candidate for a read-only island; no server functions/SSR needed for Pages. Adds WASM, generated JS glue and Rust build tooling. |
| [Dioxus](https://dioxuslabs.com) web | Component/state model and cross-platform path are useful if native desktop/mobile becomes a real requirement. That wider toolchain is unnecessary for this browser-only milestone. |
| [Yew](https://yew.rs) | Component/HTML-macro approach is familiar to React/Elm users; viable web client, but replacing existing DOM views still costs migration and interop work. |

Compare release artifacts on the **same** view and fixtures: compressed JS +
WASM + CSS bytes, cold download/compile/startup, cached navigation, memory,
update responsiveness and phone input/focus behavior. Include JS glue and
Markdown/highlighting dependencies, which an island initially retains. No
bundle sizes or speed winners have been measured here. Avoid duplicate UI
runtimes and oversized generated GraphQL schema code.

**Browser boundary.** WASM runs within the same origin and trust model as JS;
it cannot hide a pasted token. Keep authentication/storage in the existing
TS shell and pass a narrow read transport to the island, not a second token
store. Current CSP has `script-src 'self'`,
`connect-src https://api.github.com` and Trusted Types for DOMPurify. A WASM
trial must deliberately add `'wasm-unsafe-eval'` to script-src (not general
`'unsafe-eval'`), allow `'self'` in connect-src to fetch the same-origin WASM,
serve `application/wasm`, and test instantiation under the real policy.
Keep API traffic/token forwarding restricted to the configured forge origin;
allowing same-origin asset fetches must not widen authenticated transport.
Test generated framework DOM operations against Trusted Types; no new raw
HTML rendering path. Neither a Rust framework nor GraphQL needs a backend.

**Conditional standalone option: small Rust axum server with Datastar/SSE.**
Choose this only if server-side forge credentials become a requirement.
Datastar's [getting-started guide](https://data-star.dev/guide/getting_started)
documents `data-*` frontend behavior and backend HTML patches; its
[backend-request guide](https://data-star.dev/guide/backend_requests) describes
streaming element/signal patches over SSE. The optional
[Rust SDK](https://data-star.dev/reference/sdks#rust) helps format those events;
axum is our proposed server choice, not an evaluated integration here. The
server would read the same forge records and render fragments, not become a
second work store. This replaces browser API/rendering logic with shared native
Rust code and server operations; it does not justify migrating the initial UI.

Unlike WASM, axum can keep the forge token out of the browser, but the browser
session still authorizes actions with that token. Authenticate sessions,
validate authorization and protect mutations against CSRF; preserve exact-head
checks. Keep tokens out of HTML/signals. Datastar's
[security reference](https://data-star.dev/reference/security) says signals are
visible and client-modifiable, and requires backend validation. It also says
default expressions require `unsafe-eval`, or CSP mode requires a fresh
server-generated nonce per page; its Trusted Types policy does not sanitize
content. A trial therefore needs an explicit CSP/Trusted Types and sanitized
forge-content integration, not an assumption that today's policy works.

Phone access requires a reachable authenticated server (for example over the
operator's tailnet), not merely a server bound to desktop localhost. SSE
provides live updates, not offline capability; cached views/drafts and reconnect
recovery need separate design. The browser client also needs forge connectivity
for fresh reads and writes; WASM does not change that. Static Pages can host
TS/WASM assets but cannot run axum, render dynamic fragments or serve SSE.
This option needs a standalone service and credential/session operations.

For GraphQL, [graphql_client](https://raw.githubusercontent.com/graphql-rust/graphql-client/main/README.md)
generates variables/responses from checked-in queries and schema, while
[cynic](https://cynic-rs.dev) defines typed Rust fragments and generates queries.
Use graphql_client for the small discovery/status query set first; choose
cynic if reusable fragments justify it. REST remains useful for conditional
board/item reads. Pin schema inputs; builds must not introspect GitHub with
credentials or embed fetched work. Handle partial GraphQL errors and nulls,
permission-limited results, cursors and field-name changes explicitly.

**Share actual homegit Rust logic.**
[bot-poll's library](https://raw.githubusercontent.com/cgwalters-bot/homegit/main/crates/bot-poll/src/lib.rs)
already contains `event_id`, report parsers, `evaluate`/`evaluate_set`,
deduplication and sweep-health derivation. Its
[CLI](https://raw.githubusercontent.com/cgwalters-bot/homegit/main/crates/bot-poll/src/main.rs)
uses filesystem locks, subprocesses, threads and local sweep files: it cannot
be dropped into a browser. Extract a small transport-free core from the
library, feature-gating host logging/config and separating native I/O. Share
only semantics both consumers need, with identical fixtures in native and
WASM tests. The UI still reads forge records; do not add a sweep-file server
solely to reuse a report parser. Homegit's reconcile policy is currently
JavaScript, so “reuse the Rust controller” would be an unsupported claim.

**Incremental trial.** Mount one read-only Rust Agents summary view in a
dedicated DOM root, fed normalized board/heartbeat data by TS. The island owns
only that subtree; dispose it on navigation, cancel stale work, emit ordinary
item links, and fall back to the TS view if loading fails. Keep review/answer
mutations in the established shell. A pure WASM parsing helper alone can
measure sharing, but does not count as evaluating a Rust UI framework.

Testing would retain TS unit/DOM/API-fixture tests, add native core tests and
WASM browser tests, then exercise drawer navigation, focus, unsent forms,
board-switch races, sign-out, denied private usage and stale-head rejection in
real browsers. Current [CI](../.github/workflows/ci.yml) and
[Pages](../.github/workflows/pages.yml) run `npm ci && npm run check` on Node 24;
Pages publishes `dist/` with no work data or secrets. A Rust trial adds a pinned
Rust toolchain, `wasm32-unknown-unknown`, locked dependencies and pinned
wasm-bindgen/asset tooling, core tests plus browser tests and a release WASM
build before Pages upload. Keep relative asset URLs valid at `/review/` and
keep CLI output out of the Pages artifact. This design document doesn't
implement Rust CI.

## 4. Forgejo and standalone deployment

**Observed:** Forgejo documents [kanban projects](https://forgejo.org/docs/latest/user/collaboration/project/),
[REST API usage](https://forgejo.org/docs/latest/user/api/usage/) and
[Actions](https://forgejo.org/docs/latest/user/actions/).
Its API is instance-local `/api/v1`, paginated with `page`/`limit`, with the
instance's OpenAPI at `/swagger.v1.json`. This is not GitHub ProjectV2 or its
GraphQL schema. The published projects guide alone does not establish API
parity for arbitrary fields, sub-issues or project status updates.

**Proposal:** define a narrow `ForgeBackend` contract for board discovery,
items, epics, current-head reviews, run metadata and capabilities. Port reads
against a pinned Forgejo version's OpenAPI and fixture responses, not by
replacing the hostname in GitHub paths. Map native board columns to Status;
represent unsupported Priority/Lead/Run/budget metadata on forge issues using
a reviewed Markdown/label convention, not a new app database. Disable or link
unsupported features until that convention is defined. No fictitious
ProjectV2 status update: an agreed issue/comment can hold the board brief.
Validate cross-repository hierarchy support before offering epic attachment.

Actions workflow syntax is similar but semantics differ: Forgejo documents
best-effort concurrency groups and automatic cancellation defaults for
push/synchronize; set non-cancelling controller serialization explicitly and
retain idempotent claims. Re-test schedule/event coverage, dispatch/run IDs,
artifact/log endpoints and retention, runner labels, token permissions and
OIDC instead of assuming GitHub behavior. Port the safe-output validator and
trusted apply boundary independently of the workflow syntax. Forgejo bot
accounts/scoped tokens and OAuth need their own identity mapping; do not assume
GitHub Apps per role or GitHub review/signoff authorship checks carry over.

A standalone deployment can serve the static UI alongside Forgejo. Podman
**Quadlets** suit one operator's host (Forgejo, persistent forge database/git/
artifact volumes, static server, trusted controller and separate runners).
**Kubernetes** suits multiple runner pools: separate controller and agent
service accounts/namespaces, per-run workspaces, broker access and network
policy. Neither orchestration choice alone provides the agent sandbox.
The forge owns persistent work/storage; the recommended static UI doesn't need a
server-side work database. A conditional axum/Datastar deployment would also
operate forge credentials and authenticated session state, even without that
database; deploy it as a separate service, not on static Pages. Serve
same-origin when possible, or configure explicit CORS/CSP forge origins and
per-origin tokens; no wildcard token relay. Keep trusted credential-bearing
apply/controller jobs outside untrusted agent execution.

## 5. One inbox over several forges

**Proposal.** One projection of work awaiting the operator, not a synchronized
tracker: review requests, mentions, assigned issues, and the operator's own
open PRs/MRs with CI and review state. Add providers, not one UI per forge.
This section was researched on **2026-10-30**; documented API contracts below
are Observed, their proposed use is Proposal. Authenticated reads/writes and
a real browser session were not exercised: those remain **unverified**.

### Small provider contract

**Proposal.** TypeScript-like pseudocode; `project` means repository/project
path here, **not** a board. `ref` includes native type and number/IID so GitLab
issues and MRs cannot collide. Provider-private handles retain notification/
todo IDs; they are not confused with issue/PR IDs.

```typescript
type Row = {
  forge: string;                 // canonical origin, not just vendor
  project: string;               // owner/repo or group/subgroup/project
  kind: "issue" | "pr" | "mr" | "bot-ask";
  ref: string; title: string; url: string;
  updated: string | null;         // source timestamp; null if unavailable
  why: ("review-request" | "mention" | "assigned" | "own" |
        "answer" | "write" | "promote")[];
  ci: "pending" | "success" | "failure" | "unknown" | "n/a";
  review: "requested" | "approved" | "changes-requested" | "unknown" | "n/a";
};
interface InboxProvider {
  list(input: { cursor?: string; signal: AbortSignal }): Promise<{
    rows: Row[]; cursor?: string; partial: boolean; warnings: string[];
  }>;
  act(row: Row, action: "open" | "mark-done"): Promise<void>;
}
```

**Proposal.** Merge reasons by viewer + origin + project + native object ref;
keep a bot-ask's issue identity and link its PR target instead of losing the
question in PR deduplication. `updated` is not request age. Missing CI/review
is unknown, never success/approval; CI applies to the returned head, not an
arbitrary latest branch run. `open` uses the existing pane where supported,
otherwise navigates to the forge URL; it does not itself acknowledge work.

**Proposal.** Threat: a malicious subject URL or pagination link could send
one forge's token to another host. Bind each provider's transport to its
configured HTTPS API origin, validate links before authenticated requests,
and never forward authorization across redirects. New sources are off by
default, enabled only by the operator connecting that forge; no runtime
option/configuration is added by this design. Use one provider mechanism,
not an additional sync service or policy framework.

**Proposal.** Bound a refresh to 10 list pages of at most 100 items (respect
lower endpoint maxima), 20 detail reads and two concurrent requests per forge;
refresh at most once per minute while visible, with manual continuation.
Stop at the budget and report partial results, not a complete inbox count.
Honor longer poll intervals, Retry-After/reset and backoff; cancel on sign-out
or selection change. Fetch expensive CI/reviews on visible rows/on demand.

### API mapping and permissions

**Observed.** [people.ts](../src/github/people.ts) already reads GitHub
`/search/issues` for non-bot open review requests, `/notifications`, issue
subjects/timelines, PR heads, check runs and combined statuses; it PATCHes
individual notification threads. [prs.ts](../src/github/prs.ts) searches bot
PRs and reads `/pulls/{N}/reviews`; [backend.ts](../src/github/backend.ts)
uses `POST /graphql` for ProjectV2 status updates. These are existing calls,
not proof that notifications, assigned issues and own PRs are equivalent sets.

**Observed.** Fedora's [version endpoint](https://forge.fedoraproject.org/api/v1/version)
returned HTTP 200, `{"version":"v15.0.11-2be8d"}`, on 2026-10-30.
Its [live OpenAPI][fj-api] was read for the mappings below. This is Forgejo,
not proof of parity with all Gitea versions; a Gitea adapter must check its
instance schema. No hosted Forgejo GraphQL equivalent is assumed.

**Observed (documented endpoints); Proposal (normalization).** All list calls
are GET, with encoded query values. GitHub base is `https://api.github.com`,
Fedora base `https://forge.fedoraproject.org/api/v1`, GitLab base
`https://gitlab.com/api/v4`; `{R}` is owner/repo, `{P}` a project ID or encoded
path, `{N}` the native number/IID, `{H}` the current head SHA, `{U}` the viewer.

| List/detail | GitHub REST / GraphQL | Fedora Forgejo / Gitea family | gitlab.com |
| --- | --- | --- | --- |
| Review requests | [`/search/issues`][gh-search], `q=is:pr is:open review-requested:{U}` (teams included; `user-review-requested:` for direct asks) | [Schema][fj-api]: `/repos/issues/search?state=open&type=pulls&review_requested=true` | [MR API][gl-mr]: `/merge_requests?state=opened&scope=reviews_for_me`; alternatively `scope=all&reviewer_username={U}` |
| Mentions | [`/notifications?all=false&participating=true`][gh-notify], filter `reason=mention`; search `is:open mentions:{U}` is broader, not unread state | [Schema][fj-api]: `/repos/issues/search?state=open&mentioned=true`; `/notifications` supplies unread thread handles, **no GitHub-style reason field** | [Todos][gl-todos]: `/todos?state=pending&action=mentioned`; also `action=directly_addressed`, a separate query |
| Assigned issues | [Search][gh-search]: `q=is:issue is:open assignee:{U}` | [Schema][fj-api]: `/repos/issues/search?state=open&type=issues&assigned=true` | [Issues][gl-issues]: `/issues?state=opened&scope=assigned_to_me` |
| Own open PRs/MRs | [Search][gh-search]: `q=is:pr is:open author:{U}`; include drafts, show them explicitly | [Schema][fj-api]: `/repos/issues/search?state=open&type=pulls&created=true` | [MR API][gl-mr]: `/merge_requests?state=opened&scope=created_by_me` |
| CI | [Checks][gh-checks]: `/repos/{R}/commits/{H}/check-runs` **and** [combined status][gh-status]: `/repos/{R}/commits/{H}/status` | [Schema][fj-api]: `/repos/{R}/commits/{H}/status`; Actions `/repos/{R}/actions/runs?head_sha={H}`, where enabled | [Single MR][gl-mr]: `/projects/{P}/merge_requests/{N}`, `head_pipeline.status` and `.sha`, exposed only with pipeline visibility |
| Review state | Existing `/repos/{R}/pulls/{N}` and `/reviews` in [prs.ts](../src/github/prs.ts), comparing reviews to head; GraphQL is optional, not required for this slice | [Schema][fj-api]: `/repos/{R}/pulls/{N}` and `/repos/{R}/pulls/{N}/reviews`; preserve review state/commit identity, not GitHub's verdict policy | [MR reviewers][gl-mr]: `/projects/{P}/merge_requests/{N}/reviewers`; [approvals][gl-approvals]: `/projects/{P}/merge_requests/{N}/approvals` (per-rule `/approval_state` is tier-dependent) |

**Proposal.** Forgejo search filters are separate queries, not an assumed OR
of booleans. Mentions search finds historical mentions on open work, not
necessarily unanswered asks; label that reason honestly. Notifications alone
cannot classify mentions on this schema. GitLab todos can target non-issue/MR
objects: initially skip them with a capability warning. Review assignment,
submitted review, approval rules and mergeability are distinct; preserve
unknowns rather than projecting GitHub's exact-head promotion semantics onto
another forge. Verify reviewer/approval behavior with authenticated fixtures.

**Observed.** Auth and limits were checked against the linked documentation;
actual account permissions, Fedora deployment quotas and token acceptance
remain **unverified**. One independently revocable token per forge suffices;
the minimum depends on public/private coverage and acknowledgement choice.

| Forge | Minimum proposed credential for these reads, based on Observed docs | Observed limits / client implication |
| --- | --- | --- |
| GitHub | [Notifications][gh-notify] require a **classic PAT**, `notifications` (or broader `repo`); public detail reads need no additional repository scope. Private details require `repo`, which is not read-only. Do not claim a fine-grained PAT supports notifications. Reuse current login; no extra board/write scopes solely for inbox reads. | [REST][gh-rate]: ordinarily 5,000 authenticated requests/hour; [search][gh-search] 30/minute authenticated and 1,000 results/query. [GraphQL][gh-graphql-rate] has a separate points budget, ordinarily 5,000/hour. Secondary limits also apply; notifications publish `X-Poll-Interval`. |
| Fedora Forgejo | [Scopes][fj-scopes]: `read:issue` for search; add `read:repository` for PR/CI detail, `read:notification` only if reading threads, `read:user` only if discovering viewer identity. Prefer public-only access for this upstream slice. `write:notification` is needed only for acknowledgement. | [API usage][fj-usage]: `page`/`limit`, Link and `x-total-count`; `/settings/api` advertises paging limits. [Config][fj-config] is instance-controlled; no Fedora numeric API rate quota was verified. Do not assume GitHub's allowance; handle 429/backoff. |
| GitLab.com | [Token scopes][gl-scopes] and [auth][gl-auth]: PAT with `read_api`, sent as `Authorization: Bearer` (so the tested preflight applies). Todo acknowledgement requires broader `api`; do not request it for read-only use. | [Current limits][gl-rate]: authenticated API 2,000/minute/user, all traffic 2,000/minute/IP; endpoint limits may be lower. The page's plan-based hourly/burst limits are explicitly **proposed, not yet in effect**. [Todos][gl-todos] also document a feature-flagged 300/minute default; deployment activation unverified. Honor response limits, not these numbers as a polling target. |

### What “mark done” means

**Observed.** GitHub distinguishes [PATCH read from DELETE done][gh-notify];
today [markPeopleDone](../src/github/people.ts) uses PATCH (read), despite its
name. Forgejo's [schema][fj-api] has per-thread PATCH to read and GitLab's
[todo API][gl-todos] has `POST /todos/{id}/mark_as_done`. None closes an issue,
removes a requested reviewer, approves a head or answers a bot question.

**Proposal.** Both policies are available for the operator to decide; recommend
**local acknowledgement for the new provider slice**, keeping it read-only.
Do not silently change the existing GitHub behavior. A local dismissal stores
only viewer/origin/object/reason plus observed update/head; a newer event/head
resurfaces it, with a control to undo or show dismissed items. It is disposable
browser state, not work completion; search-only review requests remain discoverable.

| Forge | Proposal: forge-write alternative (explicit opt-in, off by default) | Proposal: local-only alternative |
| --- | --- | --- |
| GitHub | Exact notification thread DELETE for native “done”, or retain PATCH labelled “mark read”; requires a thread handle. Never bulk-mark. | Dismiss observed row/reasons locally; no forge write for search-only rows. |
| Forgejo | PATCH `/notifications/threads/{id}?to-status=read`; call it “mark read”, not native task completion. No thread means no write. | Dismiss search/notification row locally; recommended for the first slice. |
| GitLab | POST `/todos/{id}/mark_as_done` for the selected todo only; disclose broader `api` scope. | Dismiss locally without clearing the forge todo; recommended until writes are approved. |

### Static-client reachability and credentials

**Observed.** On **2026-10-30**, no-token preflights sent OPTIONS to the URLs
below with `Origin: https://cgwalters-forge.github.io`,
`Access-Control-Request-Method: GET` and
`Access-Control-Request-Headers: authorization`. These are actual upstream
statuses/selected headers (not the sandbox proxy's initial CONNECT 200):

| Endpoint probed | Quoted response headers | Finding |
| --- | --- | --- |
| `https://api.github.com/notifications` | `204 No Content`; `access-control-allow-origin: *`; `access-control-allow-methods: GET, POST, PATCH, PUT, DELETE`; `access-control-allow-headers` includes `Authorization`; `access-control-max-age: 86400` | Token-header GET preflight allowed. |
| `https://forge.fedoraproject.org/api/v1/notifications` | `405 Method Not Allowed`; `allow: GET`; `allow: PUT`; **no** `access-control-allow-origin`, `access-control-allow-methods` or `access-control-allow-headers` | Token-header GET preflight blocked at this endpoint. |
| `https://forge.fedoraproject.org/api/v1/repos/issues/search?state=open&type=pulls&review_requested=true` | `405 Method Not Allowed`; `allow: GET`; `allow: PATCH`; `allow: DELETE`; **no** CORS allow-origin/methods/headers | Review-request search preflight also blocked. |
| `https://gitlab.com/api/v4/todos` | `200 OK`; `access-control-allow-origin: *`; `access-control-allow-headers: authorization`; `access-control-allow-methods: GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS`; `access-control-max-age: 7200` | Token-header GET preflight allowed. |

**Proposal.** GitHub and GitLab appear suitable for direct static token reads
with cookies omitted; wildcard origin does not hide a token from client JS.
Authenticated GET/error-response CORS, other routes and mutation preflights
still need browser verification. Fedora fails this test: do not claim Pages
can read it merely by expanding CSP. [Forgejo CORS settings][fj-config] are
administrator-controlled; the review-request search route also failed its
preflight. The separate mention-query/browser behavior remains **unverified**.

**Proposal.** Keep section 3's static TS recommendation for GitHub (and a later
GitLab read slice), but Fedora needs section 3's server-side variant or a small
authenticated, fixed-origin proxy under the observed configuration. Direct
Fedora support requires an upstream CORS change and successful browser checks.
Threat: an arbitrary-URL proxy could exfiltrate credentials; permit only the
configured Fedora API and bounded read routes. Prefer a server-held token and
authenticated session over relaying browser tokens; that introduces credential
storage, revocation, session/CSRF operations, not a shadow work database. Keep
credentials out of Pages assets, URLs and logs. No proxy is added here.

### Bot asks and navigation are sources, not new destinations

**Observed.** [needs.ts](../src/github/needs.ts) derives unanswered valid
questions, explicit unreviewed-current-head review requests, approved fork
promotion/human-text asks, and operator-only scheduler holds. It excludes
waiting-on-bot entries, coalesces decisions/questions/holds, and retains
locally answered rows dimmed until reload. Legacy review/chore blockers are
Watching, not all automatically Needs. [asks.ts](../src/github/asks.ts) parses
`Blocks:`, `Ask:`, exact `Review:` URL/head and `Rerun:` run lines from open
assigned labelled asks; malformed targets unlock only comments.
[people.ts](../src/github/people.ts) separately merges human review search and
14-day unread mention/review notifications, excludes bot/self/nonhuman asks,
retains unlocated mentions, and treats unreadable CI as unknown.

**Proposal.** Adapt Needs as another provider: `forge=https://github.com`,
`project`/`ref` from the backing issue or PR, `kind=bot-ask`, native
title/URL/update time, `why=answer|review-request|write|promote`. Carry CI/review
from the linked PR when known, otherwise n/a or unknown. An internal hash is
not the canonical URL; holds without a resolvable native target stay a labelled
local warning, not an invented forge issue. Generic mark-done cannot settle
these asks: open the established answer/review/promotion flow, preserving
fresh-head checks. Local acknowledgement must never reduce Needs counts.

**Proposal.** In section 2's same sidebar/drawer, add forge entries (GitHub,
Fedora Forgejo, GitLab) as scope selectors above literal Projects/boards;
repository/project filters stay distinct from board entries. Command shows
the combined inbox preview and View all in the existing content area. Unknown
board association stays forge-global; do not attach every upstream ask to
Workstream. Follow [tracker#976](https://github.com/cgwalters-forge/tracker/issues/976)'s
operator-specified **no new tabs** rule; no per-forge destination/tab strip.

**Proposal: smallest next step.** Opt-in, read-only Fedora Forgejo review
requests and mentions using the two search queries above, with links out and
local acknowledgement only. This exercises one genuinely different provider
without boards, Actions parity, GitLab approval tiers or new writes. CORS is
the gate: review-request search is blocked, so use the bounded server transport
unless Fedora changes CORS, not a browser workaround. Keep GitLab as the next
documented adapter, not a second simultaneous implementation. Ship criteria
appear below.

[gh-search]: https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests
[gh-notify]: https://docs.github.com/en/rest/activity/notifications
[gh-checks]: https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference
[gh-status]: https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference
[gh-rate]: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
[gh-graphql-rate]: https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
[fj-api]: https://forge.fedoraproject.org/swagger.v1.json
[fj-usage]: https://forgejo.org/docs/latest/user/api/usage/
[fj-scopes]: https://forgejo.org/docs/v15.0/user/authentication/token-scope/
[fj-config]: https://forgejo.org/docs/v15.0/admin/config-cheat-sheet/
[gl-mr]: https://docs.gitlab.com/api/merge_requests/
[gl-todos]: https://docs.gitlab.com/api/todos/
[gl-issues]: https://docs.gitlab.com/api/issues/
[gl-approvals]: https://docs.gitlab.com/api/merge_request_approvals/
[gl-scopes]: https://docs.gitlab.com/security/tokens/access_token_scopes/
[gl-auth]: https://docs.gitlab.com/api/rest/authentication/
[gl-rate]: https://docs.gitlab.com/user/gitlab_com/rate_limits/

## 6. Shippable milestones and open decisions

1. **Command shell, TypeScript (first milestone).** Add the sidebar/phone
   drawer and board/view routes, initially Workstream only. Compose existing
   status + Decisions and five-row previews with View all; retain review forms,
   keyboard navigation and draft protection. Ship when DOM tests and a real
   phone-width/focus pass confirm no action or draft regressions.
2. **Literal multi-board projects.** Add org/user discovery, board capability
   handling and board-scoped reads/joins for all five views. Ship with fixtures
   covering overlapping boards, user-board GraphQL pagination, missing fields,
   no access and late responses; no cross-board asks or usage misattribution.
3. **Run evidence and budgets.** Add optional budget parsing and clearly
   separate planned tokens, runtime cap, measured/estimated usage and exact-head
   review outcome. Initially link Actions transcripts and use durable PR
   footers. Ship with expired/missing evidence and stale-heartbeat states;
   artifact preview requires a separate CSP/download decision.
4. **One Rust view experiment.** Extract reusable bot-poll core only where
   semantics overlap, trial Leptos CSR Agents, and publish comparative release
   measurements plus native/browser test results. Ship the island only if the
   sharing/maintenance benefit warrants its download and tooling cost.
5. **Proposal: Fedora inbox slice (before a full Forgejo board port).** Add
   only opt-in read-only review-request/mention search. Ship after search-route
   CORS/browser verification or a reviewed bounded server transport; fixtures
   cover duplicates, historical mentions, denied access, unknown CI, pagination
   caps and stale responses. Confirm no forge writes and no new tabs.
6. **Forgejo read-only vertical slice.** On a pinned standalone instance,
   show one real project board, its issues, PR reviews and one Actions run via
   the backend contract. Ship with explicit capability gaps, tested identity/
   token isolation and Quadlet deployment; broaden writes/Kubernetes later.

**Proposal: open inbox decision.** Operator chooses local dismissal versus
per-forge acknowledgement writes (including GitHub read versus native done),
and whether Fedora access warrants server-held credentials given the failed
search preflight. Keep new providers/writes off until that choice; no caller config
change is needed for a design-only proposal.

Decisions still needed: per-role identity/enforcement (tracker#304); which
owners/boards to expose and where unassociated global asks live; the user-board
schema/capability contract; whether to authorize browser artifact redirects;
and the pinned Forgejo metadata convention/version. None blocks the initial
Workstream Command shell. Rust adoption follows measurements, not a rewrite
commitment.
