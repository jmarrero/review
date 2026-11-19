import assert from "node:assert/strict";
import { it } from "node:test";
import { run } from "../src/cli/controlplane.ts";
import { fixture } from "./helpers.ts";

const NOW = "2026-11-13T12:05:00Z";

for (const complete of [false, true]) {
  for (const state of ["fresh", "stale", "error", "missing", "malformed"] as const) {
    it(`service needs-you keeps provenance and diagnostics: ${complete}, ${state}`, async () => {
      const d = fixture<Record<string, unknown>>("service-decision.json");
      d.complete = complete;
      const list = d.needs_you as Record<string, unknown>;
      list.complete = false;
      list.sources = { items: "partial", reviews: "off", epics: "off", proposals: "off", digest: "off" };
      list.omitted = 3;
      list.count = 5;
      list.summaries = "partial";
      if (state === "stale") list.validated_at = "2026-11-13T10:00:00Z";
      if (state === "missing") d.needs_you = null;
      if (state === "malformed") d.needs_you = { schema: "unsupported" };
      const replay = { schema: "review-service/v1", generation: 7, decision: {
        items: [d], complete, readAt: "2026-11-13T12:00:00Z", error: state === "error" ? "Preview refresh failed" : null,
      } };
      let out = "", err = "", calls = 0;
      const code = await run(["needs-you"], {
        serviceUrl: "https://control.example", token: async () => { throw new Error("token forbidden"); },
        fetch: async (url) => { calls++; assert.equal(url, "https://control.example/api/v1/state"); return Response.json(replay); },
        stdout: (s) => { out += s; }, stderr: (s) => { err += s; }, now: () => new Date(NOW), isTty: false,
      });
      assert.equal(code, 0, err);
      assert.equal(calls, 1);
      const body = JSON.parse(out);
      assert.equal(body.source, "service");
      assert.equal(body.settled, false);
      assert.doesNotMatch(body.note, /checked on GitHub|browser's cache/);
      if (!complete) assert.match(body.note, /Service decision is incomplete/);
      if (state === "error") assert.match(body.note, /Preview refresh failed/);
      if (state === "missing" || state === "malformed") {
        assert.match(body.note, state === "missing" ? /has no needs-you list/ : /can't be used/);
        assert.match(body.note, /snapshot's own operator holds/);
      } else {
        assert.match(body.note, /received from service just now/);
        assert.match(body.note, /items partial/);
        assert.match(body.note, /3 past the pass's cap/);
        assert.match(body.note, /Not every summary was read/);
        if (state === "stale") assert.match(body.note, /not confirmed it for over an hour/);
        assert.equal(body.validatedAt, list.validated_at);
        assert.deepEqual(body.cards.map((c: { key: string }) => c.key), ["example/work#2", "example/work#1"]);
      }
    });
  }
}
