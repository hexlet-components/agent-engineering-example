import type { Draft } from "./contract";
export function checkDraft(draft: Draft, afterReply = false): string {
  if (!draft.text.trim()) return "Заполните текст следующего шага";
  if (afterReply && draft.kind !== "recommendation") return "После ответа требуется рекомендация";
  if (draft.kind === "question" && !draft.text.trimEnd().endsWith("?"))
    return "Уточнение должно содержать вопрос";
  return "";
}
