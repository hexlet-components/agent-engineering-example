import assert from "node:assert/strict";
import { test } from "node:test";
import { History } from "./git.ts";
import { profiles, review } from "./reviewer.ts";
import { reconcile, update } from "./update.ts";

test("update checks revisions, closes confirmed repairs once and moves surviving threads", () => {
  const history = new History();
  try {
    const published = update(history, "orders-v1", "orders-v2");
    assert.deepEqual(published.updates, [
      { kind: "limit", path: "exports/public.ts", oldLine: 5, action: "resolve" },
      { kind: "ttl", path: "exports/public.ts", oldLine: 6, line: 7, action: "update-thread" },
    ]);
    for (const [from, to, head, status] of [
      ["orders-v2", "orders-v2", "orders-v2", "unchanged"],
      ["orders-v1", "orders-v2", "orders-v1", "stale"],
      ["orders-v2", "orders-v1", "orders-v1", "non-ancestor"],
      ["internal", "orders-v1", "orders-v1", "non-ancestor"],
    ]) {
      const result = update(history, from, to, head);
      assert.equal(result.status, status);
      assert.deepEqual(result.updates, []);
    }
    const pr = history.snapshot("orders-v1");
    const draft = review(pr, profiles.baseline).published;
    const repaired = history.snapshot("orders-v2");
    for (const snapshot of [
      { ...repaired, changed: ["storage.ts"] },
      {
        ...repaired,
        files: {
          ...repaired.files,
          [repaired.path]: repaired.files[repaired.path].replace("slice(0, 100)", "slice(0, 101)"),
        },
      },
    ]) {
      const result = reconcile(draft, review(snapshot, profiles.linked), snapshot);
      assert.ok(!result.updates.some((action) => action.action === "resolve"));
      assert.equal(result.pending[0].kind, "limit");
    }
  } finally {
    history.close();
  }
});
