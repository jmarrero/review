import { h } from "../dom.ts";
import type { People } from "./people.ts";
import { age } from "./view.ts";

export interface PeopleHooks {
  done(id: string): Promise<void>;
  changed(): void;
}

/**
 * The header's people count. It is only read while From people is open
 * (the read costs a search, timelines and notifications), so while it is
 * closed a count would be either missing or a stale copy; show a dash
 * instead. When it was last read is in the freshness line ("people").
 */
export function peopleMeta(people: People | undefined, open: boolean): { text: string; title: string } {
  if (!open) return { text: "people —", title: "Open From people to read" };
  return { text: `people ${people ? people.rows.length : "…"}`, title: people ? "Human asks" : "Reading human asks" };
}

export function peopleView(people: People | undefined, now: number, hooks: PeopleHooks): HTMLElement {
  const el = h("div", { class: "people-list" });
  if (!people) return h("p", { class: "note" }, "Reading human review requests and notifications…");
  for (const warning of people.warnings) el.append(h("p", { class: "warn" }, warning));
  if (!people.rows.length) el.append(h("p", { class: "empty" }, people.warnings.length ? "No human asks found in the available sources." : "No pending human asks."));
  for (const row of people.rows) {
    const status = h("span", { role: "status", class: "note" }, row.markError ?? "");
    const article = h("article", { class: "people-row" },
      h("a", { href: row.url }, `${row.ref.owner}/${row.ref.repo}#${row.ref.number} ${row.title}`),
      h("span", { class: "tag" }, ` · ${row.author} · ${row.unlocated ? "mention (not located)" : `request ${row.requestedAt ? age(row.requestedAt, now) : "age unknown"}`} · CI ${row.ci}`),
      h("a", { href: `${row.url}${row.action === "Review" ? "/files" : "#issuecomment-new"}`, class: "action" }, row.action), status,
    );
    if (row.notificationIds.length) {
      const done = h("button", { type: "button", class: "small" }, "Mark done");
      done.disabled = !!row.marking;
      if (row.marking) status.textContent = "Marking read…";
      done.addEventListener("click", async () => {
        if (row.marking) return;
        row.marking = true;
        delete row.markError;
        done.disabled = true;
        status.textContent = "Marking read…";
        try {
          for (const id of [...row.notificationIds]) {
            await hooks.done(id);
            row.notificationIds = row.notificationIds.filter((n) => n !== id);
          }
          if (!row.reviewRequested) people.rows = people.rows.filter((r) => r !== row);
          delete row.marking;
          hooks.changed();
        } catch (e) {
          delete row.marking;
          row.markError = `Couldn't mark read: ${e instanceof Error ? e.message : String(e)}`;
          status.textContent = row.markError;
          done.disabled = false;
          hooks.changed();
        }
      });
      article.append(done);
    }
    el.append(article);
  }
  return el;
}
