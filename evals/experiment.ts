import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { localApiBase, localModelName } from "./local.ts";

import type { triage } from "./agent.ts";

type Attempt = Awaited<ReturnType<typeof triage>>;
type Annotation = { duplicate: string | null; needsInfo: boolean };
type Sample = { split: string; ticket: string; answer: string; human: boolean };
type Row<T> = {
  vars: { id: string };
  success: boolean;
  failureReason: number;
  response: { output: T; error?: string };
};

const load = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8"));
const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2));
mkdirSync("var", { recursive: true });
const stage = process.argv[2];
const provider = (mode: string) => ({
  id: "file://" + resolve("provider.mjs"),
  label: mode,
  config: { mode },
});
const working = ["T-42", "T-43", "T-44", "T-45"];

function evaluate<T = Attempt>(name: string, tests: object[], modes: string[], repeat = 1) {
  const config = { prompts: ["Тикет {{id}}"], providers: modes.map(provider), tests };
  const path = resolve("var", name + ".config.json");
  const report = resolve("var", name + ".json");
  save(path, config);
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/promptfoo/dist/src/entrypoint.js",
      "eval",
      "-c",
      path,
      "--no-cache",
      "--no-write",
      "--no-share",
      "--no-table",
      "--no-progress-bar",
      "--repeat",
      String(repeat),
      "-o",
      report,
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        PROMPTFOO_CONFIG_DIR: resolve("var/config"),
        PROMPTFOO_DISABLE_TELEMETRY: "1",
        PROMPTFOO_DISABLE_UPDATE: "1",
        PROMPTFOO_PASS_RATE_THRESHOLD: "0",
      },
    },
  );
  if (result.status !== 0) throw new Error("Promptfoo failed: " + (result.status ?? result.error));
  const rows = load<{ results: { results: Row<T>[] } }>(report).results.results;
  if (
    rows.length !== tests.length * modes.length * repeat ||
    rows.some(
      (row) => row.failureReason === 2 || row.response?.error || row.response?.output == null,
    )
  )
    throw new Error("Incomplete evaluation. Inspect " + report);
  return rows;
}

function qualityTests(ids: string[]) {
  const labels = load<Record<string, Annotation>>("labels.json");
  return ids.map((id) => ({
    vars: { id },
    assert: [
      {
        type: "javascript",
        value: "output.answer.duplicate === " + JSON.stringify(labels[id].duplicate),
      },
      ...(labels[id].needsInfo
        ? [{ type: "javascript", value: "output.answer.question.trim().length > 0" }]
        : []),
      {
        type: "javascript",
        value: "output.state.labels.includes('needs-info') === " + labels[id].needsInfo,
      },
    ],
  }));
}

if (stage === "first" || stage === "replay") {
  const rows = evaluate(stage, load<object[]>("first.json"), [
    stage === "first" ? "baseline" : "replay",
  ]);
  console.table(
    rows.map((row) => ({
      id: row.vars.id,
      success: row.success,
      answer: row.response.output.answer,
    })),
  );
} else if (stage === "calibrate") {
  const rubric = load<Record<string, string>>("rubric.json");
  const samples = load<Sample[]>("calibration.json");
  for (const [revision, split] of [
    ["initial", "work"],
    ["revised", "work"],
    ["revised", "check"],
  ]) {
    const group = samples.filter((row) => row.split === split);
    const tests = group.map((row, index) => ({
      vars: { id: String(index), sample: row.answer, ticket: row.ticket },
      assert: [
        {
          type: "llm-rubric",
          value: rubric[revision] + " Исходное сообщение: {{ticket}}",
          provider:
            process.env.TRIAGE_BACKEND === "local"
              ? {
                  id: "openai:chat:" + localModelName(),
                  config: { apiBaseUrl: localApiBase(), apiKey: "local", temperature: 0 },
                }
              : "openai:chat:" + (process.env.JUDGE_MODEL || "gpt-4.1-mini"),
        },
      ],
    }));
    const rows = evaluate<string>("calibrate-" + revision + "-" + split, tests, ["sample"]);
    const wrong = rows.filter((row) => row.success !== group[Number(row.vars.id)].human);
    console.log({
      revision,
      split,
      total: rows.length,
      falseAccept: wrong.filter((row) => row.success).length,
      falseReject: wrong.filter((row) => !row.success).length,
    });
  }
} else if (["metrics", "compare", "release", "regression", "expanded"].includes(stage)) {
  const ids =
    stage === "release"
      ? ["T-71", "T-72", "T-73"]
      : stage === "regression"
        ? load<string[]>("regression.json")
        : stage === "expanded"
          ? [...new Set([...load<string[]>("regression.json"), "T-90"])]
          : working;
  const paired = ["compare", "release"].includes(stage);
  if (stage === "expanded") {
    const [recorded] = evaluate("incident", qualityTests(["T-90"]), ["recorded"]);
    if (recorded.success) throw new Error("The historical incident passed the regression check");
  }
  const rows = evaluate(
    stage,
    qualityTests(ids),
    paired ? ["baseline", "candidate"] : [stage === "metrics" ? "baseline" : "candidate"],
    paired ? 3 : 1,
  );
  const labels = load<Record<string, Annotation>>("labels.json");
  if (stage === "metrics") {
    let tp = 0,
      fp = 0,
      fn = 0;
    for (const row of rows) {
      const expected = labels[row.vars.id].duplicate,
        actual = row.response.output.answer.duplicate;
      if (actual && actual === expected) tp++;
      if (actual && actual !== expected) fp++;
      if (expected && expected !== actual) fn++;
    }
    console.log({
      tp,
      fp,
      fn,
      precision: tp + fp ? tp / (tp + fp) : null,
      recall: tp + fn ? tp / (tp + fn) : null,
    });
  }
  console.table(
    rows.map((row) => ({
      id: row.vars.id,
      version: row.response.output.version,
      success: row.success,
      costUsd: row.response.output.costUsd,
      latencyMs: row.response.output.latencyMs,
    })),
  );
} else throw new Error("Unknown stage: " + stage);
