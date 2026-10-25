// Public names only: this file is part of the public app. Everything
// about the items themselves is fetched at runtime with your token.

export const API_ROOT = "https://api.github.com";

/**
 * The Workstream board, a Projects v2 board owned by an organization:
 * GitHub Apps can write org projects, not a user's (cgwalters-forge/tracker#144).
 */
export const BOARD_OWNER = "jmarrero-forge";
export const BOARD_NUMBER = 1;
export const BOARD_URL = `https://github.com/orgs/${BOARD_OWNER}/projects/${BOARD_NUMBER}`;

/** The only login whose answers the bot acts on. */
export const OPERATOR = "jmarrero";
/** His sign-off, as `bot-pr promote` adds it where upstream wants DCO. */
export const OPERATOR_SIGNOFF = { name: "Joseph Marrero Corchado", email: "jmarrero@redhat.com" } as const;

/** The Status of an item blocked on his decision or action. */
export const NEEDS_HUMAN = "Needs human";
/** The Status of an item ready for his review (a forge PR or a gist). */
export const DRAFT = "Draft";
/** The Statuses that put an item in the queue (the board's "Needs jmarrero" view). */
export const QUEUE_STATUSES: readonly string[] = [NEEDS_HUMAN, DRAFT];
/** The Status of an item whose PR is open upstream. */
export const IN_REVIEW = "In Review";
/**
 * Statuses read only to rank the bot's PRs other than the forge's
 * drafts: an item whose Branch holds the PR gives it its priority and
 * org.
 */
export const LINKED_STATUSES: readonly string[] = [IN_REVIEW];

/** The organization holding the forks where the bot proposes draft PRs. */
export const FORGE_ORG = "jmarrero-forge";
/** The bot's login: the forge PRs listed are the ones it opened. */
export const BOT_LOGIN = "jmarrero-bot";
/**
 * The role apps the bot also writes as (cgwalters-forge/tracker#766), by
 * bot login (`SLUG[bot]`) with the role shown next to what each wrote.
 * Their comments and reviews count as the bot's (see authors.ts); BOT_LOGIN
 * alone still means the user account: its events, the PRs it opens. Empty
 * until the apps exist. An entry is trusted as much as BOT_LOGIN, so list
 * only apps the forge installed: a login ending in [bot] names one app,
 * but anyone can create an app and comment as it.
 */
export const ROLE_APPS: readonly { login: string; role: string }[] = [];

/** Board fields the app reads, by name; their ids are looked up at runtime. */
export const FIELD = {
  status: "Status",
  priority: "Priority",
  why: "Why",
  org: "Org",
  branch: "Branch",
  gist: "Gist",
} as const;

/**
 * Board fields the triage view reads, by name. They are optional: a
 * board without them still loads, and the view says which are missing.
 */
export const TRIAGE_FIELD = {
  theme: "Theme",
  verdict: "Verdict",
  verdictTarget: "Verdict target",
} as const;

/**
 * Board fields the changes feed (boardfeed.ts) reads, by name; optional
 * too. Lead names the topic session that owns an item; News is the one
 * dated line the coordinator writes when something notable happens to
 * it (`bot-board set --news` in homegit). Run is the devspace agent run
 * working on it (`bot-runs dispatch` sets it), which the active agents
 * strip reads too.
 */
export const FEED_FIELD = {
  lead: "Lead",
  news: "News",
  run: "Run",
} as const;

/** The Status of a finished item; the triage view shows everything else. */
export const DONE = "Done";

/**
 * The board's Theme options, in the order the triage view lists them;
 * others follow, by name. jmarrero's board has no Theme field yet, so
 * none are ranked.
 */
export const TRIAGE_THEMES: readonly string[] = [];

/** The board's Verdict options: keep it, merge it into its target, park it, or close it (for its target, if any). */
export const VERDICTS = ["keep", "merge", "park", "close"] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * The public repository where every board item that isn't an upstream
 * issue or PR is an issue, questions for him included.
 */
export const TRACKER_REPO = "jmarrero-forge/tracker";
/** The label the bot puts on a question issue in TRACKER_REPO. */
export const QUESTION_LABEL = "question";
/** ... on an issue asking him to review a PR. */
export const REVIEW_LABEL = "review";
/** ... on an issue asking him for any other action. */
export const CHORE_LABEL = "chore";
/**
 * The label the bot adds to a question that is a triage decision, titled
 * "D<n>: ..." and listing the items it unblocks (see triage.ts).
 */
export const DECISION_LABEL = "decision";
/**
 * The label on an issue he files from the capture bar: the bot hasn't
 * triaged it yet. bot-notify in homegit routes his open issues carrying
 * it, and the bot removes it once it has turned the issue into work.
 */
export const CAPTURE_LABEL = "needs-triage";

/**
 * Poll every this many ms while the tab is visible (never while hidden).
 * Not faster: each poll makes a dozen or more requests, and GitHub's
 * secondary rate limits punish rapid repeats.
 */
export const POLL_INTERVAL_MS = 60_000;
/**
 * Give up on a request GitHub hasn't answered in this long. A connection
 * that died without an error (e.g. across a laptop's sleep) otherwise
 * leaves the request, and whatever waits on it, hanging forever.
 */
export const REQUEST_TIMEOUT_MS = 60_000;
/** Stop waiting for a poll after this long and start the next one, whatever it is stuck on. */
export const POLL_STALL_MS = 2 * 60_000;
/** Say the poll is waiting on GitHub once it has run this long. */
export const POLL_SLOW_MS = 10_000;
/** Poll the forge's PR search this often: search has its own, smaller budget. */
export const FORGE_POLL_INTERVAL_MS = 60_000;
/** ... and at most this often when asked to refresh (r, or after a review). */
export const FORGE_MIN_INTERVAL_MS = 10_000;
/**
 * His own review shows in the queue for at most this long before GitHub's
 * reads confirm it; they can lag a write (search more than most).
 */
