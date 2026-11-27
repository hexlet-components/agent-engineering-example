import asyncio
import json
import os
import sys
from contextlib import AsyncExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, cast

from agents import (
    Agent,
    OpenAIChatCompletionsModel,
    OpenAIResponsesModel,
    RunConfig,
    Runner,
    function_tool,
)
from agents.items import TResponseInputItem
from agents.mcp import MCPServerStdio
from openai import AsyncOpenAI

from .demo_model import DemoModel
from .workspace import FIXTURE, Report, Workspace, load


def live_model():
    model_id = os.environ["MODEL_ID"]
    client = AsyncOpenAI(
        api_key=os.environ.get("MODEL_API_KEY") or os.environ["OPENAI_API_KEY"],
        base_url=os.environ.get("MODEL_BASE_URL"),
    )
    cls = (
        OpenAIChatCompletionsModel
        if os.environ.get("MODEL_API") == "chat_completions"
        else OpenAIResponsesModel
    )
    return cls(model=model_id, openai_client=client)


def decode(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return decode(json.loads(value))
        except ValueError:
            return value
    if isinstance(value, list) and len(value) == 1:
        return decode(value[0])
    if isinstance(value, dict) and "text" in value and value.get("type") == "text":
        return decode(value["text"])
    return value


def context_for_turn() -> dict:
    discussion = load("discussion")
    kept = [item for item in discussion if item["id"] in {"C-6", "C-8"}]
    return {"discussion": discussion, "next_input": {"ticket_id": "T-42", "evidence": kept}}


async def run_case(scenario: str, case: dict, demo: bool, prompt: str) -> dict:
    work = Workspace(case)

    @function_tool
    def read_ticket(ticket_id: str) -> str:
        """Read one ticket by ID. Returns found with a ticket or empty."""
        return json.dumps(work.read_ticket(ticket_id), ensure_ascii=False)

    @function_tool
    def search_tickets(query: str) -> str:
        """Search ticket text. found includes IDs, empty means no match, unavailable means tracker failure."""
        return json.dumps(work.search_tickets(query), ensure_ascii=False)

    @function_tool
    def set_label(ticket_id: str, label: str) -> str:
        """Request a needs-info label. The application can deny the change."""
        return json.dumps(work.set_label(ticket_id, label), ensure_ascii=False)

    tools = [read_ticket]
    if scenario in {"tool-contracts", "source-discovery"}:
        tools.append(search_tickets)
    if scenario == "trust-boundaries":
        tools.append(set_label)
    trace: list[dict] = []
    decisions = []
    reads = set()
    async with AsyncExitStack() as stack:
        servers = []
        if scenario == "mcp":
            server = await stack.enter_async_context(
                MCPServerStdio(
                    params={
                        "command": sys.executable,
                        "args": ["-m", "agent_example.tracker_server"],
                    },
                    name="training-tracker",
                    cache_tools_list=True,
                    client_session_timeout_seconds=30,
                )
            )
            descriptions = await server.list_tools()
            trace.append(
                {
                    "type": "tools/list",
                    "tools": [t.model_dump(by_alias=True, exclude_none=True) for t in descriptions],
                }
            )
            tools = []
            servers.append(server)
        agent = Agent(
            name="Ticket triage",
            model=DemoModel(case["steps"]) if demo else live_model(),
            instructions=(FIXTURE / "instructions.txt").read_text(),
            tools=list(tools),
            mcp_servers=list(servers),
            output_type=Report,
        )
        history: str | list[TResponseInputItem] = prompt
        for attempt in range(1, 3):
            run = await Runner.run(
                agent, history, max_turns=8, run_config=RunConfig(tracing_disabled=True)
            )
            calls = {}
            for item in run.new_items:
                if item.type == "tool_call_item":
                    raw = cast(Any, item.raw_item)
                    calls[raw.call_id] = raw.name
                    trace.append(
                        {
                            "type": "call",
                            "call_id": raw.call_id,
                            "name": raw.name,
                            "arguments": json.loads(raw.arguments),
                        }
                    )
                elif item.type == "tool_call_output_item":
                    call_id = cast(Any, item.raw_item)["call_id"]
                    output = decode(item.output)
                    trace.append({"type": "result", "call_id": call_id, "output": output})
                    if (
                        calls.get(call_id) == "read_ticket"
                        and isinstance(output, dict)
                        and output.get("ticket")
                    ):
                        reads.add(output["ticket"]["id"])
            report = cast(Report, run.final_output)
            issues = []
            if not report.reason.strip():
                issues.append("Объясни предложенный шаг.")
            if "T-42" not in report.sources:
                issues.append("Укажи исходный тикет T-42.")
            for source in sorted(set(report.sources) - reads):
                issues.append(f"Прочитай тикет {source} перед ссылкой на него.")
            decision = "accepted" if not issues else "retry" if attempt == 1 else "exhausted"
            decisions.append(
                {"decision": decision, "issues": issues, "report": report.model_dump()}
            )
            if decision != "retry":
                break
            history = [
                *run.to_input_list(),
                {
                    "role": "user",
                    "content": " ".join(issues),
                },
            ]
    return {"case": case["name"], "trace": trace, "decisions": decisions, "labels": work.labels}


def resume(path: Path, reply: dict) -> str:
    state = json.loads(path.read_text())
    if (
        state["status"] != "waiting"
        or state["request_id"] != reply["request_id"]
        or state["ticket_id"] != reply["ticket_id"]
    ):
        raise ValueError("Ответ относится к другой задаче или запрос уже обработан")
    state.update(status="resumed", reply=reply["text"])
    path.write_text(json.dumps(state, ensure_ascii=False))
    return (
        f"Продолжи разбор {state['ticket_id']}. Ответ на вопрос {state['reason']}: {state['reply']}"
    )


async def investigate(*, scenario: str = "agent-loop", demo: bool = True) -> dict:
    cases = load("scenarios")[scenario]
    prompt = "Предложи следующий шаг для T-42."
    result: dict[str, Any] = {"scenario": scenario, "mode": "demo" if demo else "live", "runs": []}
    if scenario == "context-budget":
        result["context"] = context_for_turn()
        prompt += json.dumps(result["context"]["next_input"], ensure_ascii=False)
    async with asyncio.timeout(120):
        with TemporaryDirectory() as folder:
            checkpoint = Path(folder) / "task.json"
            for case in cases:
                if scenario == "task-state" and case["name"] == "reply":
                    if not checkpoint.exists():
                        break
                    prompt = resume(
                        checkpoint,
                        {
                            "ticket_id": "T-42",
                            "request_id": "Q-42",
                            "text": "Да, был включён фильтр даты.",
                        },
                    )
                    result["resumed"] = json.loads(checkpoint.read_text())
                    case = {**case, "reply": result["resumed"]["reply"]}
                run = await run_case(scenario, case, demo, prompt)
                result["runs"].append(run)
                final = run["decisions"][-1]
                if (
                    scenario == "task-state"
                    and case["name"] == "incomplete"
                    and final["decision"] == "accepted"
                    and final["report"]["action"] == "ask_author"
                ):
                    state = {
                        "ticket_id": "T-42",
                        "status": "waiting",
                        "reason": final["report"]["reason"],
                        "request_id": "Q-42",
                    }
                    checkpoint.write_text(json.dumps(state, ensure_ascii=False))
                    result["paused"] = state
    return result
