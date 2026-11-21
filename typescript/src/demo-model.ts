import { Usage, type Model, type ModelResponse } from "@openai/agents";

export const demoReport = {
  findings: [
    {
      path: "src/pricing/discount.ts",
      line: 9,
      message:
        "Код скидки попадает в SQL через подстановку. Значение приходит из параметра запроса, поэтому код с апострофом ломает запрос. Фиксированная проверка воспроизводит отказ.",
      evidence: [
        { path: "src/pricing/discount.ts", from: 9, to: 10 },
        { path: "src/orders/checkout.ts", from: 3, to: 5 },
      ],
    },
  ],
};
export function demoModel(): Model {
  let turn = 0;
  const calls = [
    [
      { name: "read_diff", arguments: {} },
      { name: "search_files", arguments: { pattern: "applyDiscount" } },
    ],
    [
      { name: "read_file", arguments: { path: "src/pricing/discount.ts", offset: 0, limit: 40 } },
      { name: "read_file", arguments: { path: "src/orders/checkout.ts", offset: 0, limit: 40 } },
    ],
    [{ name: "run_check", arguments: {} }],
  ];
  return {
    async getResponse(): Promise<ModelResponse> {
      const index = turn++;
      return {
        usage: new Usage(),
        output:
          index < calls.length
            ? calls[index].map((call, order) => ({
                type: "function_call",
                callId: `demo-${index}-${order}`,
                name: call.name,
                arguments: JSON.stringify(call.arguments),
                status: "completed",
              }))
            : [
                {
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: JSON.stringify(demoReport) }],
                },
              ],
      };
    },
    getStreamedResponse() {
      throw new Error("STREAMING_NOT_USED");
    },
  };
}
