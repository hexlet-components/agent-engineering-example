import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const [action, id, ...words] = process.argv.slice(2);
async function post(route: string, data: object) {
  const response = await fetch("http://127.0.0.1:3030/" + route, {
    method: "POST",
    body: JSON.stringify({ id, version: Number(process.env.TICKET_VERSION || 1), ...data }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result;
}
async function main() {
  let text = words.join(" ");
  let commentId;
  if (!/^T-\d+$/.test(id || "")) throw new Error("Укажите номер тикета");
  mkdirSync("var", { recursive: true });
  const receipt = "var/review-" + id + "-" + (process.env.TICKET_VERSION || 1) + ".json";
  if (action === "reply") {
    const { state } = await post("status", {});
    if (state.stage !== "reply" || !text.trim())
      throw new Error("Ожидается опубликованный вопрос и текст ответа");
    commentId = state.commentId;
  }
  if (action === "approve" || action === "reject") {
    const displayed = JSON.parse(readFileSync(receipt, "utf8"));
    text = displayed.text;
  }
  const result = await post(action, {
    text,
    commentId,
    deliveryId: "delivery-" + id + "-" + (process.env.TICKET_VERSION || 1),
  });
  if (action === "status" && result.state.stage === "approval") {
    writeFileSync(receipt, JSON.stringify(result.state.draft));
  }
  console.log(JSON.stringify(result, null, 2));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
