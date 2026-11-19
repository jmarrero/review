# Pass history publication

> This text is LLM generated.

Continuation of review#260 (which supersedes #248), **Part of #245**.
One Status panel prefers independent history when published and otherwise
preserves the deployed legacy view. No browser setting, extra request, write,
dispatch or pacing authority is added. Missing facts are unknown, not idle.

## Shipped producer and remaining dependency

Agent-board#729 merged at `ee541538eb904af724e024dc66ca0d77105ca650`.
Its `crates/board-forge/src/pass/view.rs` publishes `agent-board/pass-view/v1`
inside the holds comment, with the existing off-by-default `holds.passView`.
It retains five passes, eight starts/reason aggregates per pass, sixteen pools
and thirty-two running records. `sections` is empty, `ready` is null, reasons
are only hold-kind aggregates without item references or re-plan times, and
queue/review-wait PRs are absent. `complete` means runs were listed, not complete
readiness or queue coverage. Unchanged records may be suppressed for thirty
minutes. Its holds-success publication path cannot establish failed-pass history.

The reader therefore labels legacy coverage unknown, even with `complete: true`.
`test/fixtures/pass-view-producer-729.json` copies #729's documentation example,
not live or test-emitted output. `pass-view.json` and `passes.json` are synthetic
contract fixtures; section failures, queues and detailed waits there are not
evidence of what #729 emits. The configured bot-ops#1 comments read returned
HTTP 404 in this run. No live writes or producer tests ran here.

The independent producer does **not** exist yet. This run can hand back only
this repository's patch; it cannot open its linked agent-board PR. Before #245
can close, implement in **cgwalters-forge/agent-board**:

1. In `crates/board-forge/src/pass.rs`, add `HoldsAt.passes`, default false,
   update strict config and Forgejo refusal tests, and document it in
   `docs/pass.md`. The concrete threat is adding a write on upgrade and exposing
   pass error text without caller opt-in; this one option gates both.
2. Beside `pass/view.rs`, record typed stage outcomes and actual decision-site
   facts in `stages`, `Budget::request`, `pass/work.rs` and `pass/epics.rs`.
   Preserve accepted dispatches without run IDs and after bookkeeping failure;
   distinguish uncertain transport outcomes and previews. Never parse logs.
3. In `pass/usage.rs`, preserve each reading's clock, complete readiness per pool,
   held state, usage and reset. Include active and newly accepted runs, count
   unparseable omissions, and capture typed PR queue/review-wait references from
   the PR stage. Failed reads remain unknown. Remove inference, broker and
   tailnet addresses before serialization.
4. Finalize outside the stage 3/4 holds-success gate. Reserve existing request,
   time and write budget for at most one independent publication write at the
   end of an applying pass, including failure or budget exhaustion. Never retry
   an uncertain write. Carry only bounded, fully read bot-authored and bot-edited
   prior history; uncertain prior state must not be overwritten.
5. Extend `pass/view.rs`/history tests and `pass/tests.rs` with emitted-JSON
   replay for accepted no-ID/uncertain/preview starts, all wait kinds, section
   failure with suppressed holds, unread/stale pools, unknown/new runs, queues,
   eviction, exhausted requests, interruption and publication failure. Export
   sanitized emitted JSON to this app's parser/DOM tests. Demonstrate staging
   preview/apply and failed-pass publication before closing #245.

## Proposed independent contract

One bot comment beside holds on `holds.repository` / `holds.issue`, with first
line `<!-- agent-board-passes v1 -->` and a `json` fence. Schema is
`agent-board/passes/v1`; `test/fixtures/passes.json` is the reference shape.
The proposed off-by-default `holds.passes` gates publication. It is separate
from holds because a failed pass must publish even when holds cannot.

Top-level keys: `published_at`, `retention` (10), `omitted`, `passes` (newest
first), `pools` and `in_flight`. The latter two are null where not observed.
Keep at most ten records younger than seven days and JSON under 48 KiB.
Evict oldest records' start/reason details first with per-record omission counts,
then whole oldest records with top-level counts. Killed passes and failed writes
leave gaps; absence of a record is not proof a pass did not run.

