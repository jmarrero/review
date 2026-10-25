// Review guides: where a reviewer agent thinks this PR needs a close
// read. bin/bot-review-guide in homegit posts one as a COMMENT review by
// jmarrero-bot, whose body ends with the guide as JSON in an HTML
// comment marker. The app trusts only the bot's reviews, only for the
// head the guide names, and shows everything in it as plain text: the
// guide is advice written by a model that read untrusted code, so it
// may carry anything that code said.
//
// TODO(#19): replace the guide with the bot pre-reviewing its own PR.
// GitHub reviews already attach comments to code lines, so hotspots
// should be ordinary review comments by the bot, walked from the review
// threads, instead of JSON in a marker.

import { isBot } from "./authors.ts";
import type { RawReview } from "./forge.ts";
import type { IssueRef } from "./board.ts";

export const GUIDE_SCHEMA = "review-guide/v1";
const MARKER_START = `<!-- ${GUIDE_SCHEMA} `;
const MARKER_END = " -->";

export const SEVERITIES = ["risky", "look-closely", "note"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const CATEGORIES = ["logic", "security", "error-handling", "test-gap", "api", "perf"] as const;
export type Category = (typeof CATEGORIES)[number];

export const SEVERITY_LABEL: Record<Severity, string> = { risky: "risky", "look-closely": "look closely", note: "note" };

export interface Hotspot {
  path: string;
  commit: string;
  start: number;
  end: number;
  severity: Severity;
  category: Category;
  reason: string;
}

export interface Skim {
  path: string;
  start?: number;
  end?: number;
  reason: string;
}

export interface Guide {
  repo: string;
  pr: number;
  head: string;
  summary: string;
  hotspots: Hotspot[];
  skim: Skim[];
}

const LIMITS = { summary: 2000, reason: 500, skimReason: 300, path: 1024, hotspots: 50, skim: 200, line: 10_000_000 } as const;
const SHA_RE = /^[0-9a-f]{40}$/;
// C0 controls but newline, DEL, C1 controls, and bidirectional and
// invisible formatting characters that could make text read other than
// it is (Trojan Source).
const BAD_TEXT_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/;

export class GuideError extends Error {
  override name = "GuideError";
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function onlyKeys(o: Obj, allowed: readonly string[], where: string): void {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) throw new GuideError(`${where}: unknown key${extra.length > 1 ? "s" : ""} ${extra.join(", ")}`);
}

function text(o: Obj, key: string, max: number, where: string, multiline = false): string {
  const v = o[key];
  if (typeof v !== "string" || !v.trim()) throw new GuideError(`${where}.${key}: expected non-empty text`);
  if (v.length > max) throw new GuideError(`${where}.${key}: longer than ${max} characters`);
  if (BAD_TEXT_RE.test(v) || (!multiline && v.includes("\n"))) throw new GuideError(`${where}.${key}: contains control or formatting characters`);
  return v;
}

function line(o: Obj, key: string, where: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > LIMITS.line) throw new GuideError(`${where}.${key}: expected a line number`);
  return v;
}

function oneOf<T extends string>(o: Obj, key: string, allowed: readonly T[], where: string): T {
  const v = o[key];
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw new GuideError(`${where}.${key}: expected one of ${allowed.join(", ")}`);
  return v as T;
}

function path(o: Obj, where: string): string {
  const p = text(o, "path", LIMITS.path, where);
  if (p.startsWith("/") || p.split("/").some((s) => s === "" || s === "." || s === "..")) throw new GuideError(`${where}.path: not a repository path`);
  return p;
}

function list(o: Obj, key: string, max: number): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) throw new GuideError(`${key}: expected a list`);
  if (v.length > max) throw new GuideError(`${key}: more than ${max} entries`);
  return v;
}

