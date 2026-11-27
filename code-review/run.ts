import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { corpus, data, History, type Snapshot } from "./git.ts";
import {
  profiles,
  review,
  key,
  distinct,
  execute,
  type Finding,
  type Profile,
} from "./reviewer.ts";

const labels = data<Record<string, Pick<Finding, "path" | "line" | "kind">[]>>("labels.json");
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function score(pr: Snapshot, profile: Profile) {
  const { published, calls, localMs } = review(pr, profile);
  const expected = new Set(labels[pr.id].map((f) => [f.path, f.line, f.kind].join("#")));
  const reported = new Set(published.map(key));
  const found = [...expected].filter((k) => reported.has(k)).length;
  const missed = expected.size - found;
  const wrong = [...reported].filter((k) => !expected.has(k)).length;
  return { found, missed, wrong, duplicates: published.length - reported.size, calls, localMs };
}
function compare(history: History, split: string) {
  if (split !== "work" && split !== "holdout") throw Error("Choose work or holdout");
  let options = profiles;
  let lock: string | undefined;
  if (split === "holdout") {
    const bytes = readFileSync(new URL("./data/frozen.json", import.meta.url));
    lock = digest(bytes);
    const expected = readFileSync(new URL("./data/frozen.sha256", import.meta.url), "utf8").trim();
    if (lock !== expected) throw Error("Frozen profiles differ from recorded SHA-256");
    const manifest = JSON.parse(bytes.toString()) as {
      profiles: Record<string, Profile>;
      sources: Record<string, string>;
    };
    for (const [path, hash] of Object.entries(manifest.sources)) {
      if (digest(readFileSync(new URL(path, import.meta.url))) !== hash)
        throw Error("Frozen input differs: " + path);
    }
    options = manifest.profiles;
  }
  const snapshots = corpus[split].map((id) => history.snapshot(id));
  const scores = Object.entries(options).map(([name, profile]) => {
    const perVersion = snapshots.map((pr) => score(pr, profile));
    const sum = (k: keyof (typeof perVersion)[number]) =>
      perVersion.reduce((acc, row) => acc + row[k], 0);
    return {
      name,
      found: sum("found"),
      missed: sum("missed"),
      wrong: sum("wrong"),
      duplicates: sum("duplicates"),
      calls: sum("calls"),
      apiCost: 0,
      localMs: Number(sum("localMs").toFixed(3)),
    };
  });
  return { split, versions: corpus[split], lock, scores };
}
function select(name: string) {
  if (!Object.hasOwn(profiles, name)) throw Error("Unknown profile " + name);
  return profiles[name];
}
function threadFindings(pr: Snapshot) {
  return distinct(review(pr, profiles.linked).published.filter((f) => f.kind !== "style"));
}
function update(history: History, previous: string, next: string, current: string) {
  const old = history.snapshot(previous);
  history.git("merge-base", "--is-ancestor", old.head, corpus.revisions[next].head);
  const latest = history.snapshot(next, old.head);
  const before = threadFindings(old);
  const after = threadFindings(latest);
  const same = (a: Finding, b: Finding) => a.kind === b.kind && a.path === b.path;
  const updates = before.map((f) => {
    const now = after.find((other) => same(other, f));
    return {
      kind: f.kind,
      path: f.path,
      oldLine: f.line,
      line: now?.line,
      action: now ? "update-thread" : "resolve",
    };
  });
  for (const f of after.filter((item) => !before.some((oldFinding) => same(item, oldFinding))))
    updates.push({ kind: f.kind, path: f.path, line: f.line, oldLine: f.line, action: "create" });
  const accepted = latest.head === corpus.revisions[current]?.head;
  return {
    previous: old.head,
    checked: latest.head,
    current: corpus.revisions[current]?.head,
    changed: latest.changed,
    incremental: after,
    full: threadFindings(history.snapshot(next)),
    status: accepted ? "published" : "stale",
    updates: accepted ? updates : [],
  };
}
function feedback(history: History) {
  const discussions =
    data<{ speaker: string; text: string; outcome?: string }[]>("discussions.json");
  const rejection = discussions.find((d) => d.outcome === "rejected");
  if (!rejection?.text.includes("только во внешнем экспорте"))
    throw Error("No scoped exception in discussions");
  const candidate = { path: "exports/internal.ts", kind: "limit", reason: rejection.text };
  const trials = corpus.transfer.map((id) => {
    const pr = history.snapshot(id);
    const baseline = review(pr, profiles.baseline).published;
    const scoped = review(pr, profiles.baseline, (packet) =>
      execute(packet).filter((f) => f.path !== candidate.path || f.kind !== candidate.kind),
    ).published;
    const broad = review(pr, profiles.baseline, (packet) =>
      execute(packet).filter((f) => f.kind !== candidate.kind),
    ).published;
    return { id, expected: labels[id], baseline, scoped, broad };
  });
  return { discussions, candidate, trials };
}
const [cmd, ...args] = process.argv.slice(2);
const history = new History();
try {
  let result: unknown;
  switch (cmd) {
    case "review": {
      const [id, name = "baseline"] = args;
      const pr = history.snapshot(id);
      result = {
        event: "/review",
        mergeBase: pr.mergeBase,
        head: pr.head,
        diff: pr.diff,
        ...review(pr, select(name)),
      };
      break;
    }
    case "compare":
      result = compare(history, args[0]);
      break;
    case "update":
      result = update(history, args[0], args[1], args[2] ?? args[1]);
      break;
    case "feedback":
      result = feedback(history);
      break;
    default:
      throw Error(
        "Commands: review <version> <profile>, compare work|holdout, update <previous> <next> [current], feedback",
      );
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  history.close();
}
