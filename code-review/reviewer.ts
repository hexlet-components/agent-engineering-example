import type { Snapshot } from "./git.ts";

export type Profile = {
  context: boolean;
  specialists: "general" | "all" | "routed";
  scope: "whole" | "files" | "linked";
  stage: "none" | "verify" | "consensus" | "critic" | "filter";
  lookup?: boolean;
  simulateFailure?: boolean;
};
export const baseline: Profile = {
  context: false,
  specialists: "general",
  scope: "whole",
  stage: "none",
};
const context: Profile = { ...baseline, context: true };
const specialists: Profile = { ...context, specialists: "all" };
const routed: Profile = { ...specialists, specialists: "routed" };
export const profiles: Record<string, Profile> = {
  baseline,
  context,
  lookup: { ...baseline, lookup: true },
  specialists,
  routed,
  whole: routed,
  files: { ...routed, scope: "files" },
  linked: { ...routed, scope: "linked" },
  partial: { ...routed, scope: "files", simulateFailure: true },
  verified: { ...specialists, context: false, stage: "verify" },
  consensus: { ...context, stage: "consensus" },
  critic: { ...context, stage: "critic" },
  filtered: { ...specialists, stage: "filter" },
};

type Direction = "general" | "requirements" | "correctness" | "architecture" | "security";
export type Finding = {
  kind: "limit" | "ttl" | "style";
  path: string;
  line: number;
  text: string;
  direction: Direction;
  severity: "high" | "medium" | "low";
};
const directions: Direction[] = ["correctness", "requirements", "architecture", "security"];
type Packet = { files: Record<string, string>; rules: string; direction: Direction };
export type Executor = (input: Packet) => Finding[];

// Deterministic substitute for model calls. Its input contains only the selected packet.
export const execute: Executor = ({ files, rules, direction }) => {
  const output: Finding[] = [];
  for (const [path, code] of Object.entries(files)) {
    if (!path.startsWith("exports/")) continue;
    const lines = code.split("\n");
    const lineOf = (pattern: string) => lines.findIndex((line) => line.includes(pattern)) + 1;
    const unbounded = lineOf("const rows = orders;");
    const ttl = lineOf("archive(rows, retentionSeconds);");
    const exempt =
      path === "exports/internal.ts" &&
      rules.includes("Internal reconciliation requires all orders.");
    if (unbounded && !exempt && ["general", "requirements", "correctness"].includes(direction))
      output.push({
        kind: "limit",
        path,
        line: unbounded,
        text: "При 101 заказе экспорт запишет все 101. Публичная выгрузка допускает только 100.",
        direction,
        severity: "high",
      });
    if (
      ttl &&
      files["storage.ts"]?.includes("durationMs") &&
      (direction === "architecture" ||
        (direction === "general" && Object.keys(files)[0] === "storage.ts"))
    )
      output.push({
        kind: "ttl",
        path,
        line: ttl,
        text: "При сроке 60 секунд архив получит 60 мс. Передайте срок в миллисекундах.",
        direction,
        severity: "medium",
      });
    if (direction === "correctness")
      output.push({
        kind: "style",
        path,
        line: lineOf("const rows"),
        text: "Уточните имя переменной rows.",
        direction,
        severity: "low",
      });
  }
  return output;
};
export const key = (f: Finding) => [f.path, f.line, f.kind].join("#");
export function distinct(findings: Finding[]) {
  return [...new Map(findings.map((f) => [key(f), f])).values()];
}
export function review(pr: Snapshot, config: Profile, executor: Executor = execute) {
  const start = performance.now();
  const rules = pr.files["rules/export.md"];
  const trace: { role: string; paths: string[]; status: string }[] = [];
  let calls = 0;
  const scope =
    config.scope === "linked"
      ? [
          ...new Set([
            ...pr.changed,
            ...pr.changed.flatMap((path) =>
              [...pr.files[path].matchAll(/from "\.\.\/(.+?)"/g)].map((match) => match[1]),
            ),
          ]),
        ]
      : pr.changed;
  const units = config.scope === "files" ? scope.map((path) => [path]) : [scope];
  const active =
    config.specialists === "general"
      ? ["general" as const]
      : config.specialists === "all"
        ? directions
        : directions.filter(
            (d) => d !== "security" || scope.some((path) => path.startsWith("auth/")),
          );
  function call(
    paths: string[],
    direction: Direction,
    role: string = direction,
    withRules = config.context,
  ) {
    calls++;
    trace.push({ role, paths, status: "checked" });
    return executor({
      files: Object.fromEntries(paths.map((path) => [path, pr.files[path]])),
      rules: withRules ? rules : "",
      direction,
    });
  }
  let candidates: Finding[] = [];
  for (const paths of units) {
    if (config.simulateFailure && paths.includes("storage.ts")) {
      trace.push({ role: "file", paths, status: "failed" });
      continue;
    }
    for (const direction of active) candidates.push(...call(paths, direction));
  }
  for (const path of Object.keys(pr.files).filter((p) => !scope.includes(p)))
    trace.push({ role: "code-scope", paths: [path], status: "skipped" });
  const initial = [...candidates];
  let published = candidates;
  if (config.lookup && candidates.some((f) => f.kind === "limit")) {
    trace.push({ role: "read-rules", paths: ["rules/export.md"], status: "checked" });
    published = call(scope, "general", "after-lookup", true);
  }
  if (config.stage === "consensus") {
    const reversed = call([...scope].reverse(), "general", "second-pass");
    published = distinct(candidates.filter((f) => reversed.some((other) => key(f) === key(other))));
    candidates = [...candidates, ...reversed];
  }
  if (config.stage === "verify" || config.stage === "consensus") {
    published = published.filter((f) => {
      calls++;
      trace.push({
        role: "verify:" + key(f),
        paths: [f.path, "rules/export.md", "storage.ts"],
        status: "checked",
      });
      if (f.kind === "limit")
        return !(f.path === "exports/internal.ts" && rules.includes("requires all orders"));
      if (f.kind === "ttl")
        return (
          pr.files[f.path].includes("archive(rows, retentionSeconds);") &&
          pr.files["storage.ts"].includes("durationMs")
        );
      return false;
    });
  }
  if (config.stage === "critic") {
    // The critic receives the complete draft. It inspects unit conversion when nobody covered retention.
    const draft = candidates;
    if (!draft.some((f) => f.kind === "ttl")) {
      const search = call(scope, "architecture", "critic:read-draft-and-check-retention");
      candidates = [
        ...draft,
        ...search.filter((f) => !draft.some((other) => key(other) === key(f))),
      ];
      published = candidates;
    }
  }
  if (config.stage === "filter")
    published = distinct(candidates).filter((f) => f.severity === "high");
  return { initial, candidates, published, trace, calls, localMs: performance.now() - start };
}
