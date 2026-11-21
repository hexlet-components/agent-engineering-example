"""Read-only tools shared by live and scripted SDK runs."""

import json
import os
import subprocess
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field


class Citation(BaseModel):
    path: str
    from_: int = Field(alias="from", ge=1)
    to: int = Field(ge=1)


class Finding(BaseModel):
    path: str
    line: int = Field(ge=1)
    message: str = Field(min_length=1)
    evidence: list[Citation] = Field(min_length=1)


class Report(BaseModel):
    findings: list[Finding]


class Workspace:
    def __init__(self, root: Path | None = None, max_calls: int = 16) -> None:
        self.root = (root or Path(__file__).resolve().parents[2] / "fixture").resolve()
        self.max_calls = max_calls
        self.trace: list[dict[str, Any]] = []
        self.reads: list[Citation] = []
        self.check: dict[str, Any] | None = None

    def files(self) -> list[str]:
        return sorted(
            str(path.relative_to(self.root))
            for path in self.root.rglob("*")
            if path.is_file()
            and not path.is_symlink()
            and not any(part.startswith(".") for part in path.relative_to(self.root).parts)
            and path.suffix in {".ts", ".txt", ".diff"}
        )

    def path(self, name: str) -> Path:
        if "\\" in name or any(part.startswith(".") or not part for part in name.split("/")):
            raise ValueError("PATH_DENIED")
        path = (self.root / name).resolve()
        if not path.is_relative_to(self.root) or name not in self.files():
            raise ValueError("PATH_DENIED")
        return path

    def invoke(self, name: str, arguments: dict[str, Any] | None = None) -> Any:
        args = arguments or {}
        if len(self.trace) >= self.max_calls:
            raise ValueError("TOOL_BUDGET")
        result: Any
        read: Citation | None = None
        if name == "list_files":
            result = self.files()
        elif name in {"read_file", "read_diff"}:
            path = "change.diff" if name == "read_diff" else str(args["path"])
            offset, limit = args.get("offset", 0), args.get("limit", 40)
            if (
                type(offset) is not int
                or offset < 0
                or type(limit) is not int
                or not 1 <= limit <= 40
            ):
                raise ValueError("LINE_LIMIT")
            lines = self.path(path).read_text().rstrip().splitlines()[offset : offset + limit]
            citation = {"path": path, "from": offset + 1, "to": offset + len(lines)}
            if lines:
                read = Citation.model_validate(citation)
            result = {**citation, "lines": lines}
        elif name == "search_files":
            pattern = str(args.get("pattern", ""))
            if not pattern or len(pattern) > 80:
                raise ValueError("SEARCH_LIMIT")
            matches = [
                {"path": path, "line": index + 1, "text": line}
                for path in self.files()
                if path.startswith(("src/", "test/"))
                for index, line in enumerate(self.path(path).read_text().splitlines())
                if pattern in line
            ]
            result = {"matches": matches[:20], "truncated": len(matches) > 20}
        elif name == "run_check":
            try:
                process = subprocess.run(
                    ["node", "--test", "test/discount.test.ts"],
                    cwd=self.root,
                    timeout=10,
                    capture_output=True,
                    text=True,
                    env={
                        "PATH": os.environ.get("PATH", ""),
                        "LANG": "C.UTF-8",
                        "NODE_NO_WARNINGS": "1",
                    },
                    check=False,
                )
            except (OSError, subprocess.TimeoutExpired) as error:
                raise ValueError("CHECK_RUNTIME_ERROR") from error
            result = self.check = {
                "passed": process.returncode == 0,
                "exitCode": process.returncode,
                "output": (process.stdout + process.stderr)[-6000:],
            }
        else:
            raise ValueError("TOOL_DENIED")
        if len(json.dumps(result, ensure_ascii=False)) > 8000:
            raise ValueError("OUTPUT_LIMIT")
        if read is not None:
            self.reads.append(read)
        self.trace.append({"name": name, "arguments": args, "result": result})
        return result

    def validate(self, report: Report) -> None:
        if self.check is None:
            raise ValueError("CHECK_REQUIRED")
        if not report.findings and not self.check["passed"]:
            raise ValueError("UNEXPLAINED_CHECK_FAILURE")
        for finding in report.findings:
            refs = [
                *finding.evidence,
                Citation.model_validate(
                    {"path": finding.path, "from": finding.line, "to": finding.line}
                ),
            ]
            for ref in refs:
                if not any(
                    read.path == ref.path and read.from_ <= ref.from_ <= ref.to <= read.to
                    for read in self.reads
                ):
                    raise ValueError("UNREAD_EVIDENCE")
