import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { Client, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { queue, workflowId, type Input } from "./contract";
import tickets from "./data.json";

mkdirSync("var", { recursive: true });
const db = new DatabaseSync("var/tracker.sqlite");
db.exec(
  "CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, version INTEGER, text TEXT); CREATE TABLE IF NOT EXISTS comments (key TEXT PRIMARY KEY, id TEXT UNIQUE, ticket TEXT, version INTEGER, text TEXT)",
);
for (const [id, text] of Object.entries(tickets))
  db.prepare("INSERT OR IGNORE INTO tickets VALUES (?, 1, ?)").run(id, text);
const client = new Client();
const readTicket = (id: string) =>
  db.prepare("SELECT * FROM tickets WHERE id=?").get(id) as Input["ticket"] | undefined;
const lookup = (key: string) => db.prepare("SELECT * FROM comments WHERE key=?").get(key);
const percent = Number(process.env.ROLLOUT_PERCENT ?? 100);
if (!Number.isInteger(percent) || percent < 0 || percent > 100)
  throw new Error("Invalid rollout percentage");
createServer(async (req, res) => {
  const send = (status: number, value: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  };
  try {
    const path = decodeURIComponent(req.url || "/");
    if (req.method === "GET" && path.startsWith("/comments/")) {
      const saved = lookup(path.slice(10));
      return send(saved ? 200 : 404, saved || {});
    }
    let body = "";
    for await (const part of req) body += part;
    const data = body ? JSON.parse(body) : {};
    if (req.method === "POST" && path === "/comments") {
      if (req.headers.authorization !== "Bearer " + (process.env.TRACKER_KEY || "local-demo"))
        return send(403, {});
      const { key, ticket, version, text } = data;
      if (version !== readTicket(ticket)?.version) return send(409, {});
      const prior = lookup(key);
      if (prior && (prior.ticket !== ticket || prior.version !== version || prior.text !== text))
        return send(409, {});
      if (!prior) {
        db.prepare("INSERT INTO comments VALUES (?,?,?,?,?)").run(
          key,
          crypto.randomUUID(),
          ticket,
          version,
          text,
        );
        if (process.env.LOSE_REPLY === "1") return res.destroy();
      }
      return send(200, lookup(key));
    }
    const ticket = readTicket(data.id || "");
    if (!ticket || req.method !== "POST") return send(404, { error: "Unknown ticket or route" });
    const version = data.version ?? ticket.version;
    const id = workflowId(ticket.id, version);
    const handle = client.workflow.getHandle(id);
    if (path === "/deliver") {
      if (version !== ticket.version) return send(409, { error: "Unknown revision" });
      const bucket = createHash("sha256").update(ticket.id).digest().readUInt32BE(0) % 100;
      const input: Input = {
        ticket,
        policy: process.env.POLICY_VERSION || "v1",
        publish: bucket < percent,
      };
      try {
        await client.workflow.start("triage", {
          workflowId: id,
          taskQueue: queue,
          workflowIdReusePolicy: "REJECT_DUPLICATE",
          args: [input],
        });
      } catch (err) {
        if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
      }
      return send(200, { workflowId: id, deliveryId: data.deliveryId });
    }
    if (path === "/revise") {
      db.prepare("UPDATE tickets SET text=?, version=version+1 WHERE id=?").run(
        data.text,
        ticket.id,
      );
      return send(200, readTicket(ticket.id));
    }
    if (path === "/status") {
      const description = await handle.describe();
      const state =
        description.status.name === "RUNNING"
          ? await handle.query("status")
          : await handle.result();
      return send(200, { workflowId: id, state });
    }
    if (path === "/approve" || path === "/reject") {
      await handle.signal("decision", { text: data.text, version, approved: path === "/approve" });
    } else if (path === "/reply") {
      await handle.signal("authorReply", {
        author: "author",
        commentId: data.commentId,
        text: data.text,
      });
    } else return send(404, {});
    send(202, { workflowId: id });
  } catch (error) {
    send(400, { error: String(error) });
  }
}).listen(3030, "127.0.0.1", () => console.log("Tracker http://127.0.0.1:3030"));