export const OPTIMISTIC_TTL_MS = 5 * 60_000;
/** How long the "Done: ... → next" notice stays after moving on. */
export const DONE_NOTICE_MS = 15_000;
/** Parallel requests when refreshing PR verdicts (the client caps them at GITHUB_CONCURRENCY anyway). */
export const FETCH_CONCURRENCY = 6;
/**
 * GitHub requests in flight at once, from the whole page; searches go one
 * at a time besides. GitHub's secondary rate limits punish concurrency,
 * and once tripped refuse every request for a minute or more.
 */
export const GITHUB_CONCURRENCY = 4;
/** After a rate-limit refusal that doesn't say how long to wait, wait this long (GitHub's documented minimum). */
export const RATE_LIMIT_WAIT_MS = 60_000;
/** A file's diff starts collapsed above this many lines (files build lazily, so this is for reading, not speed). */
export const DIFF_COLLAPSE_LINES = 1000;
/** Poll this many times slower when the rate budget runs low. */
export const POLL_BACKOFF_FACTOR = 4;
/** Below this fraction of the hourly budget, back off. */
export const RATE_LOW_FRACTION = 0.1;

/** The persistent response cache's size cap, in characters of JSON; least recently used entries go first. */
export const CACHE_MAX_BYTES = 50 * 1024 * 1024;
/** Cached responses the server hasn't confirmed for this long are dropped. */
export const CACHE_MAX_AGE_MS = 7 * 24 * 3600_000;

/** Items per page when listing the board (the API maximum). */
export const PAGE_SIZE = 100;
/** Comments shown in the item view. */
export const RECENT_COMMENTS = 5;

/**
 * The repositories whose merged PRs the news pane shows: the bot, its
 * runner, this app, the tracker's workflows and the bot machine's image.
 */
export const NEWS_REPOS: readonly string[] = [
  "jmarrero-forge/homegit",
  "bootc-dev/jmarrero-devspace-sandbox",
  "jmarrero/review",
  "jmarrero-forge/tracker",
  "jmarrero/atomic-setup",
];
/** Closed PRs read per repository (one page). */
export const NEWS_PER_REPO = 30;
/** News items shown. */
export const NEWS_LIMIT = 40;

/** The ops view: where devspaces and agent runs come from (bin/bot-devspace and bin/bot-runs in homegit). */
export const DEVSPACE_REPO = "bootc-dev/jmarrero-devspace-sandbox";
export const DEVSPACE_WORKFLOW = "devspace.yml";
export const AGENT_WORKFLOW = "agent.yml";
/** A devspace's tailnet host is this plus its run id. */
export const DEVSPACE_HOST_PREFIX = "jmarrero-devspace-";
/** The Status of an item the bot is working on. */
export const IN_PROGRESS = "In Progress";
/** Refresh the ops view this often while it is open and the tab visible. */
export const OPS_POLL_INTERVAL_MS = 60_000;
/** The ops view's history window, in hours. */
export const OPS_WINDOW_HOURS = 24;
/** Workflow runs listed per read (one page, the API maximum). */
export const OPS_RUNS_PER_PAGE = 100;
/** Agent runs shown when finished. */
export const OPS_AGENT_RECENT = 6;
/**
 * The coordinator's heartbeat: the one comment by BOT_LOGIN on this
 * TRACKER_REPO issue ("Bot heartbeat", pinned and locked), which
 * bin/bot-heartbeat in homegit edits in place.
 */
export const HEARTBEAT_ISSUE = 1;
/**
 * The plan's usage is private: bin/bot-heartbeat keeps it in the one
 * comment by BOT_LOGIN on this issue ("Bot usage", locked) of a private
 * repository, read with the viewer's own token. Nothing of it is in the
 * build.
 */
export const USAGE_REPO = "jmarrero-forge/bot-ops";
export const USAGE_ISSUE = 1;
/** A heartbeat older than this is stale... */
export const HEARTBEAT_STALE_MS = 15 * 60_000;
/** ... unless the coordinator said it sleeps longer, and this grace past its wake time hasn't run out. */
export const HEARTBEAT_WAKE_GRACE_MS = 5 * 60_000;
/** The bot's public events read (one page). */
export const OPS_EVENTS = 50;
/** Rows of bot activity shown. */
export const OPS_EVENTS_SHOWN = 20;
/**
 * How many agents the bot aims to keep working at once, split between
 * its harness and upstream (cgwalters-forge/tracker#267); the active
 * agents strip atop the queue shows the count against it.
 */
export const AGENT_TARGET = 4;

/** localStorage key for the chosen theme (auto, light, dark). */
export const THEME_KEY = "review.theme";

/** localStorage key for the capture composer's unsent draft: it survives a reload and a closed tab, and is dropped on sign-out. */
export const CAPTURE_DRAFT_KEY = "review.capture.draft";

/** Storage key for the pasted token (sessionStorage, or localStorage if remembered). */
export const TOKEN_KEY = "review.token";

/**
 * What a classic token needs, by scope; each entry is met by any one of
 * its scopes. Shown on the sign-in page, and checked against the
 * X-OAuth-Scopes header once signed in.
 */
export const CLASSIC_SCOPES = [
  { any: ["public_repo", "repo"], why: "read PRs and post comments and reviews as you (repo only if you want private repositories too)" },
  { any: ["read:project", "project"], why: "read the Workstream board" },
] as const satisfies readonly { any: readonly string[]; why: string }[];
