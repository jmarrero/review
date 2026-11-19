// The source layer: every read the page's views show, each with what it
// reads, how often, and the views that need it. A source is read only
// while one of those views is on screen, and at most once per cadence;
// the poll loop ticks it (so the loop's visibility and rate-limit rules
// hold for every source), and so does switching to a view. Each view's
// "checked N s ago" comes from when its sources last settled.

export interface SourceDef<V extends string> {
  name: string;
  /** What it reads, as API paths or in words; shown in the view's freshness tooltip. */
  path: string;
  /** The least time between two reads (ms). */
  cadence: number;
  /** The views that show it. */
  views: readonly V[];
  /**
   * One read; `force` when he asked for a refresh. It resolves false when
   * it read nothing (it failed, or one was running already), so the view
   * doesn't call the source checked. Absent for a source the poll loop
   * reads itself and reports with checked().
   */
  read?(force: boolean): Promise<boolean | void>;
  /** A further condition, e.g. that the fold showing it is open. */
  when?(): boolean;
}

interface Run {
  started?: number;
  running: boolean;
  checked?: number;
}

export class SourceLayer<V extends string> {
  readonly #defs: readonly SourceDef<V>[];
  readonly #visible: () => V | undefined;
  readonly #runs = new Map<string, Run>();

  /** `visible` is the view on screen, if any (none while the tab is hidden or another page shows). */
  constructor(defs: readonly SourceDef<V>[], visible: () => V | undefined) {
    this.#defs = defs;
    this.#visible = visible;
    for (const d of defs) this.#runs.set(d.name, { running: false });
  }

  /** Start every source the view on screen needs that isn't running and is due; `force` ignores the cadence. */
  tick(force = false, now = Date.now()): void {
    const view = this.#visible();
    if (view === undefined) return;
    for (const d of this.#defs) {
      const run = this.#runs.get(d.name)!;
      if (!d.read || run.running || !d.views.includes(view)) continue;
      if (!force && run.started !== undefined && now - run.started < d.cadence) continue;
      if (d.when && !d.when()) continue;
      run.started = now;
      run.running = true;
      let p: Promise<boolean | void>;
      try {
        p = d.read(force);
      } catch (e) {
        p = Promise.reject(e);
      }
      p.then(
        (read) => {
          if (read !== false) run.checked = Date.now();
        },
        (e: unknown) => console.error(`review: reading ${d.name} failed:`, e),
      ).finally(() => {
        run.running = false;
      });
    }
  }

  /** Record that `name` was just read by other means (the poll loop's own, or a read that also serves it); it isn't due again for a cadence. */
  checked(name: string, now = Date.now()): void {
    const run = this.#runs.get(name);
    if (!run) throw new Error(`unknown source ${name}`);
    run.checked = now;
    run.started = now;
  }

  /**
   * When everything `view` shows was last checked: its sources' oldest
   * check, undefined until each has been read once; and each source's,
   * for a tooltip. A source it shows only on a condition that doesn't
   * hold now (a closed fold) doesn't count.
   */
  freshness(view: V): { at: number | undefined; sources: { name: string; path: string; checked: number | undefined }[] } {
    const sources = this.#defs.filter((d) => d.views.includes(view) && (!d.when || d.when())).map((d) => ({ name: d.name, path: d.path, checked: this.#runs.get(d.name)!.checked }));
    const times = sources.map((s) => s.checked);
    const at = times.length === 0 || times.some((t) => t === undefined) ? undefined : Math.min(...(times as number[]));
    return { at, sources };
  }
}

/** "checked 12 s ago", "checked 3 min ago", or "checking…" before the first read. */
export function checkedText(at: number | undefined, now: number): string {
  if (at === undefined) return "checking…";
  const s = Math.max(0, Math.floor((now - at) / 1000));
  return s < 60 ? `checked ${s} s ago` : `checked ${Math.floor(s / 60)} min ago`;
}
