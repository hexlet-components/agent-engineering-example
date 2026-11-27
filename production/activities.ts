import { ApplicationFailure } from "@temporalio/activity";
import { analyze } from "./agent";
import type { Input, Ticket } from "./contract";
export async function runAgent(...args: Parameters<typeof analyze>) {
  const draft = await analyze(...args);
  if (process.env.CRASH_AFTER_MODEL === "1") process.exit(23);
  return process.env.BAD_DRAFT === "1" ? { ...draft, text: "" } : draft;
}
export async function publishQuestion(ticket: Ticket, text: string, key: string): Promise<string> {
  const base = "http://127.0.0.1:3030";
  const previous = await fetch(base + "/comments/" + encodeURIComponent(key));
  if (previous.ok) {
    const saved = await previous.json();
    if (saved.text === text && saved.ticket === ticket.id && saved.version === ticket.version)
      return saved.id;
    throw ApplicationFailure.nonRetryable("Ключ занят другим действием");
  }
  if (previous.status !== 404) throw new Error("Недоступна сверка комментария");
  const response = await fetch(base + "/comments", {
    method: "POST",
    headers: { authorization: "Bearer " + (process.env.TRACKER_KEY || "local-demo") },
    body: JSON.stringify({ key, ticket: ticket.id, version: ticket.version, text }),
  });
  if (response.status === 409)
    throw ApplicationFailure.nonRetryable("Тикет или комментарий изменился");
  if (!response.ok) throw new Error("Запись не подтверждена");
  return (await response.json()).id;
}
