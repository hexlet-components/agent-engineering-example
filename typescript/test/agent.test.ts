import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../src/workspace.ts";
import { investigate } from "../src/agent.ts";
import { demoReport } from "../src/demo-model.ts";

test("demo executes the real SDK, reads sources and reproduces the defect", async () => {
  const result = await investigate({ demo: true });
  assert.equal(result.mode, "demo");
  assert.equal(result.status, "success");
  assert.equal(result.check?.passed, false);
  assert.equal(result.check?.exitCode, 1);
  assert.match(result.check?.output ?? "", /NEIL/);
  assert.deepEqual(result.findings, demoReport.findings);
  assert.deepEqual(
    result.trace.map((item) => item.name).sort(),
    ["read_diff", "search_files", "read_file", "read_file", "run_check"].sort(),
  );
});
test("SDK stops before completion when the turn budget is too small", async () => {
  await assert.rejects(investigate({ demo: true, maxTurns: 1 }), /Max turns/);
});
test("tools reject traversal, invalid ranges and arbitrary commands", async () => {
  const work = new Workspace();
  await assert.rejects(work.invoke("read_file", { path: "../package.json" }), /PATH_DENIED/);
  await assert.rejects(
    work.invoke("read_file", { path: "src/pricing/discount.ts", limit: 41 }),
    /LINE_LIMIT/,
  );
  await assert.rejects(work.invoke("shell", { command: "echo should-not-run" }), /TOOL_DENIED/);
});
test("tool budget applies even when the model asks for more calls in one turn", async () => {
  const work = new Workspace(undefined, 1);
  await work.invoke("list_files");
  await assert.rejects(work.invoke("read_diff"), /TOOL_BUDGET/);
});
test("a successful answer requires the fixed check and actual evidence", async () => {
  const work = new Workspace();
  assert.throws(() => work.validate(demoReport), /CHECK_REQUIRED/);
  await work.invoke("run_check");
  assert.throws(() => work.validate(demoReport), /UNREAD_EVIDENCE/);
  assert.throws(() => work.validate({ findings: [] }), /UNEXPLAINED_CHECK_FAILURE/);
});
test("a symlink cannot grant access outside the fixture", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-example-"));
  try {
    await mkdir(join(root, "fixture"));
    await writeFile(join(root, "private.txt"), "private");
    await symlink(join(root, "private.txt"), join(root, "fixture", "outside.txt"));
    await assert.rejects(
      new Workspace(join(root, "fixture")).invoke("read_file", { path: "outside.txt" }),
      /PATH_DENIED/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a withheld oversized result cannot become evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-large-"));
  try {
    await writeFile(join(root, "large.ts"), "x".repeat(9000));
    const work = new Workspace(root);
    await assert.rejects(work.invoke("read_file", { path: "large.ts" }), /OUTPUT_LIMIT/);
    assert.deepEqual(work.reads, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
