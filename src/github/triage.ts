// The open decisions' model, shared by the inbox and CLI state.
//
// A decision is a question (see answer.ts) that the bot also labels
// `decision` and titles "D<n>: ...", so they read in order. Besides the
// question, its body lists the items the decision unblocks:
//
//     Unblocks:
//     - https://github.com/jmarrero-forge/bootc/pull/15
//     - https://github.com/jmarrero-forge/tracker/issues/160
//
// The URLs may also follow on the `Unblocks:` line itself, separated by
// commas or spaces, bare or in code spans.

import { parseQuestion, type Question, unfencedLines } from "../answer.ts";
import { type Item, parseIssueUrl } from "./board.ts";
import { FORGE_ORG, TRACKER_REPO } from "./config.ts";

/** A decision issue, parsed. */
export interface Decision {
  item: Item;
  /** n in its "D<n>: ..." title, if it has one. */
  number?: number;
  /** The title without its "D<n>:" prefix. */
  title: string;
  question: Question;
  /** The URLs its `Unblocks:` list names, in order, without duplicates. */
  unblocks: string[];
}

const DECISION_TITLE_RE = /^D([0-9]{1,6})[ \t]*:[ \t]*(.*)$/;
const UNBLOCKS_RE = /^Unblocks:[ \t]*(.*)$/i;
const URL_RE = /^https:\/\/[^\s`<>]+$/;
// A list marker: "-", "*" or "1." before an item.
const LIST_MARKER_RE = /^(?:[-*+]|[0-9]+[.)])[ \t]+/;

/** The URLs in a line that holds nothing else (besides list markers, code spans and separators), or undefined. */
function urlLine(line: string): string[] | undefined {
  const tokens = line
    .replace(LIST_MARKER_RE, "")
    .split(/[\s,;`]+/)
    .filter(Boolean);
  if (tokens.length === 0 || !tokens.every((t) => URL_RE.test(t))) return undefined;
  return tokens;
}

/**
 * The URLs a decision's `Unblocks:` line lists: on that line, then one
 * or more per following line, up to the first line that isn't only
 * URLs. Blank lines in between are skipped; fenced code doesn't count.
 */
export function parseUnblocks(body: string): string[] {
  const lines = unfencedLines(body);
  const at = lines.findIndex((l) => UNBLOCKS_RE.test(l));
  if (at < 0) return [];
  const first = (UNBLOCKS_RE.exec(lines[at] as string)?.[1] ?? "").split(/[\s,;`]+/).filter((t) => URL_RE.test(t));
  const urls = [...first];
  for (const line of lines.slice(at + 1)) {
    if (line === "") continue;
    const found = urlLine(line);
    if (!found) break;
    urls.push(...found);
  }
  return [...new Set(urls)];
}

export function parseDecision(item: Item): Decision {
  const m = DECISION_TITLE_RE.exec(item.title.trim());
  const d: Decision = {
    item,
    title: m ? (m[2] as string).trim() || item.title : item.title,
    question: parseQuestion(item.body),
    unblocks: parseUnblocks(item.body),
  };
  if (m) d.number = Number(m[1]);
  return d;
}

/** Decisions in D-number order; any without one after them, by issue number. */
export function sortDecisions(ds: readonly Decision[]): Decision[] {
  const key = (d: Decision) => d.number ?? Number.POSITIVE_INFINITY;
  return [...ds].sort((a, b) => key(a) - key(b) || (a.item.ref?.number ?? 0) - (b.item.ref?.number ?? 0));
}

/** "D3", or the issue's "#n" when its title has no D-number. */
export function decisionLabel(d: Decision): string {
  if (d.number !== undefined) return `D${d.number}`;
  return d.item.ref ? `#${d.item.ref.number}` : "D?";
}

/**
 * A short name for an issue or PR URL: "tracker#12" in the tracker,
 * "forge bootc#15" in a forge fork, "bootc#2516" elsewhere, and the URL
 * itself for anything else.
 */
export function shortRef(url: string): string {
  const ref = parseIssueUrl(url);
  if (!ref) return url;
  const full = `${ref.owner}/${ref.repo}`.toLowerCase();
  if (full === TRACKER_REPO.toLowerCase()) return `tracker#${ref.number}`;
  if (ref.owner.toLowerCase() === FORGE_ORG.toLowerCase()) return `forge ${ref.repo}#${ref.number}`;
  return `${ref.repo}#${ref.number}`;
}
