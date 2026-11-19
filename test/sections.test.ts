import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSection, loadSectionPrefs, SECTION_TITLE, SECTIONS, saveSectionPref, sectionOpen } from "../src/github/sections.ts";

class MemStorage {
  #m = new Map<string, string>();
  getItem(k: string) {
    return this.#m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.#m.set(k, v);
  }
  removeItem(k: string) {
    this.#m.delete(k);
  }
}

function withStorage<T>(storage: unknown, body: () => T): T {
  const g = globalThis as { localStorage?: unknown };
  const had = Object.getOwnPropertyDescriptor(g, "localStorage");
  Object.defineProperty(g, "localStorage", { value: storage, configurable: true, writable: true });
  try {
    return body();
  } finally {
    if (had) Object.defineProperty(g, "localStorage", had);
    else delete g.localStorage;
  }
}

describe("sections", () => {
  it("has only the Needs you section", () => {
    assert.deepEqual(SECTIONS.map((id) => SECTION_TITLE[id]), ["Needs you"]);
    assert.ok(isSection("needs"));
    assert.ok(!isSection("usage"));
    assert.ok(!isSection("ops"));
  });

  it("open by default only while they need him, and as he left them otherwise", () => {
    assert.equal(sectionOpen("needs", {}, true), true);
    assert.equal(sectionOpen("needs", {}, false), false);
    assert.equal(sectionOpen("needs", { needs: false }, true), false, "he closed it");
    assert.equal(sectionOpen("needs", { needs: true }, false), true, "he opened it");
  });

  it("remember what he opened or closed, tolerate junk, and work without storage", () => {
    withStorage(new MemStorage(), () => {
      assert.deepEqual(loadSectionPrefs(), {});
      saveSectionPref("needs", true);
      assert.deepEqual(loadSectionPrefs(), { needs: true });
      saveSectionPref("needs", false);
      assert.deepEqual(loadSectionPrefs(), { needs: false });
    });
    for (const junk of ['{"ops":true}', '{"needs":"yes"}', "[true]", "nonsense"]) {
      const storage = new MemStorage();
      storage.setItem("review.sections", junk);
      withStorage(storage, () => assert.deepEqual(loadSectionPrefs(), {}, junk));
    }
    withStorage(undefined, () => {
      saveSectionPref("needs", true);
      assert.deepEqual(loadSectionPrefs(), {});
    });
  });
});
