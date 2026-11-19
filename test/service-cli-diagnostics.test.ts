import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { run } from "../src/cli/controlplane.ts";
import { fixture } from "./helpers.ts";

const NOW = Date.parse("2026-11-13T12:05:00Z");

describe("service CLI needs-you diagnostics", () => {
  for (const failure of [false, true]) for (const kind of ["stale", "partial", "absent", "malformed"]) {
    it(`preserves ${kind} list diagnostics with ${failure ? "read failure" : "partial coverage"}`, async () => {
      const decision = fixture<Record<string, unknown>>("service-decision.json");
      const list = decision.needs_you as Record<string, unknown>;
      let expected: RegExp[];
      if (kind === "stale") {
        list.validated_at = "2026-11-13T10:00:00Z";
        expected = [/has not confirmed it for over an hour/];
      } else if (kind === "partial") {
        Object.assign(list, { complete: false, omitted: 3, count: 5, summaries: "partial",
          sources: { items: "partial", reviews: "off", epics: "off", proposals: "off", digest: "off" } });
        expected = [/items partial/, /3 past the pass's cap/, /Not every summary was read/];
      } else {
        decision.needs_you = kind === "absent" ? null : { schema: "unknown" };
        expected = [kind === "absent" ? /has no needs-you list/ : /needs-you list can't be used/, /snapshot's own operator holds/];
      }
      let out = "", err = "", calls = 0;
      const code = await run(["needs-you"], {
        serviceUrl: "https://control.example", token: async () => { throw new Error("token forbidden"); },
        fetch: async () => {
          calls++;
          return Response.json({ schema: "review-service/v1", generation: 7, decision: {
            items: [decision], complete: false, readAt: "2026-11-13T12:00:00Z", error: failure ? "Preview read failed" : null,
          } });
        },
        stdout: (s) => { out += s; }, stderr: (s) => { err += s; }, now: () => new Date(NOW), isTty: false,
      });
      assert.equal(code, 0, err);
      assert.equal(calls, 1);
      const body = JSON.parse(out);
      assert.match(body.note, failure ? /^.*Preview read failed/ : /^Service decision is incomplete/);
      for (const diagnostic of expected) assert.match(body.note, diagnostic);
      assert.equal(body.settled, false);
      assert.equal(body.complete, false);
      assert.equal(body.generation, 7);
      assert.deepEqual(body.cards.map((c: { key: string }) => c.key), ["example/work#2", "example/work#1"]);
    });
  }
});
