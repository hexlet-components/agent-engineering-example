import { Agent, Runner, tool, Usage, type Model } from "@openai/agents";
import { z } from "zod";
import type { Draft, Input } from "./contract";
import tickets from "./data.json";

type Context = { question: string; answer: string };
const schema = z.object({ kind: z.enum(["question", "recommendation"]), text: z.string() });
const question: Draft = { kind: "question", text: "Если снять фильтр даты, строки появятся?" };
function scripted(input: Input, context?: Context): Model {
  const duplicate =
    (input.policy === "v1" && input.ticket.text.includes("CSV") && input.ticket.id !== "T-42") ||
    ["T-43", "T-45"].includes(input.ticket.id) ||
    !!context?.answer.match(/без фильтра строки есть/i);
  const result = duplicate
    ? { kind: "recommendation", text: "Проверьте связь с известным дефектом T-17." }
    : context || input.ticket.id === "T-44"
      ? { kind: "recommendation", text: "Передайте тикет сотруднику для отдельного разбора." }
      : question;
  let called = false;
  return {
    async getResponse() {
      const output = called
        ? [
            {
              type: "message" as const,
              role: "assistant" as const,
              status: "completed" as const,
              content: [{ type: "output_text" as const, text: JSON.stringify(result) }],
            },
          ]
        : [
            {
              type: "function_call" as const,
              status: "completed" as const,
              callId: "read-1",
              name: "read_ticket",
              arguments: JSON.stringify({ id: "T-17" }),
            },
          ];
      called = true;
      return { usage: new Usage(), output };
    },
    getStreamedResponse() {
      throw new Error("Streaming disabled");
    },
  };
}
export async function analyze(input: Input, feedback: string, context?: Context) {
  const read = tool({
    name: "read_ticket",
    description: "Прочитать входной тикет или известный дефект.",
    parameters: z.object({ id: z.string() }),
    execute: ({ id }) =>
      id === input.ticket.id ? input.ticket.text : id === "T-17" ? tickets[id] : "Недоступно",
  });
  const agent = new Agent({
    name: "Триаж",
    tools: [read],
    outputType: schema,
    model: process.env.OPENAI_MODEL || scripted(input, context),
    instructions:
      "Сопоставь тикет с T-17. Верни рекомендацию или один уточняющий вопрос." +
      (input.policy === "v2" ? " Для дубликата должны совпадать формат, симптом и условия." : ""),
  });
  const run = await new Runner({ tracingDisabled: true }).run(
    agent,
    JSON.stringify({ ticket: input.ticket, feedback, context }),
    { maxTurns: 4 },
  );
  return schema.parse(run.finalOutput);
}
