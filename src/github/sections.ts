// The sections of the one page, in order, and what is remembered about
// them in this browser: whether each is open. Pure apart from the
// storage helpers, which tolerate missing or blocked storage.

import { load, save } from "./store.ts";

export const SECTIONS = ["needs"] as const;
export type SectionId = (typeof SECTIONS)[number];

export const SECTION_TITLE: Record<SectionId, string> = {
  needs: "Needs you",
};

/** What a section is for, shown quietly beside its title. */
export const SECTION_HINT: Record<SectionId, string> = {
  needs: "what waits on you, one action each",
};

/** Rows a section shows before its "View all". */
export const PREVIEW_ROWS = 5;

export const isSection = (v: string): v is SectionId => (SECTIONS as readonly string[]).includes(v);

/** Which sections the viewer opened (true) or closed (false); absent ones follow the default. */
export type SectionPrefs = Partial<Record<SectionId, boolean>>;

const STORE_KEY = "sections";

function isPrefs(v: unknown): v is SectionPrefs {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return Object.entries(v).every(([k, x]) => isSection(k) && typeof x === "boolean");
}

export function loadSectionPrefs(): SectionPrefs {
  return load(STORE_KEY, {}, isPrefs);
}

/** Remember one section opened or closed, over what other tabs saved meanwhile. */
export function saveSectionPref(id: SectionId, open: boolean): void {
  save(STORE_KEY, { ...loadSectionPrefs(), [id]: open });
}

/**
 * Whether a section is open: as the viewer left it, else only the ones
 * with something that needs him (`urgent`) are.
 */
export function sectionOpen(id: SectionId, prefs: SectionPrefs, urgent: boolean): boolean {
  return prefs[id] ?? urgent;
}
