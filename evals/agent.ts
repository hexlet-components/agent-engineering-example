import { Agent, OpenAIProvider, Runner, tool, Usage, type Model } from "@openai/agents";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { localApiBase, localModelName } from "./local.ts";

const tickets = JSON.parse(readFileSync(new URL("tickets.json", import.meta.url), "utf8"));
const answerSchema = z.object({ duplicate: z.string().nullable(), question: z.string() });

// A scripted SDK model for the two introductory tickets.
function demo(id: string): Model {
  if (!["T-42", "T-43"].includes(id)) throw new Error("Demo supports only first/replay");
  const steps = [
    { name: "read_ticket", args: { id } },
    { name: "read_ticket", args: { id: "T-17" } },
    ...(id === "T-42" ? [{ name: "set_label", args: { label: "needs-info" } }] : []),
  ];
  return {
    async getResponse() {
      const next = steps.shift();
      return {
        usage: new Usage(),
        output: next
          ? [
              {
                type: "function_call",
                status: "completed",
                callId: crypto.randomUUID(),
                name: next.name,
                arguments: JSON.stringify(next.args),
              },
            ]
          : [
              {
                type: "message",
                role: "assistant",
                status: "completed",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      duplicate: id === "T-43" ? "T-17" : null,
                      question: id === "T-42" ? "Если снять фильтр даты, строки появятся?" : "",
                    }),
                  },
                ],
              },
            ],
      };
    },
    getStreamedResponse() {
      throw new Error("Streaming disabled");
    },
  };
}

export async function triage(id: string, version: string) {
  const reference = ["T-71", "T-72", "T-73"].includes(id) ? "T-61" : "T-17";
  if (!(id in tickets) || ["T-17", "T-61"].includes(id)) throw new Error("Unknown task: " + id);
  const labels = new Set<string>();
  const calls: object[] = [];
  const tools = [
    tool({
      name: "read_ticket",
      description: "Прочитать текущий тикет или известный дефект " + reference,
      parameters: z.object({ id: z.string() }),
      execute: ({ id: key }) => {
        const text = [id, reference].includes(key) ? tickets[key] : null;
        calls.push({ name: "read_ticket", id: key, text });
        return text || "Недоступно";
      },
    }),
    tool({
      name: "set_label",
      description: "Добавить метку к текущему тикету.",
      parameters: z.object({ label: z.enum(["needs-info"]) }),
      execute: ({ label }) => {
        labels.add(label);
        calls.push({ name: "set_label", label });
        return "ok";
      },
    }),
  ];
  const backend = process.env.TRIAGE_BACKEND || "openai";
  const modelName = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  if (!["demo", "local", "openai"].includes(backend))
    throw new Error("Unknown backend: " + backend);
  const model =
    backend === "demo"
      ? demo(id)
      : backend === "local"
        ? await new OpenAIProvider({
            apiKey: "local",
            baseURL: localApiBase(),
            useResponses: false,
          }).getModel(localModelName())
        : modelName;
  const agent = new Agent({
    name: "Триаж",
    tools,
    outputType: answerSchema,
    model,
    instructions:
      "Прочитай текущий тикет и известный дефект " +
      reference +
      ". В конце верни только JSON без Markdown, с полями duplicate (ID либо null) и question (строка). При похожих симптомах предложи дубликат. Если нужны сведения, задай конкретный вопрос и поставь метку needs-info. При самостоятельном ясном дефекте верни duplicate=null и пустой question." +
      (version === "candidate"
        ? " Дубликат требует совпадения формата, симптома и условий. Если совпадение неполное, уточни решающий факт."
        : ""),
  });
  const start = performance.now();
  const run = await new Runner({ tracingDisabled: true }).run(agent, "Разбери " + id, {
    maxTurns: 8,
  });
  const usage = run.state.usage;
  const inputRate = process.env.INPUT_USD_PER_M;
  const outputRate = process.env.OUTPUT_USD_PER_M;
  const costUsd =
    backend === "local" || backend === "demo"
      ? 0
      : inputRate && outputRate
        ? (usage.inputTokens * Number(inputRate) + usage.outputTokens * Number(outputRate)) / 1e6
        : null;
  return {
    id,
    version,
    backend,
    model: backend === "openai" ? modelName : backend === "local" ? localModelName() : "script",
    answer: answerSchema.parse(run.finalOutput),
    state: { labels: [...labels] },
    calls,
    costUsd,
    latencyMs: Math.round(performance.now() - start),
  };
}
