import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Workspace } from "./workspace.ts";
import { investigate } from "./agent.ts";

const { values } = parseArgs({
  options: {
    demo: { type: "boolean", default: false },
    output: { type: "string", default: "var/typescript.json" },
  },
});
const work = new Workspace();
let result: unknown;
try {
  result = await investigate({ demo: values.demo, workspace: work });
} catch (error) {
  result = {
    mode: values.demo ? "demo" : "live",
    status: "failed",
    error: error instanceof Error ? error.message : "RUN_FAILED",
    check: work.check,
    trace: work.trace,
  };
  process.exitCode = 1;
}
await mkdir(dirname(values.output), { recursive: true });
await writeFile(values.output, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
