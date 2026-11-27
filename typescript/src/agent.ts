import {
  Agent,
  Runner,
  OpenAIProvider,
  MCPServerStdio,
  tool,
  type AgentInputItem,
  type Tool,
} from "@openai/agents";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Workspace, reportSchema, fixture, type Case } from "./workspace.ts";
import { demoModel } from "./demo-model.ts";

async function liveModel() {
  if (!process.env.MODEL_ID) throw new Error("MODEL_ID_REQUIRED");
  const key = process.env.MODEL_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!key) throw new Error("MODEL_API_KEY_REQUIRED");
  return new OpenAIProvider({
    apiKey: key,
    baseURL: process.env.MODEL_BASE_URL,
    useResponses: process.env.MODEL_API !== "chat_completions",
  }).getModel(process.env.MODEL_ID);
}
function decode(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return decode(JSON.parse(value));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value) && value.length === 1) return decode(value[0]);
  if (
    value &&
    typeof value === "object" &&
    "text" in value &&
    "type" in value &&
    value.type === "text"
  )
    return decode(value.text);
  return value;
}

async function runCase(scenario: string, runCaseData: Case, demo: boolean, prompt: string) {
  const work = new Workspace(runCaseData);
  const tools: Tool[] = [
    tool({
      name: "read_ticket",
      description: "Read one ticket by ID. Returns found with a ticket or empty.",
      parameters: z.object({ ticket_id: z.string() }),
      execute: ({ ticket_id }) => JSON.stringify(work.readTicket(ticket_id)),
    }),
  ];
  if (["tool-contracts", "source-discovery"].includes(scenario))
    tools.push(
      tool({
        name: "search_tickets",
        description:
          "Search ticket text. found includes IDs, empty means no match, unavailable means tracker failure.",
        parameters: z.object({ query: z.string() }),
        execute: ({ query }) => JSON.stringify(work.searchTickets(query)),
      }),
    );
  if (scenario === "trust-boundaries")
    tools.push(
      tool({
        name: "set_label",
        description: "Request a needs-info label. The application can deny the change.",
        parameters: z.object({ ticket_id: z.string(), label: z.string() }),
        execute: ({ ticket_id, label }) => JSON.stringify(work.setLabel(ticket_id, label)),
      }),
    );
  const trace: Record<string, unknown>[] = [];
  const decisions = [];
  const reads = new Set<string>();
  const server =
    scenario === "mcp"
      ? new MCPServerStdio({
          name: "training-tracker",
          command: "uv",
          args: [
            "run",
            "--project",
            "python",
            "--no-sync",
            "python",
            "-m",
            "agent_example.tracker_server",
          ],
          cacheToolsList: true,
          clientSessionTimeoutSeconds: 30,
        })
      : undefined;
  try {
    if (server) {
      await server.connect();
      trace.push({ type: "tools/list", tools: await server.listTools() });
    }
    const agent = new Agent({
      name: "Ticket triage",
      model: demo ? demoModel(runCaseData.steps) : await liveModel(),
      instructions: await readFile(
        new URL("../../fixture/instructions.txt", import.meta.url),
        "utf8",
      ),
      tools: server ? [] : tools,
      mcpServers: server ? [server] : [],
      outputType: reportSchema,
    });
    let history: string | AgentInputItem[] = prompt;
    const runner = new Runner({ tracingDisabled: true });
    const runAttempt = (input: string | AgentInputItem[]) =>
      runner.run(agent, input, { maxTurns: 8, signal: AbortSignal.timeout(60000) });
    for (let attempt = 1; attempt <= 2; attempt++) {
      const run: Awaited<ReturnType<typeof runAttempt>> = await runAttempt(history);
      const calls = new Map<string, string>();
      for (const item of run.newItems) {
        if (item.type === "tool_call_item" && item.rawItem.type === "function_call") {
          const raw = item.rawItem;
          calls.set(raw.callId, raw.name);
          trace.push({
            type: "call",
            call_id: raw.callId,
            name: raw.name,
            arguments: JSON.parse(raw.arguments),
          });
        } else if (
          item.type === "tool_call_output_item" &&
          item.rawItem.type === "function_call_result"
        ) {
          const id = item.rawItem.callId;
          const output = decode(item.output);
          trace.push({ type: "result", call_id: id, output });
          const ticket = z.object({ ticket: z.object({ id: z.string() }) }).safeParse(output);
          if (calls.get(id) === "read_ticket" && ticket.success) reads.add(ticket.data.ticket.id);
        }
      }
      const report = reportSchema.parse(run.finalOutput);
      const issues: string[] = [];
      if (!report.reason.trim()) issues.push("Объясни предложенный шаг.");
      if (!report.sources.includes("T-42")) issues.push("Укажи исходный тикет T-42.");
      for (const source of new Set(report.sources.filter((id) => !reads.has(id)))) {
        issues.push(`Прочитай тикет ${source} перед ссылкой на него.`);
      }
      const decision = issues.length === 0 ? "accepted" : attempt === 1 ? "retry" : "exhausted";
      decisions.push({ decision, issues, report });
      if (decision !== "retry") break;
      history = [
        ...run.history,
        {
          role: "user",
          content: issues.join(" "),
        },
      ];
    }
  } finally {
    if (server) await server.close();
  }
  return { case: runCaseData.name, trace, decisions, labels: work.labels };
}

