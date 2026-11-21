import { readFile, readdir, realpath } from "node:fs/promises";
import { resolve, sep, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export type Citation = { path: string; from: number; to: number };
export type Trace = { name: string; arguments: Record<string, unknown>; result: unknown };
export class Workspace {
  readonly trace: Trace[] = [];
  readonly reads: Citation[] = [];
  readonly root: string;
  check: { passed: boolean; exitCode: number; output: string } | undefined;
  readonly maxCalls: number;
  constructor(root = resolve(import.meta.dirname, "../../fixture"), maxCalls = 16) {
    this.maxCalls = maxCalls;
    this.root = root;
  }
  async files(): Promise<string[]> {
    const visit = async (directory: string): Promise<string[]> => {
      const result: string[] = [];
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) result.push(...(await visit(path)));
        else if (/\.(ts|txt|diff)$/.test(entry.name)) result.push(relative(this.root, path));
      }
      return result;
    };
    return (await visit(this.root)).sort();
  }
  async path(name: string): Promise<string> {
    if (name.includes("\\") || name.split("/").some((part) => part.startsWith(".") || !part))
      throw new Error("PATH_DENIED");
    const root = await realpath(this.root);
    const path = await realpath(resolve(root, name));
    if (!path.startsWith(root + sep) || !(await this.files()).includes(name))
      throw new Error("PATH_DENIED");
    return path;
  }
  async invoke(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (this.trace.length >= this.maxCalls) throw new Error("TOOL_BUDGET");
    let result: unknown;
    let read: Citation | undefined;
    if (name === "list_files") result = await this.files();
    else if (name === "read_file" || name === "read_diff") {
      const path = name === "read_diff" ? "change.diff" : String(args.path);
      const offset = Number(args.offset ?? 0),
        limit = Number(args.limit ?? 40);
      if (
        !Number.isInteger(offset) ||
        offset < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 40
      )
        throw new Error("LINE_LIMIT");
      const lines = (await readFile(await this.path(path), "utf8"))
        .trimEnd()
        .split("\n")
        .slice(offset, offset + limit);
      const citation = { path, from: offset + 1, to: offset + lines.length };
      if (lines.length) read = citation;
      result = { ...citation, lines };
    } else if (name === "search_files") {
      const pattern = String(args.pattern ?? "");
      if (!pattern || pattern.length > 80) throw new Error("SEARCH_LIMIT");
      const matches: { path: string; line: number; text: string }[] = [];
      for (const path of await this.files()) {
        if (!path.startsWith("src/") && !path.startsWith("test/")) continue;
        const lines = (await readFile(await this.path(path), "utf8")).split("\n");
        for (let index = 0; index < lines.length; index++)
          if (lines[index].includes(pattern))
            matches.push({ path, line: index + 1, text: lines[index] });
      }
      result = { matches: matches.slice(0, 20), truncated: matches.length > 20 };
    } else if (name === "run_check") {
      let output: string,
        exitCode = 0;
      try {
        const child = await execute(process.execPath, ["--test", "test/discount.test.ts"], {
          cwd: this.root,
          timeout: 10000,
          maxBuffer: 32000,
          env: { PATH: process.env.PATH, LANG: "C.UTF-8", NODE_NO_WARNINGS: "1" },
        });
        output = child.stdout + child.stderr;
      } catch (error) {
        const child = error as { code?: unknown; stdout?: string; stderr?: string };
        if (typeof child.code !== "number") throw new Error("CHECK_RUNTIME_ERROR");
        exitCode = child.code;
        output = (child.stdout ?? "") + (child.stderr ?? "");
      }
      result = this.check = { passed: exitCode === 0, exitCode, output: output.slice(-6000) };
    } else throw new Error("TOOL_DENIED");
    if (JSON.stringify(result).length > 8000) throw new Error("OUTPUT_LIMIT");
    if (read) this.reads.push(read);
    this.trace.push({ name, arguments: args, result });
    return result;
  }
  validate(report: { findings: { path: string; line: number; evidence: Citation[] }[] }) {
    if (!this.check) throw new Error("CHECK_REQUIRED");
    if (!report.findings.length && !this.check.passed) throw new Error("UNEXPLAINED_CHECK_FAILURE");
    for (const finding of report.findings) {
      const refs = [
        ...finding.evidence,
        { path: finding.path, from: finding.line, to: finding.line },
      ];
      for (const ref of refs)
        if (
          !this.reads.some(
            (read) =>
              read.path === ref.path &&
              read.from <= ref.from &&
              read.to >= ref.to &&
              ref.from <= ref.to,
          )
        )
          throw new Error("UNREAD_EVIDENCE");
    }
  }
}