/** Validate a parsed guide strictly: every field, no unknown keys. */
export function validateGuide(raw: unknown): Guide {
  if (!isObj(raw)) throw new GuideError("expected a JSON object");
  onlyKeys(raw, ["schema", "repo", "pr", "head", "summary", "hotspots", "skim"], "guide");
  if (raw.schema !== GUIDE_SCHEMA) throw new GuideError(`schema: expected ${GUIDE_SCHEMA}`);
  const repo = raw.repo;
  if (typeof repo !== "string" || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw new GuideError("repo: expected owner/repo");
  const pr = raw.pr;
  if (typeof pr !== "number" || !Number.isInteger(pr) || pr < 1) throw new GuideError("pr: expected a PR number");
  const head = raw.head;
  if (typeof head !== "string" || !SHA_RE.test(head)) throw new GuideError("head: expected a full commit id");
  const summary = text(raw, "summary", LIMITS.summary, "guide", true);
  const hotspots = list(raw, "hotspots", LIMITS.hotspots).map((h, i): Hotspot => {
    const where = `hotspots[${i}]`;
    if (!isObj(h)) throw new GuideError(`${where}: expected an object`);
    onlyKeys(h, ["path", "commit", "start", "end", "severity", "category", "reason"], where);
    const commit = h.commit;
    if (typeof commit !== "string" || !SHA_RE.test(commit)) throw new GuideError(`${where}.commit: expected a full commit id`);
    const start = line(h, "start", where);
    const end = line(h, "end", where);
    if (end < start) throw new GuideError(`${where}: end before start`);
    return {
      path: path(h, where),
      commit,
      start,
      end,
      severity: oneOf(h, "severity", SEVERITIES, where),
      category: oneOf(h, "category", CATEGORIES, where),
      reason: text(h, "reason", LIMITS.reason, where),
    };
  });
  const skim = list(raw, "skim", LIMITS.skim).map((s, i): Skim => {
    const where = `skim[${i}]`;
    if (!isObj(s)) throw new GuideError(`${where}: expected an object`);
    onlyKeys(s, ["path", "start", "end", "reason"], where);
    const out: Skim = { path: path(s, where), reason: text(s, "reason", LIMITS.skimReason, where) };
    if (s.start !== undefined || s.end !== undefined) {
      out.start = line(s, "start", where);
      out.end = line(s, "end", where);
      if (out.end < out.start) throw new GuideError(`${where}: end before start`);
    }
    return out;
  });
  return { repo, pr, head, summary, hotspots, skim };
}

/** The guide in a review body: the last marker line's JSON, validated. */
export function parseGuideBody(body: string): Guide | undefined {
  const start = body.lastIndexOf(MARKER_START);
  if (start < 0) return undefined;
  const from = start + MARKER_START.length;
  const end = body.indexOf(MARKER_END, from);
  if (end < 0) throw new GuideError("the guide marker isn't closed");
  let raw: unknown;
  try {
    raw = JSON.parse(body.slice(from, end));
  } catch (e) {
    throw new GuideError(`the guide isn't valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return validateGuide(raw);
}

export type GuideState =
  | { state: "none" }
  | { state: "invalid"; error: string; url?: string }
  | { state: "current" | "stale"; guide: Guide; url?: string; at?: string };

/**
 * The guide to show for a PR: from the latest COMMENTED review by the
 * bot, for this PR, that carries one and whose commit_id is the head the
 * guide names. Anyone else's reviews are ignored whatever they contain.
 * It is stale when that head isn't the PR's head any more.
 */
export function findGuide(reviews: readonly RawReview[], ref: IssueRef, head: string): GuideState {
  const candidates = reviews
    .filter((r) => isBot(r.user?.login) && r.state === "COMMENTED" && (r.body ?? "").includes(MARKER_START))
    .sort((a, b) => ((a.submitted_at ?? "") < (b.submitted_at ?? "") ? -1 : (a.submitted_at ?? "") > (b.submitted_at ?? "") ? 1 : 0));
  const last = candidates.at(-1);
  if (!last) return { state: "none" };
  const url = last.html_url;
  const withUrl = <T extends object>(s: T): T & { url?: string } => (url ? { ...s, url } : s);
  try {
    const guide = parseGuideBody(last.body ?? "");
    if (!guide) return { state: "none" };
    if (guide.repo.toLowerCase() !== `${ref.owner}/${ref.repo}`.toLowerCase() || guide.pr !== ref.number) {
      throw new GuideError(`it is for ${guide.repo}#${guide.pr}, not this PR`);
    }
    if (last.commit_id !== guide.head) throw new GuideError("the review's commit isn't the head the guide names");
    const out: GuideState = withUrl({ state: guide.head === head ? ("current" as const) : ("stale" as const), guide });
    if (last.submitted_at) out.at = last.submitted_at;
    return out;
  } catch (e) {
    return withUrl({ state: "invalid" as const, error: e instanceof Error ? e.message : String(e) });
  }
}

const SEVERITY_RANK: Record<Severity, number> = { risky: 0, "look-closely": 1, note: 2 };

/** The most severe of some hotspots, for tinting lines several cover. */
export function worst(hs: readonly Hotspot[]): Severity | undefined {
  let out: Severity | undefined;
  for (const h of hs) if (out === undefined || SEVERITY_RANK[h.severity] < SEVERITY_RANK[out]) out = h.severity;
  return out;
}

/** Whether a skim entry covers the whole file. */
export function skimsWholeFile(s: Skim): boolean {
  return s.start === undefined;
}
