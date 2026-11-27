import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { investigate } from "./agent.ts";

const { values } = parseArgs({
  options: {
    demo: { type: "boolean", default: false },
    scenario: { type: "string", default: "agent-loop" },
    output: { type: "string", default: "var/typescript.json" },
  },
});
const result = await investigate({ demo: values.demo, scenario: values.scenario });
const json = JSON.stringify(result, null, 2) + "\n";
await mkdir(dirname(values.output), { recursive: true });
await writeFile(values.output, json);
process.stdout.write(json);
