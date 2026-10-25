// The stylesheet's touch-screen font floor: iOS Safari zooms in on a focused field under 16px.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";

const css = readFileSync(new URL("../static/style.css", import.meta.url), "utf8");

// jsdom's getComputedStyle ignores !important and specificity, so read the CSSOM instead.
function floorRules(win: JSDOM["window"]): CSSStyleRule[] {
  const rules: CSSStyleRule[] = [];
  for (const rule of Array.from(win.document.styleSheets[0]!.cssRules)) {
    if (!(rule instanceof win.CSSMediaRule) || !/any-pointer:\s*coarse/.test(rule.media.mediaText)) continue;
    for (const inner of Array.from(rule.cssRules)) {
      if (!(inner instanceof win.CSSStyleRule)) continue;
      if (inner.style.getPropertyValue("font-size") === "16px" && inner.style.getPropertyPriority("font-size") === "important") rules.push(inner);
    }
  }
  return rules;
}

describe("touch-screen font floor", () => {
  // The fields the app renders: sign-in token, review and composer textareas, the
  // decisions reply, capture's link, repo and selects, and Make it mine's inputs.
  const { window: win } = new JSDOM(`<style>${css}</style>
    <input type="password"><input type="text"><input class="capture-repo"><input type="url"><input type="email">
    <table><tr class="composer"><td><textarea></textarea></td></tr></table><textarea class="mine-msg"></textarea>
    <div class="capture-extra"><input type="url"></div><select></select>
    <input type="radio"><input type="checkbox">`);
  const floor = floorRules(win);
  const covered = (el: Element) => floor.some((rule) => el.matches(rule.selectorText));

  it("gives every typed-into field 16px on touch screens", () => {
    assert.ok(floor.length > 0, "no 16px !important rule under (any-pointer: coarse)");
    const fields = win.document.querySelectorAll("textarea, select, input:not([type=radio]):not([type=checkbox])");
    assert.equal(fields.length, 9);
    for (const el of Array.from(fields)) assert.ok(covered(el), `not covered: ${el.outerHTML}`);
  });

  it("leaves radios and checkboxes alone", () => {
    for (const el of Array.from(win.document.querySelectorAll("input[type=radio], input[type=checkbox]"))) assert.ok(!covered(el), el.outerHTML);
  });
});
