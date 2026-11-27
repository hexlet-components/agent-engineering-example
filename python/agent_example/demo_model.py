"""Prepared model responses; all tool work is performed by the real Runner."""

import json
from collections.abc import AsyncIterator
from typing import Any

from agents import Model, ModelResponse, Usage
from openai.types.responses import (
    ResponseFunctionToolCall,
    ResponseOutputMessage,
    ResponseOutputText,
)
from openai.types.responses.response_stream_event import ResponseStreamEvent


class DemoModel(Model):
    def __init__(self, steps: list[dict[str, Any]]) -> None:
        self.steps = iter(steps)
        self.turn = 0

    async def get_response(self, *args: Any, **kwargs: Any) -> ModelResponse:
        step = next(self.steps)
        self.turn += 1
        if "name" in step:
            call = ResponseFunctionToolCall(
                type="function_call",
                call_id=f"demo-{self.turn}",
                name=step["name"],
                arguments=json.dumps(step["arguments"]),
                status="completed",
            )
            return ModelResponse(output=[call], usage=Usage(), response_id=None)
        return ModelResponse(
            output=[
                ResponseOutputMessage(
                    id="demo-final",
                    type="message",
                    role="assistant",
                    status="completed",
                    content=[
                        ResponseOutputText(
                            type="output_text", text=json.dumps(step), annotations=[]
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
