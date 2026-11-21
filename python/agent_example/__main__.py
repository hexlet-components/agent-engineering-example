import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from agents.exceptions import AgentsException
from openai import OpenAIError

from .agent import investigate
from .workspace import Workspace

parser = argparse.ArgumentParser()
parser.add_argument("--demo", action="store_true")
parser.add_argument("--output", default="var/python.json")
args = parser.parse_args()
work = Workspace()
result: dict[str, Any]
try:
    result = asyncio.run(investigate(demo=args.demo, workspace=work))
except (ValueError, OSError, TimeoutError, AgentsException, OpenAIError) as error:
    result = {
        "mode": "demo" if args.demo else "live",
        "status": "failed",
        "error": str(error)[:300],
        "check": work.check,
        "trace": work.trace,
    }
output = Path(args.output)
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(result, ensure_ascii=False, indent=2))
raise SystemExit(0 if result["status"] == "success" else 1)
