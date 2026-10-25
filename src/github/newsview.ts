// The merged PRs in the "Changes" section: newest first, harness changes marked.

import { h, link } from "../dom.ts";
import type { Renderer } from "../markdown.ts";
import { authorLabel } from "./authors.ts";
import type { News } from "./news.ts";
import { age, time } from "./view.ts";

/** The class of a merged PR's article, which the section shows a few of before "View all". */
export const NEWS_ITEM_CLASS = "news-item";

export function newsList(news: News | undefined, render: Renderer, now: number = Date.now()): HTMLElement {
  const root = h("div", { class: "news" }, h("h3", { class: "group-h" }, "Merged PRs (the bot, its runner and this app; harness changes marked)"));
  if (!news) {
    root.append(h("p", { class: "empty" }, "Loading…"));
    return root;
  }
  for (const w of news.warnings) root.append(h("p", { class: "warn" }, `Couldn't read ${w}`));
  if (news.items.length === 0) root.append(h("p", { class: "empty" }, "Nothing merged recently."));
  for (const n of news.items) {
    root.append(
      h(
        "article",
        { class: `${NEWS_ITEM_CLASS}${n.harness ? " harness" : ""}` },
        h(
          "div",
          { class: "sub" },
          n.harness ? h("span", { class: "kind k-harness" }, "harness") : null,
          h("span", { class: "tag" }, `${n.repo}#${n.number} · ${authorLabel(n.author)}`),
          h("span", { class: "age", title: `merged ${time(n.mergedAt)}` }, `${age(n.mergedAt, now)} ago`),
        ),
        h("h3", {}, link(n.url, n.title)),
        n.summary ? h("div", { class: "md" }, render(n.summary)) : null,
      ),
    );
  }
  return root;
}
