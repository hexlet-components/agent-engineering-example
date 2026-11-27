import { pathToFileURL } from "node:url";
import { corpus, History, type Snapshot } from "./git.ts";
import { distinct, profiles, review, type Finding } from "./reviewer.ts";

type Report = ReturnType<typeof review>;
type Action = {
  kind: Finding["kind"];
  path: string;
  oldLine?: number;
  line?: number;
  action: "create" | "resolve" | "update-thread";
};
function threadFindings(report: Report) {
  return distinct(report.published.filter((finding) => finding.kind !== "style"));
}
function confirmsRepair(finding: Finding, pr: Snapshot) {
  const code = pr.files[finding.path] ?? "";
  if (finding.kind === "limit")
    return (
      code.includes("const rows = orders.slice(0, 100);") && code.includes("return archive(rows,")
    );
  if (finding.kind === "ttl")
    return (
      code.includes("return archive(rows, retentionSeconds * 1000);") &&
      pr.files["storage.ts"]?.includes("durationMs")
    );
  return false;
}
export function reconcile(before: Finding[], report: Report, snapshot: Snapshot) {
  const after = threadFindings(report);
  const same = (a: Finding, b: Finding) => a.kind === b.kind && a.path === b.path;
  const updates: Action[] = [];
  const pending: { kind: Finding["kind"]; path: string; reason: string }[] = [];
  for (const old of distinct(before)) {
    const current = after.find((candidate) => same(candidate, old));
    if (current) {
      if (current.line !== old.line)
        updates.push({
          kind: old.kind,
          path: old.path,
          oldLine: old.line,
          line: current.line,
          action: "update-thread",
        });
      continue;
    }
    const checks = report.trace.filter((entry) => entry.paths.includes(old.path));
    const covered =
      checks.some((entry) => entry.status === "checked") &&
      !checks.some((entry) => entry.status === "failed");
    if (covered && confirmsRepair(old, snapshot))
      updates.push({ kind: old.kind, path: old.path, oldLine: old.line, action: "resolve" });
    else
      pending.push({
        kind: old.kind,
        path: old.path,
        reason: covered ? "repair-unconfirmed" : "outside-completed-review",
      });
  }
  for (const finding of after.filter((candidate) => !before.some((old) => same(candidate, old)))) {
    updates.push({ kind: finding.kind, path: finding.path, line: finding.line, action: "create" });
  }
  return { updates, pending };
}

export function update(history: History, previous: string, next: string, current = next) {
  const ref = (id: string) => {
    if (!Object.hasOwn(corpus.revisions, id)) throw Error("Unknown PR version " + id);
    return corpus.revisions[id].head;
  };
  const revisions = { previous: ref(previous), checked: ref(next), current: ref(current) };
  const noUpdates = { ...revisions, changed: [], updates: [], pending: [] };
  if (revisions.checked !== revisions.current) return { ...noUpdates, status: "stale" };
  if (revisions.previous === revisions.checked) return { ...noUpdates, status: "unchanged" };
  const ancestor = history.git("merge-base", revisions.previous, revisions.checked).trim();
  if (ancestor !== revisions.previous) return { ...noUpdates, status: "non-ancestor" };
  const old = history.snapshot(previous);
  const latest = history.snapshot(next, old.head);
  const before = threadFindings(review(old, profiles.linked));
  const report = review(latest, profiles.linked);
  const full = threadFindings(review(history.snapshot(next), profiles.linked));
  return {
    ...revisions,
    changed: latest.changed,
    incremental: threadFindings(report),
    full,
    status: "published",
    ...reconcile(before, report, latest),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const history = new History();
  try {
    const [previous, next, current] = process.argv.slice(2);
    console.log(JSON.stringify(update(history, previous, next, current), null, 2));
  } finally {
    history.close();
  }
}
