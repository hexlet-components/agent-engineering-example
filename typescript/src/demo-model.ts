import { Usage, type Model } from "@openai/agents";
import type { Step } from "./workspace.ts";

export function demoModel(steps: Step[]): Model {
  let turn = 0;
  return {
    async getResponse() {
      const step = steps[turn++];
      if (!step) throw new Error("Script exhausted");
      return {
        usage: new Usage(),
        output:
          "name" in step
            ? [
                {
                  type: "function_call",
                  callId: `demo-${turn}`,
                  name: step.name,
                  arguments: JSON.stringify(step.arguments),
                  status: "completed",
                },
              ]
            : [
                {
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: JSON.stringify(step) }],
                },
              ],
      };
    },
    getStreamedResponse() {
      throw new Error("STREAMING_NOT_USED");
    },
  };
}
