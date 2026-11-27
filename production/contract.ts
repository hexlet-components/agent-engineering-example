export type Ticket = { id: string; version: number; text: string };
export type Input = { ticket: Ticket; policy: string; publish: boolean };
export type Draft = { kind: "question" | "recommendation"; text: string };
export type Approval = { text: string; version: number; approved: boolean };
export type Reply = { commentId: string; text: string; author: string };
export const queue = "triage";
export const workflowId = (id: string, version = 1) => `triage-${id}-v${version}`;
