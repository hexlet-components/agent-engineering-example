import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { investigate, resume } from "../src/agent.ts";
import { fixture } from "../src/workspace.ts";

for (const scenario of Object.keys(fixture("scenarios") as object)) {
  test(scenario, async () => {
    const result = await investigate({ scenario });
    for (const run of result.runs) {
      const calls = run.trace.filter((e) => e.type === "call").map((e) => e.call_id);
      assert.ok(calls.length);
      assert.equal(calls.length, new Set(calls).size);
      assert.deepEqual(
        calls,
        run.trace.filter((e) => e.type === "result").map((e) => e.call_id),
      );
      const expected =
        scenario === "verification"
          ? ["retry", run.case === "repair" ? "accepted" : "exhausted"]
          : ["accepted"];
      assert.deepEqual(
        run.decisions.map((d) => d.decision),
        expected,
      );
    }
    if (scenario === "trajectories") {
      const tickets = fixture("tickets") as Record<string, unknown>;
      const events = result.runs[0].trace;
      for (const [index, id] of ["T-42", "T-17"].entries()) {
        const [request, response] = events.slice(2 * index, 2 * index + 2);
        assert.equal(request.name, "read_ticket");
        assert.deepEqual(request.arguments, { ticket_id: id });
        assert.equal(response.call_id, request.call_id);
        assert.deepEqual(response.output, { status: "found", ticket: tickets[id] });
      }
    }
    if (scenario === "trust-boundaries")
      assert.deepEqual(
        result.runs.map((r) => r.labels),
        [{}, { "T-42": "needs-info" }],
      );
    if (scenario === "task-state")
      assert.deepEqual(
        result.runs.map((r) => r.decisions[0].report.action),
        ["ask_author", "check_export"],
      );
  });
}
test("wrong reply keeps pause", async () => {
  const folder = await mkdtemp(join(tmpdir(), "ticket-test-"));
  try {
    const path = join(folder, "task.json");
    const state = { status: "waiting", request_id: "Q-42", ticket_id: "T-42", reason: "Фильтр?" };
    await writeFile(path, JSON.stringify(state));
    await assert.rejects(resume(path, { request_id: "Q-17", ticket_id: "T-42", text: "Да" }));
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), state);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
