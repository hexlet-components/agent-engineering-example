// Check the annotations through the export's observable behavior.
// Run separately from the reviewer. The reviewer has no access to this module.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { corpus, data, History } from "./git.ts";
const split = process.argv[2];
if (split !== "work" && split !== "holdout" && split !== "transfer")
  throw Error("Choose work, transfer or holdout");
const history = new History();
const labels = data<Record<string, { kind: string }[]>>("labels.json");
try {
  for (const id of corpus[split]) {
    const pr = history.snapshot(id);
    const checkout = mkdtempSync(join(tmpdir(), "order-contract-"));
    try {
      for (const [path, body] of Object.entries(pr.files)) {
        const file = join(checkout, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, body);
      }
      const { exportOrders } = (await import(pathToFileURL(join(checkout, pr.path)).href)) as {
        exportOrders: (rows: string[]) => { rows: string[]; durationMs: number };
      };
      const observed = exportOrders(Array.from({ length: 101 }, (_, i) => String(i)));
      const violations: string[] = [];
      if (observed.rows.length !== (pr.path === "exports/internal.ts" ? 101 : 100))
        violations.push("limit");
      if (observed.durationMs !== 60000) violations.push("ttl");
      assert.deepEqual(violations.sort(), labels[id].map((x) => x.kind).sort());
      console.log(id, observed.rows.length, observed.durationMs, violations);
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  }
} finally {
  history.close();
}
