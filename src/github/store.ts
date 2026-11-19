// Per-viewer conveniences kept in localStorage: the queue's filter, the
// diff layout, whether the review guide is shown, whether the app moves
// on to the next entry after an action, which files he marked
// viewed, which guide hotspots he has seen, and his unsent line comments. Storage can be
// missing, full or blocked (private windows, tests), so every access is
// guarded and the app works the same without it, only forgetting more.

import { ALL, filterToken, isFilterToken, parseFilterToken, type QueueFilter } from "./filter.ts";

const PREFIX = "review.";
/** Files marked viewed kept at most; the oldest go first. */
export const MAX_VIEWED = 5000;

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

export function load<T>(key: string, fallback: T, valid: (v: unknown) => v is T): T {
  try {
    const raw = storage()?.getItem(PREFIX + key);
    if (raw === null || raw === undefined) return fallback;
    const v: unknown = JSON.parse(raw);
    return valid(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    const s = storage();
    if (!s) return;
    if (value === undefined) s.removeItem(PREFIX + key);
    else s.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Full or blocked: this viewer just won't have it remembered.
  }
}

const isString = (v: unknown): v is string => typeof v === "string";
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

/** The queue filter last chosen, as its hash token. */
export function loadFilter(): QueueFilter {
  return parseFilterToken(load("queue.filter", "", isFilterToken)) ?? ALL;
}

export function saveFilter(f: QueueFilter): void {
  save("queue.filter", filterToken(f));
}

export type DiffLayout = "unified" | "split";

export function loadLayout(): DiffLayout {
  return load("diff.layout", "unified", (v): v is DiffLayout => v === "unified" || v === "split");
}

export function saveLayout(l: DiffLayout): void {
  save("diff.layout", l);
}

export function loadGuideOn(): boolean {
  return load("guide.on", true, (v): v is boolean => typeof v === "boolean");
}

export function saveGuideOn(on: boolean): void {
  save("guide.on", on);
}

/** Whether to open the next entry after acting on one; on unless he turned it off. */
export function loadAdvance(): boolean {
  return load("advance.on", true, (v): v is boolean => typeof v === "boolean");
}

export function saveAdvance(on: boolean): void {
  save("advance.on", on);
}

/**
 * The key a viewed mark is stored under: the file's blob, so the mark
 * goes away by itself when the file changes.
 */
export function viewedKey(repo: string, path: string, blob: string): string {
  return `${repo}:${blob}:${path}`;
}

/** Marks files viewed, oldest first, shared by every PR. */
export class ViewedMarks {
  #keys: string[];
  constructor() {
    this.#keys = load("diff.viewed", [], isStringList);
  }
  has(key: string): boolean {
    return this.#keys.includes(key);
  }
  set(key: string, on: boolean): void {
    // Re-read first: another tab may have marked files since.
    const keys = load("diff.viewed", [], isStringList).filter((k) => k !== key);
    if (on) keys.push(key);
    this.#keys = keys.slice(-MAX_VIEWED);
    save("diff.viewed", this.#keys);
  }
}

/** Hotspots seen, by index, for one guide (a PR and the head it names). */
export function loadSeen(guideKey: string): Set<number> {
  const v = load(`guide.seen.${guideKey}`, [], (x): x is number[] => Array.isArray(x) && x.every((n) => Number.isInteger(n)));
  return new Set(v);
}

export function saveSeen(guideKey: string, seen: ReadonlySet<number>): void {
  save(`guide.seen.${guideKey}`, [...seen]);
}

export { isString, isStringList };
