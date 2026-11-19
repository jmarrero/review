// The views the page is split into, one route each (#inbox, #agents, ...),
// and the navigation between them: a tab bar in the sticky header
// (style.css). The page is built once (homeview.ts)
// and a view only shows its parts and hides the rest, so a half-written
// answer in one view is still there on coming back to it.

import { h } from "../dom.ts";
import type { SectionId } from "./sections.ts";

export const VIEWS = ["inbox", "status"] as const;
export type ViewId = (typeof VIEWS)[number];

/** The views linked and routed to. */
export const SHOWN_VIEWS: readonly ViewId[] = VIEWS;

export const VIEW_TITLE: Record<ViewId, string> = {
  inbox: "Needs you",
  status: "Status",
};

/** The view shown for a bare `#` before any other was. */
export const DEFAULT_VIEW: ViewId = "inbox";

/** The view each section of the page is in. */
export const SECTION_VIEW: Record<SectionId, ViewId> = {
  needs: "inbox",
};

/** The attribute naming the view a part of the page is in; a part without it shows in every view. */
export const VIEW_ATTR = "data-view";

export const isView = (v: string | undefined): v is ViewId => (SHOWN_VIEWS as readonly (string | undefined)[]).includes(v);

export const viewHash = (view: ViewId): string => `#${view}`;

/** Show `view`'s parts of the page and hide the others'; the page's own VIEW_ATTR says which is shown. */
export function showView(page: HTMLElement, view: ViewId): void {
  page.setAttribute(VIEW_ATTR, view);
  for (const part of page.querySelectorAll<HTMLElement>(`:scope > [${VIEW_ATTR}]`)) part.hidden = part.getAttribute(VIEW_ATTR) !== view;
}

/** The view on screen in `doc`: none while the tab is hidden, or while something other than the page (an item, a PR) shows. */
export function visibleView(doc: Document, pageClass: string): ViewId | undefined {
  if (doc.hidden) return undefined;
  const view = doc.querySelector(`.${pageClass}[${VIEW_ATTR}]`)?.getAttribute(VIEW_ATTR) ?? undefined;
  return isView(view) ? view : undefined;
}

/** Fill the navigation with a link per view, marking `current`. */
export function fillNav(nav: HTMLElement, current: ViewId): void {
  if (!nav.firstChild) nav.append(...SHOWN_VIEWS.map((v) => h("a", { href: viewHash(v), class: "view-link", [VIEW_ATTR]: v }, VIEW_TITLE[v])));
  for (const a of nav.querySelectorAll<HTMLElement>(`a[${VIEW_ATTR}]`)) {
    if (a.getAttribute(VIEW_ATTR) === current) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
}
