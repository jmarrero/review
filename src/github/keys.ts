// Keyboard commands, as a pure mapping from a key press to a command so
// tests can check it; main.ts carries them out.

import { parseFilterToken, type QueueFilter } from "./filter.ts";
import type { SectionId } from "./sections.ts";
import { isView, type ViewId } from "./shell.ts";

/** The page of sections in one of its views, an item opened from it, or a forge PR. */
export type Route = "home" | "item" | "pr";

export type Command =
  | "next"
  | "prev"
  | "open"
  | "back"
  | "refresh"
  | "approve"
  | "fold"
  | "compose"
  | "help"
  | "status"
  // Switch to the view of a section of the page, open the section and scroll to it.
  | `section:${SectionId}`
  | "capture"
  // The PR pane's own, which it carries out itself.
  | "next-file"
  | "prev-file"
  | "next-hunk"
  | "prev-hunk"
  | "viewed"
  | "comment"
  | "guide"
  | "layout"
  | "prev-commit"
  | "next-commit";

export interface KeyPress {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /** The focused element's tag, lower case, and whether it is editable. */
  editing: boolean;
}

// b ("board") focuses the capture bar from anywhere; c is taken by the
// item and PR views.
const COMMON: Record<string, Command> = { r: "refresh", "?": "help", b: "capture" };

const BY_ROUTE: Record<Route, Record<string, Command>> = {
  home: {
    j: "next",
    k: "prev",
    ArrowDown: "next",
    ArrowUp: "prev",
    o: "open",
    Enter: "open",
    q: "section:needs",
    s: "status",
  },
  item: { u: "back", Escape: "back", c: "compose" },
  pr: {
    n: "next-file",
    p: "prev-file",
    j: "next-hunk",
    k: "prev-hunk",
    v: "viewed",
    x: "fold",
    a: "approve",
    c: "comment",
    g: "guide",
    s: "layout",
    "[": "prev-commit",
    "]": "next-commit",
    u: "back",
    Escape: "back",
  },
};

/**
 * The command for a key press, if any. Keys typed into a text field
 * belong to it, except Escape, which leaves the field; modified keys
 * belong to the browser.
 */
export function keyCommand(press: KeyPress, route: Route): Command | "blur" | undefined {
  if (press.ctrlKey || press.metaKey || press.altKey) return undefined;
  if (press.editing) return press.key === "Escape" ? "blur" : undefined;
  return BY_ROUTE[route][press.key] ?? COMMON[press.key];
}

export const HELP: Record<Route, string> = {
  home:
    "j/k or ↓/↑ move · o or Enter open · q needs you · s status · b file to the board · r refresh · ? keys",
  item: "u or Esc back · c write an answer · b file to the board · r refresh",
  pr: "n/p next/previous file · j/k next/previous hunk · v mark viewed · x fold · c comment on the focused line (or write the review) · s unified/split · [/] previous/next commit · g guided review (then n/p between hotspots, Esc leaves) · a approve · b file to the board · u or Esc back · r reload",
};

export type RouteInfo =
  | { route: "home"; view?: ViewId; filter?: QueueFilter }
  | { route: "item"; id: string; ref?: { owner: string; repo: string; number: number } }
  | { route: "pr"; ref: { owner: string; repo: string; number: number } };

/**
 * The view a location hash asks for: one of the page's views (shell.ts),
 * e.g. `#agents`; anything unknown is the page in the view last shown
 * (no `view`). A bare filter token (see filterToken), e.g. `#composefs`,
 * is the board view with its by-priority list filtered so.
 */
export function parseRoute(hash: string): RouteInfo {
  // A board item (PVTI_), or a tracker issue (I_) for a decision read
  // off the issues API that is not on the board; main.ts's routedItem finds both.
  const item = /^#item\/((?:PVTI|I)_[A-Za-z0-9_-]+)$/.exec(hash);
  if (item?.[1]) return { route: "item", id: item[1] };
  const pr = /^#(pr|issue)\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/([1-9][0-9]{0,9})$/.exec(hash);
  // "." and ".." are no repository's name, and would climb the API path.
  if (pr?.[2] && pr[3] && pr[4] && !/^\.+$/.test(pr[3])) {
    const ref = { owner: pr[2], repo: pr[3], number: Number(pr[4]) };
    return pr[1] === "pr" ? { route: "pr", ref } : { route: "item", id: `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase(), ref };
  }
  const token = hash.slice(1);
  if (/^epic-[1-9]\d{0,9}$/.test(token)) return { route: "home", view: "inbox" };
  if (isView(token)) return { route: "home", view: token };
  if (["maintain", "chat"].includes(token)) return { route: "home", view: "inbox" };
  if (["agents", "board", "activity", "usage", "ops", "dashboard"].includes(token)) return { route: "home", view: "status" };
  const filter = parseFilterToken(token);
  return filter ? { route: "home", view: "inbox" } : { route: "home" };
}
