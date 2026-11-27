import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
export function data<T>(name: string): T {
  return JSON.parse(readFileSync(new URL("./data/" + name, import.meta.url), "utf8")) as T;
}
type Revision = { path: string; head: string };
export const corpus = data<{
  base: string;
  work: string[];
  transfer: string[];
  holdout: string[];
  revisions: Record<string, Revision>;
}>("revisions.json");

export class History {
  directory = mkdtempSync(join(tmpdir(), "order-history-"));
  constructor() {
    try {
      this.git("init", "-q", "--bare");
      execFileSync("git", ["fast-import", "--quiet"], {
        cwd: this.directory,
        input: readFileSync(new URL("./data/history.fi", import.meta.url)),
      });
    } catch (error) {
      this.close();
      throw error;
    }
  }
  git(...args: string[]) {
    return execFileSync("git", args, { cwd: this.directory, encoding: "utf8" });
  }
  snapshot(id: string, since?: string) {
    const ref = corpus.revisions[id];
    if (!ref) throw Error("Unknown PR version " + id);
    const mergeBase = this.git("merge-base", corpus.base, ref.head).trim();
    const from = since ?? mergeBase;
    const changed = this.git("diff", "--name-only", from, ref.head)
      .trim()
      .split("\n")
      .filter(Boolean);
    const paths = this.git("ls-tree", "-r", "--name-only", ref.head).trim().split("\n");
    const files = Object.fromEntries(paths.map((p) => [p, this.git("show", ref.head + ":" + p)]));
    return {
      id,
      path: ref.path,
      head: ref.head,
      mergeBase,
      from,
      diff: this.git("diff", from, ref.head),
      changed,
      files,
    };
  }
  close() {
    rmSync(this.directory, { recursive: true, force: true });
  }
}
export type Snapshot = ReturnType<History["snapshot"]>;