Each pass has `run` (`{repository,id,attempt}` or null), `started_at`,
`finished_at`, `mode` (actions/preview/local), `result` (success/partial/failure),
`sections`, `starts`, `no_start`, `candidates` and `omitted`:

- A section has `name`, `outcome` (ok/failed/skipped/cut-short), `error` (only a
  failed section's sanitized first line, otherwise null).
- A start has `state` (confirmed/uncertain/preview), typed `item`, `kind`, `pool`
  or null and `run` (`{repository,id}` or null). Confirmed means accepted, not
  merely intended. A preview has no run. An applying pass has no preview starts.
- A no-start reason has `reason`, `item` or null, `until` or null, `cap` or null,
  and `hold` or null. Reasons are no-ready-work, replan-wait (requires `until`),
  capped, held or a newer token. Global reasons have null item.
- `candidates` is `{read,unread,ready}` or null. `omitted` counts `sections`,
  `starts` and `no_start` independently.

`pools` has `observed_at`, `complete`, `omitted`, `items`. Each item has `pool`,
its own `observed_at`, `used_percent`, `allowed_percent`, `resets_at`, `held`,
`ready`; unavailable readings are null. Percentages are finite 0–1000.
`in_flight` has `observed_at`, `complete`, `omitted`, `runs`, `prs`. Each run has
`item`, `kind`, `pool` or null, required `run`, and `since` or null. Each PR has
`repository`, `number`, `state` (merge-queue/review-wait), `since` or null.

### Reader bounds and uncertainty

The concrete threats are unbounded publisher data creating unbounded DOM and
publisher-controlled addresses becoming navigation or exposing private endpoints.
The reader rejects comments over 60,000 characters, more than ten passes, and
malformed headers. Per pass it accepts at most sixteen sections, twenty starts
and twenty reasons. It accepts sixteen pools and fifty runs/fifty PRs. Counts
are safe integers 0–1,000,000; IDs are positive safe integers. Repositories are
two non-path `[A-Za-z0-9_.-]` components of at most 100 characters each; item
references add `#N`. Tokens are `[a-z][a-z0-9-]{0,31}`. Error text is a single
line up to 200 characters, with URLs, IPs, private names and host:port values
redacted again in the app. This conservative redaction can hide dotted file
names, versions and some Rust paths; it is display-only. Links use typed
GitHub references, never prose. Unknown extension keys are ignored.

Malformed pass records are counted unreadable; malformed observation blocks
stay unknown independently. Unknown start states are uncertain. A full first
100-comment page is uncertain even with a match, because a newer replacement
may be on page two. No extra request is made. Cached history is retained even
without cached holds on cold startup, marked unavailable until confirmed. A
failed/malformed read retains last facts; a complete absent read drops them.
A 304 confirms the comment, never advances producer clocks.

Observations older than one hour or over five minutes ahead are untrusted.
Under-pace-with-nothing-ready requires at least twenty percentage points of
headroom, an explicitly unheld pool with a future reset and zero ready work,
fresh complete pool readings with no omissions, and the newest applying pass's
complete successful readiness evidence with no unread/omitted history. Ready
work in a different pool does not suppress the idle pool's flag. Retained
unavailable observations cannot claim current idleness. Legacy data cannot
establish that flag. Truncated start counts are lower bounds, not totals.

## Offline visual replay

Run `node test/e2e/render-passes.ts STATE /tmp/opencode/STATE.html`, where STATE
is populated, zero-start, failed-section, absent, stale or unavailable. Capture
each with Chromium at 1280×2400 and 390×2400. This uses the real Status slot,
parser and view, but synthetic data, not live producer evidence. Screenshots
are not included as binary files because this handback refuses them.

## Caller settings

After the independent producer and emitted-JSON/staging tests land: repository
`cgwalters-forge/tracker`, file `.github/pass.json`, key `holds.passes`, value
`true`, with a pinned tested producer and existing apply/write bounds. This
proposed key does not exist in #729. Its existing legacy opt-in is the same
repository/file, `holds.passView: true`; that is not independent history.
No settings are enabled here.
