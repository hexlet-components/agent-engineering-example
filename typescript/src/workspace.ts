import { readFileSync } from "node:fs";
import { z } from "zod";

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../fixture/${name}.json`, import.meta.url), "utf8"));
}
export const reportSchema = z.object({
  action: z.enum(["ask_author", "check_export"]),
  reason: z.string(),
  sources: z.array(z.string()),
});
export type Step =
  | { name: string; arguments: Record<string, string> }
  | z.infer<typeof reportSchema>;
export interface Case {
  name: string;
  steps: Step[];
  reply?: string;
  offline?: boolean;
  write_labels?: boolean;
}
export class Workspace {
  readonly tickets = z
    .record(
      z.string(),
      z.object({ id: z.string(), text: z.string(), comments: z.array(z.string()) }),
    )
    .parse(fixture("tickets"));
  readonly labels: Record<string, string> = {};
  readonly options: Case;
  constructor(options: Case) {
    this.options = options;
    if (options.reply) this.tickets["T-42"].comments.push(options.reply);
  }
  readTicket(ticketId: string) {
    const ticket = Object.hasOwn(this.tickets, ticketId) ? this.tickets[ticketId] : undefined;
    return ticket ? { status: "found", ticket } : { status: "empty" };
  }
  searchTickets(query: string) {
    if (this.options.offline) return { status: "unavailable" };
    const ids = Object.values(this.tickets)
      .filter((t) => t.text.toLowerCase().includes(query.toLowerCase()))
      .map((t) => t.id);
    return { status: ids.length ? "found" : "empty", ids };
  }
  setLabel(ticketId: string, label: string) {
    if (!this.options.write_labels) return { status: "denied" };
    if (!Object.hasOwn(this.tickets, ticketId) || label !== "needs-info")
      return { status: "invalid" };
    this.labels[ticketId] = label;
    return { status: "updated", label };
  }
}
