import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "./activities";
import type { Input, Approval, Reply, Draft } from "./contract";
import { checkDraft } from "./check";

const { runAgent, publishQuestion } = proxyActivities<typeof activities>({
  startToCloseTimeout: "15 seconds",
  retry: { maximumAttempts: 3, initialInterval: "1 second" },
});
const decision = defineSignal<[Approval]>("decision");
const authorReply = defineSignal<[Reply]>("authorReply");
export async function triage(input: Input) {
  let stage = "analysis";
  let draft: Draft | undefined;
  let approval: Approval | undefined;
  let commentId: string | undefined;
  let reply: Reply | undefined;
  const replies: Reply[] = [];
  setHandler(defineQuery("status"), () => ({ stage, draft, commentId, ...input }));
  setHandler(decision, (decision) => {
    if (
      stage === "approval" &&
      !approval &&
      decision.version === input.ticket.version &&
      decision.text === draft?.text
    )
      approval = decision;
  });
  setHandler(authorReply, (message) => {
    if (message.author === "author" && message.text.trim()) replies.push(message);
  });
  async function propose(context?: { question: string; answer: string }) {
    let feedback = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await runAgent(input, feedback, context);
      feedback = checkDraft(result, !!context);
      if (!feedback) return result;
    }
  }
  draft = await propose();
  if (!draft) return { stage: "handoff", reason: "validation" };
  if (draft.kind === "recommendation" || !input.publish)
    return { stage: "completed", draft, policy: input.policy };
  stage = "approval";
  await condition(() => approval !== undefined);
  if (!approval!.approved) return { stage: "declined" };
  stage = "publication";
  try {
    commentId = await publishQuestion(
      input.ticket,
      draft.text,
      workflowInfo().workflowId + "/question",
    );
  } catch {
    return { stage: "handoff", reason: "publication", draft };
  }
  stage = "reply";
  await condition(() => replies.some((message) => message.commentId === commentId));
  reply = replies.find((message) => message.commentId === commentId)!;
  stage = "analysis";
  draft = await propose({ question: draft.text, answer: reply.text });
  return draft
    ? { stage: "completed", draft, policy: input.policy }
    : { stage: "handoff", reason: "validation" };
}
