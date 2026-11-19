# Proposed operator actions

> This text is LLM generated.

Proposals are disabled by default. Enable them only by editing
`src/github/action-config.json` on the repository's default branch: set
`operator`, `planner`, `tracker` (`OWNER/REPO`), and an explicit
`repositories` allowlist. `project` is the only GitHub project URL proposals may
change, or empty to refuse project-field actions. `org` is likewise the only
organisation whose Actions variables and rulesets proposals may change, or
empty to refuse those kinds of actions. No dispatcher or proposal can widen this
configuration. The allowlist should start with the forge-native repositories;
upstreams require an operator-reviewed configuration change.

The shipped allowlist is jmarrero's harness: jmarrero-forge/actions,
jmarrero-forge/agenthome, jmarrero-forge/tracker and jmarrero/review. It leaves
out jmarrero/atomic-setup, which holds the broker policy but also his desktop
image and bot host, so no proposal can act there. The app does not read
tracker's pass config; its existing bot-PR search is already
repository-independent, so broker PRs requesting the operator's review still
appear without an extra search or repository list.

This prevents a proposal from borrowing the viewer's token to write outside
the approved repositories or project. Only the configured operator can execute, using
the existing browser GitHub client and their own token. Only comments by the
operator or planner count; edited comments require a named, trusted last
editor, matching agent-board's job-plan rule.

## Contract

agent-board's [operator actions](https://github.com/cgwalters-forge/agent-board/blob/main/docs/operator-actions.md)
document is the contract: the fence, field names, action types and limits are
defined there, not here. `operator-actions.schema.json` and
`test/fixtures/operator-actions.json` are byte-for-byte copies of agent-board's
`docs/operator-actions.schema.json` and `fixtures/operator-actions.json` at the
commit recorded in `operator-actions.vendor.json`, with their git blob IDs.
`npm test` fails if either file differs from those blobs, and runs every shared
fixture case through this site's validator. To update, copy both files from a
newer agent-board commit and record its commit and blob IDs.

Beyond the schema, this site refuses actions on repositories outside the
allowlist (including parents), a project other than the configured one, an
issue as its own parent, a `.` or `..` label (`DELETE …/labels/.` would reach
the remove-all-labels endpoint), and a close reason that starts with a slash
command. `move_sub_issue` uses GitHub's single replace-parent operation.
For the organisation kinds it refuses an `org` other than the configured one
(case-insensitive), selected repositories outside that org, off the
allowlist or listed twice, a variable value or `expected_current` over
49,152 UTF-8 bytes (GitHub's limit; the schema counts characters), and a
ruleset source repository off the allowlist. A proposal comment holds at most 65,536
characters, so a value and `expected_current` both near the limit cannot be
proposed together.

## Stale checks

Proposals on issues and PRs don't include timestamps or prior values. Instead,
when the site renders a proposal, it reads every target and shows the fact
each action depends on: issue state for
close and reopen, label membership, a PR's state, draft flag and head (which
must be open, non-draft and at `head_sha`), the current parent, or the
project field's current value. Actions run in order, so an action on a target
an earlier action changed is checked against that earlier action's result.
Any failed or unavailable check disables the batch.

To avoid marking an unconfirmed label change done and running later actions,
both label mutations must return a list of named labels. The added label must
be present, or the removed label absent, compared case-insensitively. An empty
list confirms removal, not addition; malformed entries cannot prove absence.
An unusable or contradictory receipt stops the batch as failed or uncertain
and retains its replay reservation. Check GitHub before proposing a repair:
the write may have succeeded. This uses only the mutation response, with no
extra requests or settings; the existing proposal opt-in is unchanged.

An approval must return a positive safe-integer review ID, `APPROVED` state,
the requested commit and the same PR's API URL before the action is marked done.
This prevents an unconfirmed or wrong-head review response from claiming success
and letting later actions proceed. Missing or mismatched receipts stop the batch
as failed or uncertain; the existing reservation prevents replay. Check GitHub
before proposing another approval. No extra read or setting is added.

