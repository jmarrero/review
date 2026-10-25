import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authorLabel, isBot, roleOf } from "../src/github/authors.ts";
import { BOT_LOGIN } from "../src/github/config.ts";

const apps = [{ login: "forge-review[bot]", role: "review" }];

describe("authors", () => {
  it("counts the bot's user account and its listed role apps as the bot, nobody else", () => {
    assert.equal(isBot(BOT_LOGIN, apps), true);
    assert.equal(isBot("Forge-Review[bot]", apps), true);
    assert.equal(isBot("other[bot]", apps), false);
    assert.equal(isBot("forge-review", apps), false);
    assert.equal(isBot(undefined, apps), false);
    assert.equal(isBot("", apps), false);
  });

  it("trusts no app until one is listed", () => {
    assert.equal(isBot(BOT_LOGIN), true);
    assert.equal(isBot("forge-review[bot]"), false);
    assert.equal(roleOf("forge-review[bot]"), undefined);
  });

  it("shows the role of a role app next to its login, and other logins as they are", () => {
    assert.equal(roleOf("forge-review[bot]", apps), "review");
    assert.equal(authorLabel("forge-review[bot]", apps), "forge-review[bot] (review)");
    assert.equal(authorLabel(BOT_LOGIN, apps), BOT_LOGIN);
    assert.equal(authorLabel("jmarrero", apps), "jmarrero");
  });
});
