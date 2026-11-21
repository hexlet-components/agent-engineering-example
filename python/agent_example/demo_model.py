"""Prepared model responses; all tool work is performed by the real Runner."""

import json
from collections.abc import AsyncIterator
from typing import Any

from agents import Model, ModelResponse, Usage
from agents.items import TResponseOutputItem
from openai.types.responses import (
    ResponseFunctionToolCall,
    ResponseOutputMessage,
    ResponseOutputText,
)
from openai.types.responses.response_stream_event import ResponseStreamEvent

DEMO_REPORT = {
    "findings": [
        {
            "path": "src/pricing/discount.ts",
            "line": 9,
            "message": "Код скидки попадает в SQL через подстановку. Значение приходит из параметра запроса, поэтому код с апострофом ломает запрос. Фиксированная проверка воспроизводит отказ.",
            "evidence": [
                {"path": "src/pricing/discount.ts", "from": 9, "to": 10},
                {"path": "src/orders/checkout.ts", "from": 3, "to": 5},
            ],
        }
    ]
}


class DemoModel(Model):
    def __init__(self) -> None:
        self.turn = 0

    async def get_response(self, *args: Any, **kwargs: Any) -> ModelResponse:
        calls = [
            [("read_diff", {}), ("search_files", {"pattern": "applyDiscount"})],
            [
                ("read_file", {"path": "src/pricing/discount.ts", "offset": 0, "limit": 40}),
                ("read_file", {"path": "src/orders/checkout.ts", "offset": 0, "limit": 40}),
            ],
            [("run_check", {})],
        ]
        turn = self.turn
        self.turn += 1
        if turn < len(calls):
            output: list[TResponseOutputItem] = [
                ResponseFunctionToolCall(
                    type="function_call",
                    call_id=f"demo-{turn}-{index}",
                    name=name,
                    arguments=json.dumps(arguments),
                    status="completed",
                )
                for index, (name, arguments) in enumerate(calls[turn])
            ]
            return ModelResponse(output=output, usage=Usage(), response_id=None)
        return ModelResponse(
            output=[
                ResponseOutputMessage(
                    id="demo-final",
                    type="message",
                    role="assistant",
                    status="completed",
                    content=[
                        ResponseOutputText(
                            type="output_text", text=json.dumps(DEMO_REPORT), annotations=[]
                        )
                    ],
                )
            ],
            usage=Usage(),
            response_id=None,
        )

    async def stream_response(
        self, *args: Any, **kwargs: Any
    ) -> AsyncIterator[ResponseStreamEvent]:
        raise NotImplementedError("STREAMING_NOT_USED")
        yield  # This async generator has the interface required by Model.