Project-field approvals also bind to the project, item and field IDs and the
field's option IDs and names, all from the existing bounded project read. Removing
and re-adding an item or recreating a field or option must not redirect an approval
just because the displayed value stayed the same. These identities are checked
before reservation and again before each write; option order alone is ignored.
The preview still shows values, not internal IDs. Changing any option requires
a fresh preview, even if it is not the option being set. No extra requests or
configuration are needed; the existing proposal opt-in remains unchanged.

To avoid reporting an unconfirmed project update as done, its mutation response
must name the exact item ID just written. A missing, malformed or different ID
stops the batch as failed or uncertain, retaining the execution reservation so
it cannot silently retry. Check the project on GitHub before proposing a repair;
the write may have succeeded even when its confirmation was unusable.

`set_org_variable` and `apply_org_ruleset` are different: they overwrite org
state that was the proposal's input, so they carry the prior state the
proposer saw, and the action is stale unless live state still matches it.
For a variable, the live value must equal `expected_current` (null: unset);
the fact shown also covers its visibility and selected repositories. For a
ruleset, the live ruleset of exactly that name, normalised as agent-board
defines, must have the SHA-256 `expected_current_sha256` (null: none of that
name). A member proposing a change cannot see a ruleset's bypass actors, so cannot
compute that digest for an update: the stale-action message gives the live digest
for the operator to hand back. A wrong expectation only makes the action stale.

Both kinds create or update: a variable is POSTed when unset and PATCHed
when set. To prevent an accepted-but-unfinished variable write from marking the
action done and starting later actions, creation requires HTTP 201 and update
requires HTTP 204, GitHub's documented completion acknowledgments. Other successful
statuses stop the batch as failed or uncertain and retain the replay reservation.
Check GitHub before proposing a repair: the write may have succeeded. This checks
only the existing response, adds no requests or settings, and leaves proposal
opt-in unchanged; it does not claim a read-back verification of the stored value.

Repository IDs are read from `GET /repos/OWNER/NAME` at plan time
and again just before the write (a renamed or transferred repository is
refused), never from the proposal. A ruleset is POSTed when none has its name
and PUT to the live ruleset's ID otherwise. The site refuses to proceed if more
than one ruleset has that name, or if there are more than 1,000 rulesets.
A proposal may hold only one action per organisation variable or ruleset,
since each is planned against live state
alone. The ruleset body is only the reviewed source file: it is fetched at the
pinned commit, which must be reachable from the source repository's default
branch (compare status `behind` or `identical`), since a member can push an
unreviewed branch to an allowlisted repository; a renamed or transferred
source repository is refused. The file must pass agent-board's source checks
(writable fields only, matching name, not `disabled`, at most 64 KiB, no
bypass actor the live ruleset lacks, so none on create), and is sent
normalised. GitHub keeps the fields an update omits, so an update must also
state every writable field the live ruleset has: removing every bypass actor
means writing `"bypass_actors": []`. Switching to `evaluate` stops
enforcement, and pinning any older default-branch commit rolls a ruleset
back; both are allowed and show in the diff for the operator to judge. The card shows the exact request
(method, path and body), the variable's current and new value in full, and a
line diff of the live and source rulesets, both normalised.

To prevent an unconfirmed ruleset change from being marked done and allowing
later actions, its mutation receipt must identify the configured organisation,
an organisation ruleset with a positive safe-integer ID (the live ID on update),
and every submitted writable field with its approved value. Extra metadata and
defaults for omitted fields are allowed; changes to submitted values are not.
An unusable or contradictory receipt stops the batch as failed or uncertain,
retaining the reservation against replay. Check GitHub before proposing a repair:
the write may have succeeded. This adds no requests or settings and does not
change the existing opt-in. Organisation-variable receipts are unchanged.

These reads and writes need an org owner's token with `admin:org`. A classic
token without it is refused at plan time; the rest of the site does not
need it. A fine-grained token sends no scopes, and one without org access may
see a variable as unset (a 404); that fails safe, since GitHub then refuses
the create.

Execution reads every target again and refuses to proceed unless each fact
still matches what was shown, then checks each one again just before its write. A target
that changed in a way these facts do not cover (its title, body or comments)
does not make an action stale.

## Proposals in chat

