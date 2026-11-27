import { readFileSync } from "node:fs";
import { triage } from "./agent.ts";

export default class Provider {
  constructor(options) {
    this.mode = options.config.mode;
  }
  id() {
    return "triage:" + this.mode;
  }
  async callApi(prompt, context) {
    if (this.mode === "recorded")
      return {
        output: JSON.parse(readFileSync(new URL("incident.json", import.meta.url), "utf8")),
      };
    if (this.mode === "sample") return { output: context.vars.sample };
    if (this.mode === "replay") {
      const report = JSON.parse(readFileSync(new URL("var/first.json", import.meta.url), "utf8"));
      const row = report.results.results.find((row) => row.vars.id === context.vars.id);
      if (!row?.response?.output) throw new Error("Run npm run first for this ticket");
      return { output: row.response.output };
    }
    return { output: await triage(context.vars.id, this.mode) };
  }
}
