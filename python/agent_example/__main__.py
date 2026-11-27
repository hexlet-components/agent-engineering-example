import argparse
import asyncio
import json
from pathlib import Path

from .agent import investigate
from .workspace import load

parser = argparse.ArgumentParser()
parser.add_argument("--demo", action="store_true")
parser.add_argument("--scenario", choices=list(load("scenarios")), default="agent-loop")
parser.add_argument("--output", default="var/python.json")
args = parser.parse_args()
result = asyncio.run(investigate(scenario=args.scenario, demo=args.demo))
output = Path(args.output)
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(output.read_text(), end="")
