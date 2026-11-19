# Control app

> This text is LLM generated.

Read this documentation [on the website](https://jmarrero.github.io/review/docs/)
or open the [Pages app](https://jmarrero.github.io/review/).
`npm run build` renders `docs/*.md` into `dist/docs/` alongside the app;
the existing Pages workflow publishes both. Repository-source links open on GitHub.

The control app is a small interface for work proposed by
[jmarrero-bot](https://github.com/jmarrero-bot) and by people: questions,
approvals, review drafts and operator actions, with a head-checked PR review
pane. The forge, git and markdown are the source of truth. Answers and edits
are made as you, with your token; the build doesn't include private contents.

The GitHub browser has just two pages: **Needs you** and **Status**. It is
a place to read and act, not another scheduler or operations console.
See [design.md](design.md) for the backend design and
[prior-prototype.md](prior-prototype.md) for the earlier prototype.
The Forgejo client remains separate.

### Serverless by default (#320)

The Pages app is the default deployment and needs no service, persistent or
otherwise, and no Kubernetes: the browser reads the private
holds and pass view publication, publication ages and Actions run lists directly
from GitHub with a pasted token. Start with a short-lived fine-grained token with
read access to the relevant repositories, including the publication repository.
The sign-in help lists read permissions and the additional permissions for actions.
Pasting a fine-grained token, read-only unless an action needs more, is the
supported sign-in. The OAuth device flow stays off: GitHub's device-code and
token endpoints don't allow CORS, so a static page can't use them without a
relay (see "Static-site feasibility" in [design.md](design.md)).

The concrete threat is an accidental write with a pasted token that already has
write permission. Every browser session therefore starts read-only, including
sessions restored from storage. **More → Read-only · Enable writes** asks for
confirmation and enables existing actions only until reload or sign-out. The same
control can turn writes off again. One GitHub-client check refuses REST writes
and GraphQL mutations locally before fetch or cache invalidation; existing
operator, scope, publication and live-head checks still apply. This is a guard
against accidental actions, not against modified site code or a compromised browser.
CLI callers keep their existing write policy. No deployment option is added.

Answer-and-release requires a comment receipt linking to the same issue or PR
before closing a question or removing `needs-human`. A missing, malformed or
wrong-target receipt leaves the result uncertain: check GitHub, do not repost.
The card retains that warning across refreshes and sends no release request.

Offline browser regressions reject every non-GitHub origin, render published
state without a service, forget an expired token, and show a refused dispatch
without retrying it.

Signed in as the operator, an open item's view has **Start an agent**: pick
triage, research, implement or fix and write a brief, and it posts a
[job plan](https://github.com/cgwalters-forge/agent-board/blob/main/docs/job-plans.md)
on the item, as the control-plane CLI's dispatch does; the next hosted pass
dispatches it. It asks first, and refuses another viewer, a closed item, one
the pass view lists running, or a plan agent-board wouldn't accept. It then
links the plan and checks the item's comments, a bounded number of times, for
the pass's dispatch record naming the run. A started chat session shows
"Waiting for attach" while its run is in progress; attaching is a hook that
does nothing until the gateway design (agentic-job#3249) lands.

Not yet: published `changes` (agent-board#897) and reading live data from an
optional persistent service (tracker#1456).

See the [operator-gap assessment against Paperclip](operator-gap-assessment.md)
for the 3 November snapshot, existing-work exclusions and ranked additional gaps.

## Needs you

**Needs you** (`#inbox`) is the default. Its first cards show what the
scheduler's pass publishes as waiting on the operator in its `needs_you`
list (`agent-board/needs-you/v2`, agent-board's docs/pass.md, on with the
pass's `holds.needsYou`): holds that only he can release, followed PRs waiting
on his approval or answer (broker PRs included), operator-action proposals
and maintain digest asks, including configured decisions-document entries
and review drafts. The producer's ranked `identities` inventory determines
membership; `detail_key` joins its optional detailed cards. Missing
details produce read-only two-line placeholders ("Detail not published"),
not target discovery. Descriptors joined by `detail_key` still restrict their
navigation and chat; foreign, missing or unreadable descriptors never restore
GitHub targets in a descriptor-bearing publication. The browser
does not search the board, decisions or draft issues to assemble this list.

Hold-derived entries (`epics`, `items`, `pass`, `holds`) are reconciled with
the same snapshot's `operator: true` holds. A superseded inventory identity
or carried detail cannot put agent work or a resolved hold back in Needs you;
its decision is excluded from the heading and named in the freshness note.
An incomplete/truncated hold inventory cannot prove an absent hold resolved.
Review waits and proposals retain their own publication rules. No label or
ownership prose is interpreted as evidence, and this adds no discovery reads.
`test/fixtures/needs-you-259.json` is a derived replay of the reported
agent-board#727/#728 states, not a capture of the private publication.

Above the cards, **Agents and capacity** opens with **Live agents**, read
straight from the GitHub Actions API rather than the publication, so it shows
what is running even when the pass view is missing or stale: every
`in_progress`, `queued` or `pending` run of each agent workflow in
`LIVE_SOURCES` (`src/github/liveruns.ts`: tracker's `dispatch.yml` and the
devspace's `agent.yml`), one conditional request per workflow and status
each minute while Needs you shows. Each row has the repo#item (a link), kind
and pool parsed from the run-name (`KIND OWNER/REPO#N[ HEAD] (POOL[, …])`; a
name that doesn't parse shows as is), the elapsed time, a link to the run and,
for the operator, **Cancel**, which reads the run fresh and refuses one that
finished or isn't of that workflow. Where the pass view lists a run, it fills
in a pool the name lacks. A missing or non-array workflow run list is an
incomplete read, not evidence that no agents are running, including after a
304 revalidation. Valid lists from the other statuses remain visible; this
does not add retries or discovery requests.
Then the panel summarizes the optional `pass_view`
publication, as Status does: pool usage
bars against published allowed percentages and reset clocks, and the latest
pass's starts. When it started nothing, the panel groups identical reason
kind/text pairs, showing the three largest counts (ties retain publication
order). Missing, stale, future-clock, partial and unavailable publications are
labelled, not treated as idle health. The panel wraps into one column on phones;
besides Live agents' run lists it adds no polls or browser setting.

Signed in as the operator, each of the
five newest published starts no longer listed running has **Retry** (rerun the
run's failed jobs) and **Redispatch** (reply on its item repeating the newest
[job plan](https://github.com/cgwalters-forge/agent-board/blob/main/docs/job-plans.md)
by the operator or cgwalters-bot, which the pass then dispatches as a new plan).
Each asks first, then writes with the viewer's token. The threat is a click
acting on the wrong run: a stale row, a run that already finished, or a
redispatch starting a job other than the one that failed. So each action is
refused unless the pass view drawn lists that run; `GET /user` must be the
operator; a classic token needs `repo` to cancel or retry, or `public_repo` to
redispatch (fine-grained tokens without Actions or Issues write are refused by
GitHub); and the run, read fresh, must be live to cancel, or completed and
failed to retry or redispatch. Both recovery actions also refuse an item listed
running, a newer plan or dispatch record, over 1,000 comments, a malformed plan,
two plans in one comment, or a plan whose `kind` or target differs from the run's.
Plan text and last-editor metadata are read together: foreign or unidentified
edits to a writer's comment stop recovery, even if the edit removed its fence.
As in agent-board, trusted edits to fence-less comments are not plan candidates.
A row's buttons share one outcome: a refusal offers them again, while a sent
action, or one that may have gone out, keeps them off until reload.

Each identity and card carries agent-board#661's `epic` (nearest live epic)
and `topEpic`, `none` or `unknown`, and `epics` maps each live epic to
`active`, `activeWhy` (`focus`, `recent-run`, `open-pr`,
`operator-comment`) and `complete`. By default the inbox shows the
in-progress epics' cards plus approval waits from every epic. Approvals come
first across epics, placeholders included, then other full rows, then
read-only placeholders; within these tiers full rows come before
placeholders, then the focus epic, then Priority and the oldest wait. Explicit epic filters still select only their named rows.
Cards whose chain is `unknown`, or whose inactive epic's activity was
not read whole, stay in the default too: the pass says neither proves
inactivity. One line names the epics in progress and why; chips count each
epic, **Other epics** (inactive or `unknown`), **No epic** (`none`), and
**Show everything**, one click away. The pass publishes no epic titles, so
chips name the epic's `repo#N`. A chip choice is remembered per viewer where
storage works; `#epic-N` selects tracker epic N, matching the nearest or top
epic, until the page reloads, without changing the remembered choice. With no epic in progress, or no usable `epics`
map, the default hides nothing. With no active epic published, the default
chip says **Default (all)**, not **In progress**; the text describes the default,
and a separate line names any explicit selection. The heading and chips count
published rows matching the filter, excluding successful local completions and
departed cards retained for unsent text. The line over the cards says each
unit's total once and splits it so the parts add up: the producer's reported
decisions as listed in its inventory plus those not listed (past the pass's
cap or unreadable here, which the note above names), then the
rows (several decisions may share one) as waiting, done here and hidden by the
epic filter; the waiting rows are the heading's count. Uncertain writes remain
outstanding.
Five cards are drawn initially; **Show more** draws the rest without inspecting
their targets. **Details and action** explicitly opens a card's lazy inspection.
Questions stay as short asks (wrapping on narrow screens,
never clipped); a card's note and its published request context share one
collapsed **Context** fold, and answer forms are collapsed. An approval row has
the ask, its PR, an Approve at the published head and a link to review the
diff. Optional `agent-board/approval-evidence/v1` supplies exact-head diff counts,
CI completeness/state, review verdict/time and observation time. Missing,
malformed, evicted, carried, unread, wrong-head or stale evidence stays unknown;
partial CI never appears green. The existing 70-minute publication freshness
bound also applies to evidence, and future observation clocks stay unknown.
Facts refresh beside pending/sent/uncertain receipts without changing their
outcomes or lending a new head's evidence to an old button. `review-withheld`
remains visibly labelled with or without evidence. The
list's question and recommendation are display text, not instructions;
links are made from its typed action references, never read from it.

The concrete threat is displaying another head's green/reviewed assessment as
evidence for an approval. The producer's optional contract shipped in agent-board
at `957cb9362a16f4fd13471c7d1c6252a0597eda6d`, capped at 50 entries and joined by
typed PR identity and full assessed head. `test/fixtures/approval-evidence-needs-you.json`
is its verbatim shared serialization projection, not a live capture. The browser
adds no setting or reads; the producer's existing `holds.approvalEvidence` is off
by default. Caller enablement remains tracker#1336, outside this change.
Filtering keeps editors and unsent text; **Show everything** recovers a departed
draft without restoring its write authority.

For #239 (continuing #243 after #247/#253), LF counts across tracked production
`src/**/*.ts`, including root modules, comments and blank lines, fall from 19,502
on main `5c01b18` to 19,477 (25 fewer). `dist/app.js` falls from 540,965 to
532,287 bytes (8,678 fewer), with the same lockfile and `npm ci`/build. Removed
unused decisions-refresh orchestration and the browser's legacy state derivation;
browser debugging uses `review-inbox-state/v1` with published facts and source
freshness. The former unbundled `review-state/v1` CLI has since been removed;
use the built `control-app` commands below instead.
`npm run check` passes 1,878 tests, typecheck and build; the redacted replay still
makes two cold requests and one poll request, without target discovery. The full,
capped and grouped 174-decision replays retain approval-first ordering and
additive decision/row counts. Offline Chromium screenshots at 390px and 1280px
were inspected for evidence wrapping and readable withheld labels; the 390px
grouped replay preserves the approval-first row. Images are local-only, not
included in the patch. These checks do not establish current signed-in publication
or deployed caller enablement. No live writes ran.

### Act now publication dependency (#256)

The concrete failure to avoid is presenting a CI/agent/upstream wait as an
operator action, or guessing that similar prose authorizes releasing a group.
The optional **Act now** shortlist therefore uses producer-certified readiness
and unblock counts, not hold-reason parsing or browser dependency discovery.
It sits above Needs you, independently of the epic filter, and is off when
the optional publication is absent. It introduces no poll or browser setting.

The shipped contract is agent-board#768's `docs/act-now.schema.json`:
`needs_you.act_now` contains at most ten records with `key`, `unblocks` (1 to
10,000), `priority`, `waiting_since` and the exact typed `action`. Each key joins
one full ask and, when present, its inventory's `detail_key`. Action (including
head), priority and wait must match that ask; a mismatch disables the shortlist
without dropping Needs you. Counts rank rows, never authorize writes. Ranking
is descending unblock count, Priority, oldest wait, then key. Groups stay one
row and never authorize a representative-only write.

Unavailable, cached, stale/future publications, carried asks, incomplete sources,
missing detail, unreadable/foreign descriptors, non-decision quality and locally
completed asks cannot enter it. Every rendered row has a checked action or an
explicit refusal reason plus Inspect. A single approval shares the existing
confirmed, live-head-checked action and receipts with Needs you. Merge / enqueue
requires a published full head and supported `merge-or-enqueue` descriptors;
older publications without either explicitly refuse it. Other actions requiring
an editor, diff or proposal inspection explain why no shortcut is offered.

An incomplete list must not hide a decision that blocks work: agent-board#308
blocked PRs while Act now was empty (#305). So operator decisions (the
`needs-human`, `needs-operator`, `needs-design` and `review-needs-human`
kinds) rank first, then by `act_now` count. While a list is incomplete,
whether or not it publishes `act_now`, Act now also lists its open decisions
under a note saying so, with their `act_now` count where it has one and
"unblocks unknown" otherwise. These rows have Inspect only, never a write
shortcut, and `control-app act-now` marks them `fallback`.

Act now is the first home section, above Published activity, Focus and active work. While the
pass's list is missing, failed, unavailable, cached, stale or incomplete,
Act now says which instead of hiding, and the app lists open issues
labelled `needs-human` in the forge organization directly (one search of
at most three pages per poll, with the viewer's token, only while the gap
lasts). These
rows are separate from the published ones and read-only: a GitHub link and
"unblocks unknown", no shortcut. The label is not a question, an answer or
permission to release the hold, and nothing removes it. A published row for
the same issue wins. A failed, partial or capped read says so and never
that no decision waits. A decision without the label, or outside the
organization, cannot be found this way. A response with a missing or non-array
`items` field is a failed read, not an empty search. If a later page fails
(including a malformed response), decisions from earlier pages stay visible
with a partial-read warning naming the failed page. The search stops there;
it does not retry or claim those decisions are the whole list. A first-page
failure still reports the source unavailable. Malformed individual records are
skipped with a partial-read warning rather than discarding readable decisions
on the same or earlier pages. They still count toward the page size, so this
does not widen the three-page search bound.

**Published activity** sits immediately after Act now, keeping decisions first.
It derives at most 12 rows from the existing needs-you context snapshot and
independent pass history, with no new reads, settings or writes. Publication
remains off when the existing producer options are absent. The concrete threats
are unbounded DOM growth and publisher prose becoming navigation: existing
parsed bounds are reused, identities are deduplicated, and links come only from
validated item/run identities or the configured publication issue. Prose is
literal text with address redaction. Item facts link to their item; global facts
and passes without a run explicitly link to the publication source, not a run
receipt. Failed and cut-short sections remain visible beside pass outcomes.

Rows sort by newest known observation/finish time, then stable identity; unknown
time stays unknown. Snapshot facts are observations, not newly created decisions.
Source coverage, publication/observation clocks, stale/future clocks, cached or
failed reads, retained last-read facts and omitted/unlinkable counts stay visible.
No observed records does not mean no activity. Context does not enter Needs you
counts or change any write gate. This is bounded published activity, not every
controller tick or a complete event log, and run success is not landed-P0 evidence.

Still unfinished for #305: structured multi-question choice recording on the
issue, authoritative blocker links/counts, per-tick report publication and landed-P0
coverage. This read-only slice needs no new operator decision.

`src/github/merge.ts` rechecks the current publication and GitHub policy as the
viewer before sending one mutation. GitHub's merge queue flag covers branch
protection and rulesets. Queue admission uses `expectedHeadOid`; direct merge
requires CLEAN and sends `sha` with a permitted method (squash, merge, then
rebase). Nothing requests bypass, enables auto-merge, retries an uncertain write
or falls back from enqueue to merge. Receipts distinguish enqueued from merged;
uncertain writes require inspection on GitHub before retrying.
Direct merge receipts require a boolean `merged` response: only `true` confirms
success and only `false` confirms rejection. Missing or malformed results remain
uncertain, since the write may already have taken effect; they are never retried
automatically.
Queue receipts likewise require a nonblank string entry ID. Malformed or missing
entry evidence in the preflight stops before writing (only `null` means not queued);
malformed admission evidence after the mutation stays uncertain, never successful.

`test/fixtures/act-now-needs-you.json` is the whole producer fixture at
`e6fedc8ac1c7dc83cb01fc997e073362bde96548`, imported without changing its data.
Replay covers the 63-child epic, blocker, question and head-bound approval,
excluding carried, non-concrete, CI, agent and upstream waits. This is offline
replay, not proof of deployed publication or live writes. Caller enablement is
still the producer's opt-in `holds.actNow`, requiring `holds.needsYou` and
`holds.approvalEvidence`; no caller settings change here.

### Approval publication dependency (#251)

The app cannot recover approvals absent from the publication. The synthetic
`test/fixtures/needs-you-174.ts` models 174 decisions including tracker#1367,
an operator-path approval in an inactive epic. Its capped variant publishes
12 other rows plus that full approval, reporting 161 omitted decisions. Its
grouped variant is the #251 screen: 60 decisions listed in 22 rows, three to a
row, detail only for the approval and one group, and an approval placeholder.
All render the approval first without a missing-detail/cap warning on it, and
the heading, the chips and the line over the cards agree. This is offline replay,
not proof of a deployed producer fix. No new option, permission or target
read is added; the existing `holds.needsYou` publication remains opt-in.

Required follow-up in **cgwalters-forge/agent-board**, not implemented here:
in `crates/board-forge/src/pass/holds.rs`, change `needs_you`, `NeedsYou::cut`,
`fit` and `cap` together. Rank approval-only asks (including the poll's
`pr.operatorPaths` approval waits) before other decisions, then rank the
others before truncation. Preserve each approval's full `Ask`, compact
identity and matching `requests` descriptor/source records through both detail
eviction and identity eviction; do not let `cap` clear their descriptors.
Evict lowest-ranked non-approval detail/descriptor pairs first, then their
identities if necessary; update `details_omitted`, `omitted`,
`omitted_sources` and `complete` for exactly what was dropped. Keep canonical
`counts` unchanged. The existing 60,000-character comment bound still applies:
if protected approvals alone cannot fit, report publication failure explicitly
rather than silently omit them or claim a complete list. Supporting arbitrarily
many full approvals would require a separate bounded publication design.
Add producer regression tests at the old 100-row boundary and the comment-size
boundary, including an operator-path approval ranked after 173 other decisions,
and round-trip the resulting publication through this app's fixture tests.

This run cannot file an issue in another repository; the exact producer handoff
above must be filed there before claiming #251's publishing half complete.
Generate a phone replay with `BROWSER_DATA=174-grouped npm run test:browser`
(see [AGENTS.md](../AGENTS.md)); it writes `dist/screenshots/inbox-phone.png`.

The parser accepts the producer's compact identities and epic map, and the
older detailed-only publication. `test/fixtures/needs-you-661.json` is a
`needs_you` written to agent-board's serialization at `819bb77`
(`crates/board-forge/src/pass/holds.rs`), not a capture: the live
publication on `bot-ops#1` was not readable to the run that wrote it.
`test/e2e/render-needs-you.ts` draws Needs you from any checkout against these
fixtures, offline, for desktop and phone screenshots that compare commits;
`npm run test:browser` screenshots this checkout in Chromium. Inventory
and detailed records are bounded at 10,000 each. Published question,
recommendation, ownership and resolution text is display-only: hostile or
stale publisher prose must not become write authorization. A collapsed
**Published context** fold shows bounded hold/step/run facts, WIP, limit
readings, observation clocks, source states and omissions without adding
asks or controls. Unread context is unknown, not empty.

The line over the cards says how current the list is by the pass's own
clock: when it last confirmed the list (`validated_at`) and changed it,
and when GitHub last confirmed the comment. A 304 confirms the comment,
not the pass: after an hour plus a pass interval since `validated_at`, the
line says the pass may have stopped. It also names any source the pass
read only in part or not at all, asks past its cap, and summaries it
didn't read (an ask then shows the board's question or the hold's
reason). "All caught up" appears only for an empty list that is complete
and current. If the comment can't be read, or no longer holds a usable
list, the previous list's cards stay, marked unavailable, with the reason. A
snapshot from a pass without the list shows its own operator holds and
says that review waits, proposals and digest asks aren't listed. Context
facts use their own published observation times; the inbox does not fetch a
coordinator heartbeat or reconstruct operations telemetry.

**Answer** is a hold or a PR's needs-human. Its card reads the target and
its newest bot comment before showing the form, then checks the ask again
before commenting; on a `needs-human` ask it then removes only that
label. If the ask has changed, the app refuses to release it. Other operator
and epic holds allow comments only; `needs-design` and unrelated labels are never removed. A
recognized ask-created tracker question on the board is also closed as
completed; labels on its `Blocks:` target are left alone for agent-board's
`ask resolve`, which checks all other asks before unlabelling.
**Approve** is a PR the pass found waiting for his approval at a specific head.
Its card checks the head and your existing approvals when you act, and writes
only if the head is still the one the pass read and you haven't approved
it already; if it moved, or a review ask names another head, nothing is
sent: open the PR pane to review it. Other asks on a PR (a closer look, a
drafted reply, a stale PR) link to the PR pane. Answers and approvals
require GitHub to identify the token as the operator. Writes are not
automatically retried after an uncertain response. Sent and uncertain
outcomes, including a comment URL when release fails, survive ordinary
refreshes and card redraws in this signed-in session. An uncertain comment
is not offered again; check and finish on GitHub.

Published PR groups instead show their reason and exact member links for
inspection, including one-member and carried groups. Each member's Inspect
link is independent of its lazy read, so a failed read does not hide it.
The optional needs-you v2 `review_buckets` extension (agent-board#680,
`docs/pass.md`) is informational and absent/off on legacy lists. Its concrete
threat is stale or representative-only evidence making another draft look
reviewed. At most 10,000 lower-case typed repository/PR keys are read, with
40-hex heads, bounded summary/reason text and the producer's exact bucket/CI
enums. Each inspected member shows one short line: its bucket, freshly read
and published CI, and the published summary and reason. Only matching, non-carried,
fully read evidence with green published and successful current CI can be quick.
Missing, malformed, evicted, unread or mismatched evidence is unknown/deep.
Members stay one summary line each, in producer member order; the bucket
labels a member (`data-bucket`) and never moves it.
A changed publication keeps the selected typed member and receipts but offers
no stale action: close/reopen or `r` explicitly reinspects it. Polls do not read
targets or discover new members. Producer ranking and decision counts stay intact.
Foreign/unreadable descriptors and retired policy still remove navigation.
Groups never offer an
answer, approval or release on just the representative. Membership is
limited to 100 distinct positive safe-integer PR numbers, including the
representative; invalid groups are rejected in full and counted as unreadable
in the incomplete-list warning. Published URLs are not used. A new group
replaces any old representative form, dropping its unsent text for safety.

Approval checks read at most 100 reviews per PR, only when you act. If
that page is full, nothing is written. Only the viewer's latest deciding
review by submission time can count as an existing approval; later change
requests, dismissals or approvals of another head supersede it.
Single and digest cards share in-flight and five-minute write receipts
(at most 100 heads per signed-in client), including uncertain failures.

Where the pass publishes request descriptors (`needs_you.requests`), a card
follows their typed actions: Approve only where `review-at-head` is
supported, Do only where `check-proposal` is, and nothing in place for a
request on a forge other than github.com. Unreadable, missing or capped
descriptors stay read-only; only older lists with no descriptor field use
legacy actions. Foreign or unreadable targets offer no GitHub navigation.
The steps the pass marks
unsupported (merge or enqueue, reply, close) are listed with its reasons
under **Not offered here**, never replaced by a generic Answer or Open. A
quality other than `decision` is shown on the card. A group of stranded PRs
gets no Answer, which would land on its first PR alone; each member is read
only when opened. **Promote** is a midstream draft (`review-promote`): each
member opened shows its state and head. Eligible open drafts offer an explicit
**Promote** confirmation, unless the descriptors rule it out. This submits only
an APPROVE review with `commit_id` equal to that displayed head, as the operator.
The current request's policy and membership and the exact live PR's eligibility,
draft state and head are checked again before writing. A changed member requires
`r`, rereading and a new confirmation. A push after preflight cannot authorize
the replacement commit. No command, ready, merge or enqueue is sent. Sent and
uncertain receipts are kept separately for each member/head in this signed-in
session; they do not mark the group done. The receipt says approval sent, waiting on promoter,
not promotion completed. Human-text members still require Make it mine.
CI is read uncached at inspection and both approval preflights, bounded to
100 checks and 100 statuses; incomplete/unavailable reads are unknown. A changed
CI summary also requires redisplay and confirmation, without requiring green
CI for an explicit approval. The shared synthetic producer projection is in
`test/fixtures/draft-review-needs-you.json`; real-hook offline replay is not
live acceptance. No live mutations or private payloads were used to test it.
If descriptors become foreign or unreadable, prior member outcomes remain
visible without controls or navigation, even if the write was still pending.
Reloading with `r` refreshes member readers, not a cached member-list receipt.
Digest-owned approval result rows stay in the digest report: inspecting a member
shows a copy, including when its read fails, head changes or policy refuses Promote.
Read-only presentations remove controls and receipt navigation; pending ordinary
and member writes retain live completion rather than a frozen snapshot.
A successful approval or answer marks its card done at once and
says what it is waiting for; an answer that only comments says the hold stays.

Promotion evidence (read-only, 2026-11-03): the controller's
[commit-bound decision](https://github.com/cgwalters-forge/review/issues/222#issuecomment-6615351214)
was retrieved with the GitHub API. The original promoter's current source is
[homegit `c027d9f4`, `bin/bot-pr`](https://github.com/cgwalters-bot/homegit/blob/c027d9f4c28c8e21df37f82e978b3fc55fe73cab/bin/bot-pr#L1944-L1975):
its ordinary approval rule compares the operator review's `commit_id` to the
current head (with a separately verified sign-off-record exception). It also
checks the branch ref again before upstream PR creation (lines 2695–2698).
This is source evidence, not verification of the deployed scheduler or an atomic
approval/head check across its writes. Agent-board's current promotion stage at
`e1886655e67dd85919f7c1a1771ba3be7b806a17` is still inert; it is not evidence of
a working replacement promoter. No live writes or promotion integration test ran.
The configured current publication, `cgwalters-forge/bot-ops#1` comments, returned
404 to this run, so current real requests could not be revalidated. The sanitized
`test/fixtures/needs-you-real-2026-11-03.json` remains replay evidence only: its
17:41:35Z snapshot is partial (12 asks, 85 omitted), with promotion and future
reply/close/merge-or-enqueue capabilities explicitly unsupported. Those refusals
remain in force; agent-board#640 capabilities are not implemented here.

Read-only follow-up (2026-11-04): the configured `bot-ops#1` comments API still
returned HTTP 404 (not found or inaccessible with this run's credentials), so no
current publication or real mixed-outcome request could be verified. Homegit main
is still `c027d9f4c28c8e21df37f82e978b3fc55fe73cab`. Its five most recent Actions
runs were successful `controller-report.yml` runs; the workflow explicitly uses
read-only permissions and a report-only scheduler, not a deployed promoter.
Agent-board main at `f382fb0ad2196db1a1401758e2ae2923c809a24b` has an inert pass
promotion stage and a standalone evidence preview whose remaining gates explicitly
include publication and first-write revalidation, with no writes implemented.
Its five most recent runs showed CI, site and skipped review jobs, not promotion.
These bounded API observations and source reads do not establish the deployed
promoter's identity/configuration or its exact-commit behavior. Deployment access
and a sanitized real end-to-end example remain needed; fixtures are replay evidence,
not integration proof. No live mutations were attempted.

Receipt follow-up size check (Node 24.22.1, npm 11.19.1; each revision's lockfile,
`npm ci && npm run build`): source LOC below counts LF characters in tracked
`src/**/*.ts`, including comments and blank lines, excluding tests and generated files.
`app.js` is the minified build's byte length, excluding its map and legal text.

| Revision | Source LOC | `inboxview.ts` LOC | `dist/app.js` bytes |
| --- | ---: | ---: | ---: |
| pre-#229 `f71d4e46814b4660b27714a1ab228e39b857a586` | 18,971 | 405 | 546,778 |
| #231 `e653070e6e8ffe7bb124044e4565fd679370dea9` | 19,211 | 454 | 555,893 |
| This receipt follow-up | 19,213 | 456 | 555,937 |

Reproduce in separate worktrees at those revisions, then in this checkout: run
`npm ci && npm run build`, and the following measurement in each worktree:

```sh
node -e 'const fs=require("node:fs"),cp=require("node:child_process");const files=cp.execFileSync("git",["ls-files","src"],{encoding:"utf8"}).trim().split("\n").filter(f=>f.endsWith(".ts"));const lines=f=>fs.readFileSync(f,"utf8").split("\n").length-1;console.log({source:files.reduce((n,f)=>n+lines(f),0),inboxview:lines("src/github/inboxview.ts"),bytes:fs.statSync("dist/app.js").size});'
```

The shared receipt presentation adds 2 source lines and 44 built bytes over #231;
against pre-#229 the totals grow by 242 lines and 9,159 bytes. **The “JS shrinks”
acceptance is still unmet**, as are real deployed-promotion/hold-release evidence
and the unsupported reply/close/merge-or-enqueue actions in #222. This follow-up
does not close that issue or add those writes.

The digest's approvals are one **Approve selected** card. It approves
selected PRs at the heads the digest assessed, skipping changed heads and
closed PRs and reporting each outcome. Safe preflight failures say Not sent;
possibly sent approvals stay uncertain, with that member unticked and disabled.
These per-head receipts also survive `r` and changed digest membership in this
signed-in session, and are shared with ordinary approval cards. Status comes
from structured results, not the wording of a failure.

**Send** presents an open review-draft issue. **Do** presents one
[operator-action proposal](operator-actions.md) the pass lists: the
card reads its comment again, accepting it only on the configured tracker
from the operator or the planner and not yet executed, and shows the exact
typed mutations, live target preconditions and **Run as yourself**.
Multiple proposals on one issue each get their own card. Actions execute
sequentially with the operator's token, fail closed on changed or
unreadable targets, and do not retry uncertain writes. Merges use GitHub's
shown-head SHA guard; enqueueing is not offered because the published
contract has no enqueue action.

Cards retain their nodes across polls. A card holding an unsent pick, text
or focused field is not redrawn, moved or removed. It says when its source
changed or left; `r` explicitly reloads it, dropping the draft. A document
answer is sent only if its entry still matches the card shown. Switching
between Needs you and Status does not discard unsent answers. If descriptors
change while a draft or receipt is retained, its old controls and links are
disabled until reload; the text and receipt remain visible.

The optional single checklist document is configured in
`src/github/decisions-config.json`: `document` names `repo` and `number`;
`legacyQuestions` retains old per-issue asks. The page always uses cards;
the old `inbox` switch no longer selects a separate row-based writer.
Entries use `### D12 Question`, `- [ ] A) Answer` options and a `Reply:`
line. `About: owner/repo#12`, optionally followed by `, asked 2026-10-15`,
identifies its subject. With `resolve: true`, each refresh checks subjects
for the first ten open entries: closing or merging removes the entry,
while later comments mark it changed. Unreadable subjects leave entries
alone. A fresh body comparison refuses stale answers, preserving the pick
and reply; GitHub has no atomic issue-body compare-and-swap, so an edit
between the final read and write can still race.

**From people** appears after the cards, closed by default. Opening it reads
human-authored PRs requesting the operator's review and recent unread human
mention/review-request notifications. It deduplicates matching threads and
previews five rows before **View all**. **Mark done** marks notifications
read on GitHub; an open review request remains until reviewed. Unknown-age
requests are labelled unknown, and unresolved mentions say so. Closed folds
do not poll. Classic tokens need `notifications` or `repo`; fine-grained
tokens do not support notification endpoints. Inaccessible notifications
leave review-request search results visible with a warning. If a later search
page fails, already-read review requests remain actionable alongside the search
warning; the list is not complete. Search still stops at 1,000 results.

## Focus

**Focus** follows Act now and Published activity on the home (Needs you) page,
not a separate route. It reads `epic_focus` (`agent-board/epic-focus/v1`) from the existing
holds snapshot, with no additional fetch, poll or remote write.
Cards start collapsed, showing the linked epic title, goal, done/total progress,
operator blocked count and the epic's own blocker (otherwise an open child's
operator blocker, then the first published open-child blocker). Expansion is
remembered locally per signed-in viewer and epic where storage works; without
storage the folds still work. Expanded cards show Actions run links and open
children, with completed children behind an **N done** fold. Cards and each
child group retain producer order. A not-started child means nothing is moving it now, not that it
never ran. Plain tasks without an item cannot have an item link.

Coverage, observation time, omitted epics/children/runs and unread epics remain
visible; partial or unread sources are not a complete inventory. Observations
over an hour old or more than a minute in the future are not presented as
current. If the optional `holds.epicFocus` publication is absent, work and
blockers are unknown, not absent. Unknown schemas and malformed records make
only Focus unavailable. To prevent unbounded DOM growth
and arbitrary publisher-address navigation, the reader bounds the section to
10 epics, 50 children and 8 runs per epic, bounds prose and counts, and builds
links from validated typed identities. Published prose is text, not authority.

`test/fixtures/epic-focus.json` is the verbatim synthetic producer fixture from
cgwalters-forge/agent-board at `7448aaf1deaf840e2833b79d1a61cbb56193ca24`,
documented in its `docs/pass.md#epic-focus`, not live publication evidence.
Browser tests capture Focus at desktop and phone widths. No producer or
tracker settings are changed here.

## Today

Below Needs you, **Today** renders the optional `agent-board/today/v1`
publication from the same private holds snapshot and conditional poll. Board
activity counts landed, closed and opened since 00:00 UTC in the board's
repositories, not all repositories. **Observed starts** shows counts by kind
and pool from applying passes, not all Actions runs or completions. Incomplete
history and unknown pool history stay labelled; unavailable changes are not zero.
The section names its UTC day and observation time, labels observations over a
day old as stale, and distinguishes yesterday's activity and future clocks.
Revalidating the comment does not advance that observation time. Missing or
unreadable publications are explicit, not a claim of inactivity.

When published, the cost line shows the previous UTC day's API list-price total
against the configured weekly budget, not a daily allowance or remaining weekly
budget. Partial cost shows only a priced subtotal plus unread/unpriced counts;
in-progress runs are outside that coverage. Without `cost`, the entire line is
hidden. No new browser option, read, public cost publication or action is added.
The producer's `holds.today` remains off by default; caller activation is separate
in tracker `.github/pass.json`, with a compatible producer pin and private holds
destination unchanged. `prices` is needed for cost and `budget.weeklyUsd` for its
comparison target.

The concrete threat is unbounded publisher inventories growing the DOM. The
consumer bounds kind/pool maps to 32/16 entries, names to 32/64 characters and
counts to nonnegative safe integers, rendering names only as text. Invalid or
unknown-version extensions do not discard the inbox. `test/fixtures/today.json`
is the producer's synthetic serialization from agent-board `73b65e6`, not live
private publication evidence. Offline browser tests capture the full inbox and
focused Today sections at desktop and phone widths.

## Status and navigation

### Repository Chat dispatch (slice 1 of #315)

The concrete threats are leaking a private repository name into public workflow
inputs, attributing another tab's run to this dispatch, and repeating a dispatch
whose response was lost. The optional `dispatch` object in
`src/github/chat-config.json` is `null` (off) by default. When configured, the
existing Chat drawer becomes dispatch-only, with repository, issue/PR and Start
session fields; repository rows and issue/PR panes also offer Chat. It never
connects to the old direct-tailnet listener. The operator confirms each start;
fresh `/user` and repository visibility reads precede one dispatch with their
token. Actions read/write permission is required on the caller repository.

The object has `repo` (workflow caller), `workflow` (for example `dispatch.yml`),
`ref`, `runner` (a name in that caller's `AGENT_RUNNERS`) and `issue` (a public
context issue in the caller). It requires a caller implementing agentic-job#3320's
`docs/dispatch.md` contract, not the legacy tracker `session.yml`. The caller's
runner must already have session configuration and network access. No inference
address or attach credential belongs in the browser configuration.

Starts use `kind=research`, `session=true`, `idle-minutes=10`, the chosen `repo`
and item, and a fixed task to wait for questions. The upstream workflow requires
an item: without a selected issue/PR, the shown configured context issue is used
with `item-repo` naming the caller when different from the target. Both repositories
must be public and allowed by the caller's bounds. Research may propose a report
after the session; enabling change proposals is not part of this slice.

A returned run ID is shown immediately and read at most 24 times, five seconds
apart, stopping on completion or drawer disposal. A 204 links workflow history
without guessing a run; a lost response blocks another start in this drawer.
No dispatch retries, ACP bridge, attach-secret handling, conversation pane or
end-of-session change application is added. Tests are offline; a real session
and exchanging a message remain acceptance work for later slices.

**Status** (`#status`) shows the coordinator's newest published ProjectV2
status update as sanitized Markdown, with its publication age and an
**Expand** control. Missing, cached and unreadable sources are labelled;
they are not treated as evidence that work is healthy or complete. Titles
cut short by the publisher can be expanded from matching board context.
The read-only **Scheduler passes** panel shows the optional independent pass
publication: recent results and failed sections' first error lines, typed
starts with item/kind/pool/run links, no-start reasons and re-plan deadlines,
pool usage against allowed pace and reset countdowns, and running work or
PRs queued for merge or waiting for review. A fixed twenty-percentage-point
display threshold flags headroom only with complete fresh evidence that the
particular pool is unheld and has zero ready work. The
browser does not calculate scheduling policy or scrape logs. It uses the same
bounded comment read as the inbox. When independent history is absent, the
existing **Poller passes** publication remains visible with explicit legacy
coverage warnings. See [passes.md](passes.md) for the producer gap,
bounds, caller opt-in and offline screenshot reproduction. This is not yet
end-to-end completion of #245.
Header counts and the source-freshness line remain available on both pages.

The **Repositories** board folds each repository's published work and optional
maintainer observations into one table on Status. It reads `dispatchable_work`
and `pass_view` from the existing bot-authored holds snapshot, on the same
conditional poll as the inbox; there is no new page, poll or browser option.
Publication remains off unless the producer has `holds` and `follow` configured
(and `holds.passView` for run observations). **Run a pass now** opens tracker's
`poll.yml` workflow; it does not dispatch or bypass workflow permissions.

The four rows show **Ready** (published decisions minus held decisions),
**In flight** (running jobs and merge queue entries), **In review** (published
review waits), and **Blocked** (held decisions). Counts describe the publication,
not inferred live scheduling eligibility: ready includes work taken this pass,
and accepted plans can also be held, so per-kind counts are not additive.
Ready/blocked counts include omitted work detail; run counts say **listed**,
since omitted runs cannot be assigned to repositories. Each repository labels PR/issue completeness
and omissions; absent sources are unknown, not zero. Legacy pass-view coverage
warnings, observation ages, stale/future clocks and unavailable reads stay
visible. Running badges link to the run's actual repository and show elapsed
time **at observation**, not an unverified live timer. Maintainer observations
are folded under the same repository, not a separate board.

The concrete threats are unbounded publisher inventories causing unbounded
rendering and publisher-supplied addresses becoming navigation. The work parser
bounds repositories to 1,000, total item detail to 200, kind counters to 32 per
repository, counts to 1,000,000 and prose to 500 characters. Invalid extensions
are labelled without discarding the holds or pass view. Links use validated
repository/item/run components; prose is text, never dispatch authority.
`test/fixtures/dispatchable-work.json` replays the producer's documented v1
shape, including overlapping held/accepted plans and truncated detail.

Home's **Capacity** summary uses the existing `pass_view` pools and last
pass, including grouped no-start reasons even when some work started.
**Run a pass now** is manual and disabled until the operator requests a live
availability check. It requires fresh, complete, confirmed publication and
an under-pace pool whose reset has not passed. To prevent duplicate applying
passes, it reads the count of `poll.yml` runs in each active status, one
after another in lifecycle order (`requested`, `pending`, `waiting`,
`queued`, `in_progress`, then `waiting` and `queued` again); any count
prevents dispatch.
The order means a run changing status between two reads is still counted,
so a queued run starting mid-check is not missed, and the cost does not
grow with completed history. Status filters come from a search index that
can lag, and a rerun keeps its old place in the run list, so the unfiltered
list is read last, newest first, back through GitHub's 30-day rerun window;
any run in it not completed also prevents dispatch, and more than 6,000 runs
in that window refuses rather than reading further. A short page that leaves
runs unread according to `total_count` is incomplete, not evidence of idle:
the check refuses without dispatching or retrying. These same activity checks
protect the CLI's `run-pass`. The reads happen only on demand, not on the
snapshot poll.
The check expires after a minute. Confirmation
rechecks activity, viewer identity and repository write access, then sends
one `workflow_dispatch` on tracker's default branch with `apply: true`, using
the viewer's Actions read/write permission. A returned run ID links directly
to the run; a 204 links to workflow history without attributing someone else's
run. Receipts survive snapshot refreshes; errors never retry the write.
The workflow's concurrency guard remains necessary for a run arriving between
the last check and dispatch. A run waiting in the workflow's `next` job also
prevents dispatch; the browser does not attempt to bypass that chain.

The optional maintainer observations read bot-authored
`agent-board/maintainer-report/v1` fenced blocks from the same configured
report-comment page as Poller passes. Publication is off when the producer's
`maintainerReport` setting is absent; there is no new browser option or read.
Each maintained repository has folded details, using its newest published run: time,
preview/apply mode, open PR counts by poll action/state, needs-you PRs and
reasons, and the source comment link. Runs older than two hours are **stale**;
future clocks and unavailable/cached reads are labelled separately. Undecided
repositories have unknown coverage, not an empty inventory.

The producer's [published schema](https://github.com/cgwalters-forge/agent-board/blob/main/docs/maintainer-report.schema.json)
optionally includes `merge_queues`. The row shows the number of published
entries for a decided repository, including zero for an explicit empty queue.
An older producer, missing repository key, unread (`null`) queue or undecided
repository leaves the depth unknown. Queue-removal events are never counted.
The consumer ignores unknown fields, renders prose as text, and shows invalid
blocks as error rows without losing valid reports or the pass view. To prevent
unbounded DOM and publisher-address navigation, it bounds comments to 60,000
characters, blocks per comment to 8, displayed repositories, records per array
and total PR inventory and queue entries to 1,000 each, state groups to 100
and strings to 4,096 characters; links use validated typed components.
Overflow is labelled.
`test/fixtures/maintainer-report.json` is synthetic offline replay of the
published v1 schema, not live publication evidence.

### Pass publication contract (producer dependency)

The legacy shape is published by agent-board#729 with off-by-default
`holds.passView`; it is not the richer independent history proposal above. The
legacy producer currently omits section errors, re-plan deadlines, readiness
and PR queue/review-wait coverage. Its `complete` only means runs were listed,
not that all those sources were read. Empty lists remain unknown. The exact
synthetic JSON shape is [test/fixtures/pass-view.json](../test/fixtures/pass-view.json):
add optional `pass_view` beside `needs_you` in the existing
`agent-board/holds/v1` bot comment. Its schema is `agent-board/pass-view/v1`.
Absent means off/older producer, never a healthy idle pass. There is no new
browser option or independent poll. The publication grants no authority: the
Live agents actions above only choose which listed run to act on, and read it
fresh from GitHub before writing.
Publication is independent of `holds.needsYou`; the legacy producer's opt-in
is `holds.passView`, not `holds.needsYou`.

The concrete threats are unbounded publisher data creating unbounded DOM,
and publisher-supplied addresses becoming navigation. The consumer accepts
at most 8 passes, 12 sections per pass, 32 starts and 32 reasons per pass,
16 pools and 100 in-flight records. It rejects an invalid extension as a
whole without losing the inbox. Display strings are single-line, at most
240 characters; names are lower-case tokens up to 32 characters. Links are
constructed only from validated GitHub repository/item/run/PR components.
Unknown fields are ignored. Publisher prose is text, not Markdown or authority.

The original legacy consumer requirements below are not evidence that #729
emits every fact. The independent producer handoff is in docs/passes.md.
Unimplemented legacy requirements were:

- Use the fixture's exact keys and enums. `passes` is newest first; `at` is
  each pass's clock and `observed_at` is the latest pool/in-flight observation.
  `result` is success/partial/failure, with per-section success/skipped/failure.
  A failed section requires `error`: only the first sanitized error line,
  never a request URL, response body, credential, inference, broker or tailnet
  address. Successful/skipped sections have null error. Do not scrape logs:
  collect these from the same typed outcomes that generate the log lines.
- `started` records confirmed starts (not preview intentions), with the run's
  actual repository and numeric id. Preserve accepted dispatches even if later
  bookkeeping fails. If no start was confirmed, publish `reasons`: no-ready-work,
  replan-delay with its `until` timestamp, capped, or held; `item: null` denotes
  a global reason. Missing reasons are unknown, not no-ready-work.
- Pools carry used/allowed percentages, reset clock, ready count and the
  producer's `under_pace` assessment. Null means unknown; do not turn failed
  readings into zero. The app uses no independent under-pace threshold.
   In-flight records distinguish running (same fields as a start), merge-queue
   and waiting-review (typed repository and PR number).
   Running records may additionally publish `started_at`, an ISO timestamp or
   null. The home summary ticks runtime from it on the browser clock only while
   `observed_at` is under an hour old; past that it measures to `observed_at`,
   so stale samples cannot imply a job is still running. Missing
   or future start clocks show runtime unknown. The fixture includes this
   optional field; older publications remain readable. The producer must supply
   it to show elapsed runtime rather than unknown.
- `complete` describes the current source sample, not a guarantee that every
  historical pass was observed. `omitted` counts records dropped outside passes;
  each pass's `omitted` counts its dropped starts/sections/reasons. All are
  nonnegative integers up to 1,000,000. Keep publication within the comment cap,
  dropping pass-view detail before inbox identities, marking omissions and
  incomplete sources rather than claiming idle health. Publish failed sections
  even when scheduling fails; gaps from a failed publication remain unknown.
  The publication mechanism must not rely on the existing success-only holds
  path to report a failed pass. Carry at most the seven previous pass records;
  do not refresh old observation clocks when sources fail.

The panel labels observations older than an hour as stale, future clocks as
suspect, and read/cache failures as unavailable rather than current. A GitHub
304 cannot advance the pass's observation time. Partial or omitted data never
claims an empty queue. Fixtures and replay tests are offline evidence only;
producer publication and authenticated live parity remain acceptance work.
This run cannot file the required cross-repository producer issue; the contract
above and exact fixture are the handoff for that issue/linked PR.

The old Agents, Board, Activity, Usage, Ops and Dashboard hashes resolve to
Status. Maintain and Chat resolve to Needs you. Old board-filter hashes
also resolve to Needs you, without applying an obsolete board filter.
No old route starts the removed view's reads. A bare `#` returns to the
page last shown; a fresh visit starts on Needs you.

**Deep links** open item and PR panes independently of queue membership:

- `#item/PVTI_NODE_ID` opens a board item; `#item/I_NODE_ID` opens an issue.
- `#issue/OWNER/REPO/N` opens an issue by repository and positive number,
  retaining its Workstream fields when present.
- `#pr/OWNER/REPO/N` opens the PR review pane.

Missing items are read on demand with the signed-in viewer's token, using
one bounded GraphQL query rather than a new poll. An unreadable item stays
on its route with an error; `r` retries. Membership checks inspect at most
100 projects and report indeterminate membership rather than guessing.

Keys: `q` opens Needs you, `s` opens Status, `j`/`k` move between visible
rows, `o` opens, `u` goes back, `r` reloads, `b` captures and `?` lists help.
In a PR, `n`/`p` step through files, `j`/`k` through hunks, `v` marks viewed,
`x` folds, `s` switches unified/split, `[`/`]` step commits, `g` walks the
review guide, `c` comments and `a` approves after confirmation. Editing a
field suppresses navigation shortcuts.

## Reviewing and capturing

The PR pane shows the description, CI checks, full commit messages and
unified or split diffs. It supports file/range selection, syntax and word
highlighting, expandable context, versioned Viewed marks, inline comments,
and the bot's advisory review guide. Guides are trusted only from the bot's
COMMENT reviews at their named head; stale guides are labelled. Approve
targets the shown head and refuses to approve if it moved. Request changes
and Comment send your text. Review confirmations name unseen files and guide hotspots.

**Make it mine** edits a bot forge PR's title, description and commit
messages for human-text upstreams. It requires your authorship confirmation,
rejects remaining generated-attribution lines and unsafe titles, shows every
change, checks rewritten commit trees/parents/authors and moves the branch
only if it still has the shown head. Promotion is a separate `/promote
--human-text` comment after GitHub confirms the push. Only supported bot
branches in forge forks are eligible; no code editing is offered.

After a successful action, the queue reflects it immediately and refreshes.
**Auto-next**, remembered per browser, moves to the next pending Needs you
entry in the order shown. It stays put after failures, comment-only reviews,
navigation elsewhere or unsent text elsewhere. Pending review verdicts bridge
GitHub's search lag for up to five minutes.

The operator-only **capture bar** files a tracker issue labelled
`needs-triage` and adds it to Workstream. It supports an optional repository,
Priority, labels and Epic; partial failures retain the created issue link
and explain what to do next rather than inviting duplicate filing. A lost creation
response disables retry until the tracker is checked. Esc collapses without
losing text; the draft survives reloads in localStorage and is deleted on
sign-out.

Review drafts are configured by `src/github/review-draft-config.json`.
The Send card shows the review body and inline comments at the draft's head.
Sending ticks the tracker issue's approval box with a hash of the exact draft
shown, and refuses newer drafts, changed bodies or moved/closed PRs. The
tracker workflow must validate that approval before posting the review.
**Draft review** creates and dispatches a drafting issue, with duplicate
claims and failed-dispatch retries guarded across tabs.

## Reads, authentication and caching

All GitHub data is fetched in your browser from `api.github.com`. The queue
is polled every minute while visible, with conditional requests and bounded
concurrency. Remaining reads serve the inbox, published status or an open
item; there is no session-chat socket, workflow discovery for chat, activity
feed, cost chart or operations-panel polling. The CLI's richer read-only
state loaders remain separate consumers.

The header says when the current page was checked, based on its oldest source;
failed reads do not count. It also explains hidden-tab pauses, low budgets,
rate limits and stalled requests. Polls are single-flight, use backoff, stop
while hidden, and recover when a suspended page resumes. Rate-limit recovery
retries reads, not writes.

With **remember** enabled, responses are cached in IndexedDB for the login
(roughly 50 MB, dropping entries unconfirmed for seven days). Cached data is
marked until GitHub revalidates it. Without remember, the cache is in memory.
Signing out or GitHub rejecting the token clears it.

## Command line

`review-queue` prints the ranked queue read-only. CLI filters remain available:

```sh
npm ci && npm run build
npx review-queue --text
npx review-queue --json --filter composefs
npx review-queue --filter org:composefs+P0
```

`composefs` means upstream work, excluding jmarrero-bot and jmarrero-forge;
`infra` means those two. See [queue-json.md](queue-json.md) for the
`review-queue/v1` schema. Authentication uses `GH_TOKEN`, then `GITHUB_TOKEN`,
then `gh auth token --hostname github.com`. It needs `read:project` for the
board and never answers, approves or reruns anything.

`control-app` gives the controller the app's own state, as JSON with links,
read from the pass's published snapshot as Home and Status read it:

```sh
npx control-app status                  # agents in flight (Actions API), capacity, last passes and no-start reasons
npx control-app needs-you               # Home's Needs you cards, in order, with the list's freshness
npx control-app act-now                 # Home's Act now shortlist
npx control-app queue --filter infra    # review-queue's queue
npx control-app repo cgwalters-forge/review
npx control-app changes --since 2026-11-07T08:00:00Z
```

`control-plane` remains an alias for one release. The JSON schema stays
`control-plane/v1` for compatibility. The repository and Pages URL remain
`review`; this is an application rename, not a repository move.

With the existing opt-in `CONTROL_APP_SERVICE`, `needs-you` labels its read as
received from the service, not freshly checked on GitHub. Receipt does not
advance the producer's validation clock. Its note retains list age, source
shortfalls, omitted/unreadable counts and missing-list explanations alongside
service coverage or refresh errors; partial or unavailable decisions never
report `settled: true`. Without this setting, direct GitHub reads are unchanged.

Service HTTP reads have a 15-second timeout and a 2 MiB body limit. A connection
failure, including one after response headers or a partial body, reports
`Service decision unavailable` without exposing transport error details. Failed
reads do not fall back to GitHub or treat a partial document as an empty queue;
the CLI exits unsuccessfully. Oversized bodies retain a distinct size-bound error.

Its read commands send only GET requests. Its act commands run the code
behind the app's buttons, with the same checks, and write only with `--yes`;
`--dry-run` makes the same reads and prints the writes it would send. Only
`cancel`, `retry` and `redispatch` need the published pass view, for its
list of runs: `dispatch` checks the item isn't running only where the view
is published (its document says `runningChecked`), and `run-pass` leaves
the button's capacity checks to the caller, still refusing while a pass is
active:

```sh
npx control-app dispatch cgwalters-forge/review#278 --kind implement --brief "..." --dry-run
npx control-app cancel https://github.com/cgwalters-forge/tracker/actions/runs/123 --yes
npx control-app retry 123 --yes         # or redispatch: repeat the failed item's newest plan
npx control-app run-pass --dry-run
npx control-app file --epic 976 --title "..." --label infra --dry-run
```

`approve`, `merge`, `close`, `comment` and `fold` are still to come.

## Development and hosting

Node.js 22.18 or later is required for native TypeScript type stripping:

```sh
npm ci
npm run check
npm run dev
```

`check` runs TypeScript, unit tests and the build into `dist/`; `dev` serves
<http://127.0.0.1:8787/>. Operator actions follow agent-board's
[published contract](https://github.com/cgwalters-forge/agent-board/blob/main/docs/operator-actions.md),
with pinned vendored schema and fixtures. The
[review workflow](../.github/workflows/review.yml) uses the bounds in
[workflow/review.toml](../workflow/review.toml); its approval requires
`AGENT_REAL_REVIEWS=true` and the configured inference credentials.

GitHub Pages publishes <https://jmarrero.github.io/review/> on pushes
to main. Sign in by pasting a personal access token. It stays in
sessionStorage, or localStorage with remember, and goes only to GitHub.
A short-lived classic token with `public_repo` and `read:project` covers
public work; use `repo` for private repositories. A fine-grained token is
limited to its resource owner and needs Pull requests and Issues read/write;
Make it mine also requires Contents read/write. Workflow-changing PRs need
the classic `workflow` scope or fine-grained Workflows write permission.
See [design.md](design.md) for sign-in relay plans.

The writes are real: test live actions only against throwaway items.
