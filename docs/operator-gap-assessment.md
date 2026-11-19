# Operator inbox gaps against Paperclip — 3 November 2026

> This text is LLM generated.

For [review#227](https://github.com/cgwalters-forge/review/issues/227): the
operator wants to see and answer work here, rather than receive another list
of links in chat. **The evidence below supports three additional gaps, not five.**
The larger problems that more often force the operator to leave the app—missing
concrete questions, incomplete coverage, unavailable writes and missing run
context—are already assigned.
Counting them again would create a longer backlog, not a better inbox.
These are issue-ready suggestions for the controller, not filed issues or
implemented features. Ranking estimates frequency and consequence from this
snapshot and the reported workflow; it is not measured operator telemetry.

## Evidence boundary and deployment identity

Review main and this assessment's source base were
`f71d4e46814b4660b27714a1ab228e39b857a586`; the GitHub main API confirmed that
SHA during inspection. Paperclip was inspected at
`909d86b59a841d5f014cdb84909956d00625d9d0` (its remote HEAD when cloned).
All Paperclip links below pin that commit; this is not a claim about its cloud
deployment or any operator's Paperclip installation.

Review's [Pages run](https://github.com/cgwalters-forge/review/actions/runs/41704536404)
succeeded at the review SHA. Deployment `7528677052` reported success at
`2026-11-03T19:35:45Z` for <https://cgwalters-forge.github.io/review/>.
Publicly fetched `app.js` and `style.css` matched a clean local `npm run build`:

| Asset | SHA-256, both local and served |
| --- | --- |
| app.js | `716198de84f9caaf362f2411ed1271af2506aaee5e02b222fe7a76b9159ebe91` |
| style.css | `fdc30d6fb3bf80e0b5d81725eee6b37464a36e2b9a120439745c17ff2c218754` |

That verifies the served assets at observation time, not signed-in behavior,
private publication contents, cache state on the operator's device or future
deploys. The legacy Pages-build endpoint returned 404; deployment statuses,
the Actions run and asset comparison supplied the identity instead.

The [fixture][snapshot] is the approved redacted publication at
`2026-11-03T17:41:35.039037224Z`.
[Its provenance PR](https://github.com/cgwalters-forge/review/pull/226) says
spend/overhead and one security-sensitive item were removed. Do not infer
absence of costs or of that item from this fixture. It contains 12 ranked
asks and 12 descriptors, no groups, no approval heads and no supported
descriptor actions. Six descriptors are `missing-concrete-decision`; the
first three P0 titles are only “labelled needs-human”. Items and digest are
partial, with 85 omitted asks. Twelve is therefore not the operator's total
backlog. The older top-level `holds` list is not an extra inbox to append.

## Already known: excluded after re-reading bodies and comments

The tracker sub-issue API returned these six open children. This list includes
this assessment itself; closed historical children are not new candidates.
Issue comments are decision/status evidence, not instructions for this run.

| Open child | Excluded work, including latest context |
| --- | --- |
| [review#221](https://github.com/cgwalters-forge/review/issues/221) | Honest exact group membership, no representative write, real-data replay. #224 shipped inspect-only groups. The latest plan acknowledges the real fixture has zero groups; constructed variants must not be called observed real groups. |
| [review#222](https://github.com/cgwalters-forge/review/issues/222) | Per-request actions, promotion, receipts and partial outcomes. #225 shipped descriptor-aware refusals; latest decision authorizes promotion by commit-bound APPROVE, not bare `/promote`. Reply/close/merge/enqueue refusals are accepted until publication offers those actions. |
| [agent-board#640](https://github.com/cgwalters-forge/agent-board/issues/640) | One producer-owned inbox including decisions/drafts, counts, source completeness/clocks, recent controller decisions/run receipts, working/waiting/retry/WIP and relevant budget/pool holds. Includes publication/caller integration, not just a schema. Generic ask quality and coverage belong with this producer read-model work, not a new dashboard proposal here. |
| [review#223](https://github.com/cgwalters-forge/review/issues/223) | Consume that publication, delete browser discovery/ranking, immediate outstanding counts, retained drafts, freshness and collapsed context; measure request/JS reduction. |
| [agentic-job#536](https://github.com/cgwalters-forge/agentic-job/issues/536) | On-demand ACP session, runtime writes, reconnect and real tailnet acceptance. Latest triage says bridge/spec/model/probes exist; runtime writes await credential decisions, real end-to-end checks await wrapper/tailnet work. Not a new “add chat” gap. |
| [review#227](https://github.com/cgwalters-forge/review/issues/227) | This comparison; no follow-up issue creation in this run. |

The parent [tracker#976](https://github.com/cgwalters-forge/tracker/issues/976)
also excludes rediscovering the general focused/live/actionable-in-place
requirements. Every suggestion below stays in Needs you, its existing item/PR
pane or the existing Status surface. Publication is producer-owned; no new
tabs, scheduler, activity poller, browser interpretation of prose commands or
new orchestration transport is proposed.

## Operator walk-through, not a feature scorecard

**Decide what needs me.** Review preserves producer Priority/age order and
truthfully warns about incompleteness ([card selection][cards],
[renderer][renderer]). The first three generic asks still require inspection;
later asks contain real alternatives and recommendations. A fresh timestamp
does not make the missing question concrete. This is primarily existing
producer/action work, not an additional gap.

Paperclip's [operator guide][pc-approval-doc] describes pending approvals,
rejection and revision requests. Its [approval detail][pc-approval] actually
loads comments and linked tasks and implements those mutations. Those are
Paperclip governance approvals, not evidence that it safely promotes a forge
PR or implements review's exact-head semantics. Its [Inbox][pc-inbox] mixes
approval/run/join-request attention with tasks. The useful comparison is
context next to a decision, not copying agent hiring or CEO controls.

**Inspect, then answer.** Review already has guarded inline answers, document
choices, draft sending, head-checked approval and proposal execution; it is
incorrect to say “no inline answers”. [Main-hook tests][main-tests] exercise
real handlers with mocked GitHub, including changed asks, wrong viewers and
uncertain receipts. This snapshot publishes no supported reply actions, but
that does **not** prove production answer forms are absent: the current
renderer checks the named descriptor capability for Approve/Do, while Answer
can still call its target-reading hook without checking the `reply` capability.
The diagnostic below omits that hook, which alone explains why it shows no forms.
Signed-in eligibility and any mismatch with the published reply policy need
verification under #222, not a new gap or a mobile rendering claim.
Paperclip has approval comments/actions and conditional inline
resolution ([attention tests][pc-attention]); neither proves universal
free-form answers on every inbox row. Finishing review's write coverage is
#222/#640 work.

**Check what happened or who is working.** Review's item pane already loads
comments, gists and tracker sub-issues, but displays only the last five
comments ([loader][context], [view][context-view], [limit][comment-limit]).
Status displays published Markdown, not a per-agent control plane. Paperclip
has agent run history, including selecting an older run when the recent list
is empty ([source][pc-agent], [desktop/mobile test][pc-agent-test]), and task
history expansion ([source][pc-task], [tests][pc-task-tests]). Recent working,
waiting, retry and outcome context is already #640/#223. Older task evidence
is a narrower additional gap below; a new Agents tab is not justified.

**Understand resource pressure and purpose.** Paperclip's [Costs source][pc-costs]
has summary and agent/project/provider/biller breakdown queries and date
windows; [accounting tests][pc-accounting] cover usage availability. The useful
shape is `period → pool/provider → task/agent contribution → known/unknown`,
not an amount or a public financial dashboard. Review intentionally removed
usage-dashboard polling; budget/pool hold reasons and reset/observation facts
are already #640. This redacted snapshot doesn't provide evidence of an additional
cost-visibility defect. Paperclip [Goals][pc-goals] and its [API docs][pc-goal-doc]
provide organization-scoped goal hierarchy/project links. Review has Org and
tracker epics/sub-issues instead. There is no evidence this operator needs a
company hierarchy editor; only typed decision context is useful (rank 1).

**Return later or from a phone.** Review's From people fold handles human
mentions/review requests and notification mark-read, with explicit token
limitations ([documentation](index.md#needs-you), [tests][people-tests]). It is
not change tracking for bot decision cards. Paperclip's Inbox has per-item
read/unread state and dismissals ([source][pc-inbox], [tests][pc-inbox-tests]);
this does not establish OS push delivery or notification reliability.
Review's CSS wraps titles and identifiers, uses 16px touch fields and retains
focused drafts ([CSS][css], [tests][style-tests]). Paperclip has mobile-specific
run handling, but no signed-in phone comparison was performed. The narrow
replay below supports a density observation, not a separate proven mobile bug.

### Shipped, gated, proposed, unverified

The review behaviors above are in source on the pinned main, not claims based
on its older [design proposal](design.md). Action refusals are shipped;
commit-bound promotion completion and unified publication are open work, not
already accepted features. The replay is not a session-chat integration test.

Paperclip's streamlined shell is [default-on][pc-default], even during settings
loading/failure. Its combined Inbox + Tasks navigation is explicitly
[opt-in, off by default][pc-combined]; it is not the default comparison and
is not a reason to add tabs here. Task thread presentation also switches
between classic and newer components in the inspected source. Source/tests
support the capabilities cited, not production availability of every branch.
Paperclip tests were inspected, not executed, and its server was not started.

## Additional ranked entries for the controller

### 1. Publish typed related evidence beside a decision

**Problem:** the operator must copy a reference or open the question issue
and hunt again for the actual work. The fixture's tracker#12 names upstream
PRs #408/#409, tracker#308 names a forge PR, tracker#7 names alternative stack
members, and tracker#430 names a blocked child. These are references inside
display text, not explicit navigable context in the card. [The card title
links to the ask itself][renderer], while the [consumed contract][ask-contract]
has one action target and optional PR-group membership, not general related
evidence or an epic/purpose breadcrumb. Existing item sub-issues are not a
replacement for links on the question card. Paperclip's [linked approval
tasks][pc-approval] illustrate the value without requiring its org model.

**Fix / owner:** **agent-board publication data**, with review consumption
only after the contract exists. Publish a bounded, typed `related` set with
relationship labels (reviewed PR, prerequisite PR, blocked child, parent epic),
safe reference parts and an observation time. Include only relationships the
producer can establish; unknown stays unknown. Review reuses its existing
item/PR deep links in one collapsed card section. Do not turn URLs or commands
in question text into authority, infer a group or add actions. This is distinct
from #221's exact group members and #222's per-member action eligibility, and
from #640's recent status/outcome context.

**Size:** **M**—one producer contract extension plus a small existing-card
reader; relationship attribution/validation is the work, not new navigation.

**Acceptance:** on a derived, clearly labelled replay of these four asks,
reach each published related item in the existing pane and return to the same
unsent decision. No arbitrary published URL is followed; malformed/foreign
references stay visibly unavailable; no extra discovery request occurs on
initial load or unchanged poll. Cap the list (for example eight references
per ask), disclose omissions and do not alter producer order/counts.

### 2. Distinguish an unseen decision revision from a familiar pending ask

**Problem:** a return visit presents old and changed bot questions alike. The
snapshot includes several multi-day waits; repeatedly rereading them is work,
while overlooking a changed premise is consequential. The publication has
per-request identity/revision but [review keeps only quality/forge/actions][ask-contract].
Card signatures retain DOM during a session, not “seen this revision” across
visits. Global changed/validated clocks and human notification read-state do
not answer which bot decision changed. Paperclip has [read-state integration][pc-inbox]
and [unread-row tests][pc-inbox-tests]; copy the distinction, not its tabs or
archive behavior.

**Fix / owner:** **review**. Retain a validated opaque per-request revision
from the existing publication, and record locally which revision the viewer
explicitly inspected. Display “new/changed since inspected” on the existing
card; use the same session/remember/sign-out boundaries as the app's cache.
Do not mark a decision done, hide it, reorder it, release a hold or mark a
GitHub notification read. If identity/revision is missing, show unknown.
No server notification system or new poll is necessary.

**Size:** **M**—small parser/view change, but identity changes, partial reads,
sign-out and persistence need careful tests. This is recognition state, not
#223's outstanding-count or #640's outcome-publication work.

**Acceptance:** inspect one request, revisit unchanged, then replay a new
revision under the same target: only the last is “changed”. A refreshed
validation clock alone never marks all cards changed; a partial/carried source
cannot mark unseen work read. Counts/order and retained text remain unchanged;
sign-out clears viewer state. Test session-only and remembered modes.

### 3. Let the existing item pane reveal older task comments

**Problem:** after seeing a current ask or receipt, the operator cannot inspect
an earlier answer or rationale here once it falls outside the last five
comments. [loadContext][context] reads comments but slices them; [contextView][context-view]
offers “Latest comments”, not an older-history disclosure. This is visible
source behavior, not proof that any particular omitted comment in the redacted
snapshot is decisive. It is less frequent than identifying the work itself.
Paperclip's [task history source][pc-task] and [older-history tests][pc-task-tests]
provide the relevant contrast; its agent roster and live-run controls do not.

**Fix / owner:** **review**. Add an explicit, bounded “Earlier comments”
disclosure to the existing on-demand item context, reusing the comment renderer
and GitHub cache. Keep chronological order, attribution, links and a visible
history limit/error. No activity feed, run discovery, per-agent polling or
historical reconstruction from bot prose. Recent run receipts/agent state
remain #640/#223; this entry is only older forge conversation evidence.

**Size:** **S**—existing loader, cache and renderer; selection/disclosure and
tests rather than a new publication or service.

**Acceptance:** a mocked item with seven comments initially shows the last
five, reveals the two earlier ones only on demand, and preserves an unsent
answer. A longer thread has a stated bound and explicit incomplete/error
state, never an unbounded history fetch. No new cold-inbox or poll requests.

## Replay and verification record

This patch is **documentation-only**: no product code, replay tests, fixtures,
dependencies or configuration were changed. Existing checks were still
run to support the assessment. No token was supplied to the UI; no live writes
or private source reads were made.

Commands and results:

* `npm ci`: exit 0; installed dependencies. Audit reported two existing
  vulnerabilities (one high, one critical); dependency remediation is outside
  this assessment.
* `node --test test/holds.test.ts test/inboxview.test.ts test/maincards.test.ts test/style.test.ts test/peopleview.test.ts`:
  exit 0, 133 passed, zero failures, test-runner duration 3.86 seconds.
* `node /tmp/opencode/replay.mjs`: temporary diagnostic using the existing
  `test/helpers.ts` jsdom setup, real parser/card selector/renderer and frozen
  fixture time. First attempt exited 1 because the diagnostic looked for
  Show more inside the list; production inserts it as a sibling. Corrected
  diagnostic exited 0: 12 asks/cards in fixture order, zero refusals/groups,
  five initially drawn, 12 after two Show more clicks, no forms. It supplied
  no action/detail hooks and forbade fetch, so it checks display/selection,
  **not** full signed-in main orchestration or write eligibility.
* `chromium --headless --no-sandbox --disable-gpu --no-proxy-server --screenshot=/tmp/opencode/replay-desktop.png --window-size=1280,1000 file:///tmp/opencode/replay-initial.html`
  and the same command with `replay-narrow.png`, `390,844`: exit 0. Inspected
  both screenshots of the frozen rendered cards with the real stylesheet.
  Desktop shows all five initial cards; narrow view shows approximately three
  and the start of the fourth. Titles/identifiers wrap and the partial-source
  notice remains readable. Generic titles and repeated unsupported-action
  folds consume substantial phone space. No clipped title defect was observed.
  Chromium emitted desktop-service/component-update warnings, not a render
  failure. These are desktop Chromium viewports, not touch/Safari/keyboard
  emulation. Screenshots contain only approved redacted data and no usage
  amounts; binaries are deliberately not added to the patch.
* `npm run build`: exit 0. `sha256sum dist/app.js dist/style.css` and
  `curl -fsS https://cgwalters-forge.github.io/review/app.js | sha256sum`
  (also `style.css`) gave the matching hashes recorded above.

To repeat the display diagnostic without a bespoke app/server: use
`installDom()` and `fixture()` from `test/helpers.ts`; pass the fixture's
`needs_you` to `parseNeedsYou`, then `publishedCards`, then `fillInbox` with
`now = Date.parse(fixture.at)`, `render = createRenderer(window)`, `mayAct = true`
and no action/detail hooks. Attach the list to a parent **before** filling it;
click the parent's `.inbox-more` twice. Save the initial DOM with the real
`static/style.css` and a viewport meta tag for the Chromium commands above.
This is the existing mocked DOM harness path, not a newly committed replay
test. The synthetic group replay in `test/inboxview.test.ts` remains synthetic.

Evidence links were checked for local file/anchor existence and pinned GitHub
file/line existence, and the linked issues/deployment/run were read through
GitHub. Deduplication used the complete open-child list above and latest issue
comments, not just titles. New text reproduces no cost amounts, private
publication payloads or credentials; the fixture was not copied or modified.

## Uncertainties and recommended next slice

The assessment found **two fewer additional gaps than the requested minimum of five**.
Notifications beyond in-app read state, per-task usage attribution, a new org
model, push delivery and mobile interaction defects lack sufficient operator
evidence to rank as separate new issues. Layout density is real in this
replay, but its chief causes are the already-known generic asks and refusal
coverage, not proof that review needs a mobile redesign.

Signed-in deployed acceptance, real request writes, tailnet sessions, touch
keyboard/back navigation and Paperclip deployment behavior remain unverified.
The partial snapshot cannot measure whole-backlog frequency or an earlier
comment's decision value. Recheck open children before filing: parallel work
may close issues or subsume these suggestions after this assessment.

**Top next slice:** finish #640/#223/#222's existing concrete-question and
in-place-action acceptance before expanding scope. Of the genuinely additional
entries, start with **rank 1's bounded related-evidence publication**, then its
existing-pane reader: it removes the second navigation hunt on real multi-PR
questions without restoring dashboards or browser orchestration. No new option
or control is introduced by this documentation patch.

[snapshot]: https://github.com/cgwalters-forge/review/blob/f71d4e46814b4660b27714a1ab228e39b857a586/test/fixtures/needs-you-real-2026-11-03.json
[cards]: https://github.com/cgwalters-forge/review/blob/f71d4e46814b4660b27714a1ab228e39b857a586/src/github/inbox.ts#L107-L137
[renderer]: https://github.com/cgwalters-forge/review/blob/f71d4e46814b4660b27714a1ab228e39b857a586/src/github/inboxview.ts#L219-L290
[ask-contract]: https://github.com/cgwalters-forge/review/blob/f71d4e46814b4660b27714a1ab228e39b857a586/src/github/holds.ts#L40-L93
[context]: https://github.com/cgwalters-forge/review/blob/f71d4e46814b4660b27714a1ab228e39b857a586/src/github/backend.ts#L202-L276
[context-view]: https://github.com/cgwalters-forge/review/blob/f71d4e46814b4660b27714a1ab228e39b857a586/src/github/view.ts#L522-L551
[comment-limit]: https://github.com/cgwalters-forge/review/blob/f71d4e46814b4660b27714a1ab228e39b857a586/src/github/config.ts#L154
[main-tests]: https://github.com/cgwalters-forge/review/blob/f71d4e46814b4660b27714a1ab228e39b857a586/test/maincards.test.ts
[people-tests]: https://github.com/cgwalters-forge/review/blob/f71d4e46814b4660b27714a1ab228e39b857a586/test/peopleview.test.ts
[style-tests]: https://github.com/cgwalters-forge/review/blob/f71d4e46814b4660b27714a1ab228e39b857a586/test/style.test.ts
[css]: https://github.com/cgwalters-forge/review/blob/f71d4e46814b4660b27714a1ab228e39b857a586/static/style.css#L356-L374
[pc-approval-doc]: https://github.com/paperclipai/paperclip/blob/909d86b59a841d5f014cdb84909956d00625d9d0/docs/guides/board-operator/approvals.md
[pc-approval]: https://github.com/paperclipai/paperclip/blob/909d86b59a841d5f014cdb84909956d00625d9d0/ui/src/pages/ApprovalDetail.tsx#L32-L134
[pc-inbox]: https://github.com/paperclipai/paperclip/blob/909d86b59a841d5f014cdb84909956d00625d9d0/ui/src/pages/Inbox.tsx
[pc-inbox-tests]: https://github.com/paperclipai/paperclip/blob/909d86b59a841d5f014cdb84909956d00625d9d0/ui/src/pages/Inbox.test.tsx#L1625-L1688
[pc-attention]: https://github.com/paperclipai/paperclip/blob/909d86b59a841d5f014cdb84909956d00625d9d0/ui/src/lib/attention.test.ts#L89-L99
[pc-agent]: https://github.com/paperclipai/paperclip/blob/909d86b59a841d5f014cdb84909956d00625d9d0/ui/src/pages/AgentDetail.tsx
[pc-agent-test]: https://github.com/paperclipai/paperclip/blob/909d86b59a841d5f014cdb84909956d00625d9d0/ui/src/pages/AgentDetail.history.test.tsx
[pc-task]: https://github.com/paperclipai/paperclip/blob/909d86b59a841d5f014cdb84909956d00625d9d0/ui/src/pages/IssueDetail.tsx#L1490-L1517
[pc-task-tests]: https://github.com/paperclipai/paperclip/blob/909d86b59a841d5f014cdb84909956d00625d9d0/ui/src/pages/IssueDetail.test.tsx#L2051-L2181
[pc-costs]: https://github.com/paperclipai/paperclip/blob/909d86b59a841d5f014cdb84909956d00625d9d0/ui/src/pages/Costs.tsx#L298-L392
[pc-accounting]: https://github.com/paperclipai/paperclip/blob/909d86b59a841d5f014cdb84909956d00625d9d0/ui/src/pages/AgentDetail.accounting.test.tsx
[pc-goals]: https://github.com/paperclipai/paperclip/blob/909d86b59a841d5f014cdb84909956d00625d9d0/ui/src/pages/Goals.tsx
[pc-goal-doc]: https://github.com/paperclipai/paperclip/blob/909d86b59a841d5f014cdb84909956d00625d9d0/docs/api/goals-and-projects.md
[pc-default]: https://github.com/paperclipai/paperclip/blob/909d86b59a841d5f014cdb84909956d00625d9d0/ui/src/hooks/useStreamlinedUiEnabled.ts
[pc-combined]: https://github.com/paperclipai/paperclip/blob/909d86b59a841d5f014cdb84909956d00625d9d0/ui/src/hooks/useCombinedInboxTasksEnabled.ts