const stateSchema = z.object({
  status: z.string(),
  ticket_id: z.string(),
  request_id: z.string(),
  reason: z.string(),
});
export async function resume(
  path: string,
  reply: { ticket_id: string; request_id: string; text: string },
) {
  const state = stateSchema.parse(JSON.parse(await readFile(path, "utf8")));
  if (
    state.status !== "waiting" ||
    state.ticket_id !== reply.ticket_id ||
    state.request_id !== reply.request_id
  )
    throw new Error("Ответ относится к другой задаче или запрос уже обработан");
  const resumed = { ...state, status: "resumed", reply: reply.text };
  await writeFile(path, JSON.stringify(resumed));
  return {
    resumed,
    prompt: `Продолжи разбор ${state.ticket_id}. Ответ на вопрос ${state.reason}: ${reply.text}`,
  };
}

export async function investigate({ scenario = "agent-loop", demo = true } = {}) {
  const scenarios = fixture("scenarios") as Record<string, Case[]>;
  if (!Object.hasOwn(scenarios, scenario)) throw new Error("Неизвестный сценарий");
  const runs = [];
  let prompt = "Предложи следующий шаг для T-42.";
  const details: Record<string, unknown> = {};
  if (scenario === "context-budget") {
    const discussion = z
      .array(z.object({ id: z.string(), text: z.string() }))
      .parse(fixture("discussion"));
    const next_input = {
      ticket_id: "T-42",
      evidence: discussion.filter((item) => ["C-6", "C-8"].includes(item.id)),
    };
    details.context = { discussion, next_input };
    prompt += JSON.stringify(next_input);
  }
  const folder = await mkdtemp(join(tmpdir(), "ticket-triage-"));
  const checkpoint = join(folder, "task.json");
  try {
    for (const scenarioCase of scenarios[scenario]) {
      let runCaseData = scenarioCase;
      if (scenario === "task-state" && runCaseData.name === "reply") {
        if (!details.paused) break;
        const reply = await resume(checkpoint, {
          ticket_id: "T-42",
          request_id: "Q-42",
          text: "Да, был включён фильтр даты.",
        });
        details.resumed = reply.resumed;
        prompt = reply.prompt;
        runCaseData = { ...scenarioCase, reply: reply.resumed.reply };
      }
      const run = await runCase(scenario, runCaseData, demo, prompt);
      runs.push(run);
      const final = run.decisions.at(-1);
      if (
        scenario === "task-state" &&
        runCaseData.name === "incomplete" &&
        final?.decision === "accepted" &&
        final.report.action === "ask_author"
      ) {
        details.paused = {
          ticket_id: "T-42",
          status: "waiting",
          reason: final.report.reason,
          request_id: "Q-42",
        };
        await writeFile(checkpoint, JSON.stringify(details.paused));
      }
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  return { scenario, mode: demo ? "demo" : "live", runs, ...details };
}