When an agent's message in the session chat drawer holds an
`agent-board-action` fence, the drawer shows a card after the message once
it ends. The card goes through the same validator as a proposal comment and
previews each action as the Inbox card does: its destination and the action
as literal JSON, including any text it would post. A fence that is not JSON,
names a kind the vendored schema lacks, fails validation or exceeds a
comment's 65,536 characters shows as unsupported, with the reason. A
proposal already carded in the transcript is noted rather than shown again.

Chat cards read nothing and execute nothing: they have no Approve button,
and nothing from the agent reaches `execute()`, which takes only a proposal
read from a trusted comment. Approving from chat is a later step
(review#275).

## Reads, execution and failure

The Inbox finds proposals in the scheduler pass's published needs-you list
(agent-board's `holds.proposals`), each an `operator_action` reference to
its issue and comment, one card per proposal. A drawn card reads at most 100
comments of that issue and takes the proposal from the named comment only if
it is on the configured tracker, written and last edited by the operator or
the planner, and has no execution record; an issue with more comments is
refused rather than executed with unread receipts. A card's targets are read
only once it is drawn (the first five cards, then on Show more), and the
Inbox is not redrawn while a proposal runs. Targets and exact mutation payloads are
shown as plain text, wrapping at phone width.

Execution re-reads the authenticated viewer, proposal and every target before
reserving the batch. The result comment starts with
`<!-- agent-board-action-executed: COMMENT-ID@UPDATED-AT -->`.
It is posted **before** mutations and updated with numbered results afterward.
All later actions are skipped at the first failure. A reservation counts as
executed even if interrupted, so reload cannot replay a partially successful
batch. Check targets manually and write a new proposal with fresh preconditions
to recover. A lost receipt response may have created the receipt; a lost write
response may have performed the action. The UI never automatically retries.

To prevent mutations without a confirmed replay guard, the reservation response
must contain a positive safe-integer comment ID before execution can continue
to the existing bounded reread. A malformed ID stops before any target write
or result-comment update; it must not compare equal to an absent reservation.
Check GitHub manually: the reservation may still have been posted, and if so
it blocks replay. No extra request, retry or setting is added.

Only a literal `merged: true` in a merge response confirms success. A missing,
false or malformed result stops the batch as failed or uncertain; a truthy
string or object is not confirmation. The reservation still prevents replay.
Check GitHub before proposing another merge.

Receipts count only from trusted writers with a trusted last editor. The first
receipt wins after a bounded re-read, as in job-plan dispatch. GitHub comments
are not an atomic lock: concurrent clients depend on GitHub showing earlier
receipts. Do not execute the same proposal from multiple tabs/devices. Deleting
a receipt can allow replay. Editing a proposal creates a new version.

GitHub offers no compare-and-swap for issue, label, project-field, sub-issue,
org variable or org ruleset writes, so a change racing the final read remains possible. A read that lags
an earlier write in the same batch stops the batch as stale. PR merge uses the
server-side SHA guard; approval is explicitly bound to the reviewed SHA.
Close and reopen require GitHub's state-update response to identify the same
issue (positive safe-integer ID and API URL), not a pull request, with the
requested state. An empty, malformed or mismatched acknowledgment stops the
batch as failed or uncertain, even if the write actually took effect. Check
GitHub before proposing another change; the reservation prevents replay.
This checks the mutation response, not a later read that could race another edit.

Adding or moving a sub-issue requires the mutation response to identify the
intended child (positive safe-integer ID and API URL), not a pull request, and
its requested `parent_issue_url`. Missing, malformed or mismatched evidence
stops the batch as failed or uncertain, even if the relationship changed.
The reservation prevents replay; check GitHub before proposing another parent
change. This validates the existing response without an extra read or retry.

Closing has two writes (reason comment then state). Before closing, execution
requires a positive safe-integer comment ID, the same issue URL and the exact
reason text in GitHub's response. An absent or mismatched confirmation stops
the batch as failed or uncertain, without closing or retrying the comment;
check GitHub manually before making a new proposal. If the second write fails,
the reason may already exist and the receipt says failed or uncertain. The inbox
does not implement rollback, tailnet changes, or live write tests against real
repositories.
