import tempfile
import unittest
from pathlib import Path

from agents.exceptions import MaxTurnsExceeded

from agent_example.agent import investigate
from agent_example.demo_model import DEMO_REPORT
from agent_example.workspace import Report, Workspace


class AgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_demo_runs_sdk_and_tools(self) -> None:
        result = await investigate(demo=True)
        self.assertEqual(result["mode"], "demo")
        self.assertEqual(result["status"], "success")
        self.assertFalse(result["check"]["passed"])
        self.assertEqual(result["check"]["exitCode"], 1)
        self.assertIn("NEIL", result["check"]["output"])
        self.assertEqual(result["findings"], DEMO_REPORT["findings"])
        self.assertCountEqual(
            [item["name"] for item in result["trace"]],
            ["read_diff", "search_files", "read_file", "read_file", "run_check"],
        )

    async def test_turn_budget(self) -> None:
        with self.assertRaises(MaxTurnsExceeded):
            await investigate(demo=True, max_turns=1)


class WorkspaceTests(unittest.TestCase):
    def test_tool_boundaries(self) -> None:
        work = Workspace()
        for name, args, error in [
            ("read_file", {"path": "../pyproject.toml"}, "PATH_DENIED"),
            ("read_file", {"path": "src/pricing/discount.ts", "limit": 41}, "LINE_LIMIT"),
            ("shell", {"command": "echo should-not-run"}, "TOOL_DENIED"),
        ]:
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, error):
                work.invoke(name, args)

    def test_tool_budget(self) -> None:
        work = Workspace(max_calls=1)
        work.invoke("list_files")
        with self.assertRaisesRegex(ValueError, "TOOL_BUDGET"):
            work.invoke("read_diff")

    def test_check_and_evidence_are_required(self) -> None:
        work = Workspace()
        report = Report.model_validate(DEMO_REPORT)
        with self.assertRaisesRegex(ValueError, "CHECK_REQUIRED"):
            work.validate(report)
        work.invoke("run_check")
        with self.assertRaisesRegex(ValueError, "UNREAD_EVIDENCE"):
            work.validate(report)
        with self.assertRaisesRegex(ValueError, "UNEXPLAINED_CHECK_FAILURE"):
            work.validate(Report(findings=[]))

    def test_symlink_is_denied(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            fixture = root / "fixture"
            fixture.mkdir()
            (root / "private.txt").write_text("private")
            (fixture / "outside.txt").symlink_to(root / "private.txt")
            with self.assertRaisesRegex(ValueError, "PATH_DENIED"):
                Workspace(fixture).invoke("read_file", {"path": "outside.txt"})

    def test_withheld_output_cannot_become_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "large.ts").write_text("x" * 9000)
            work = Workspace(root)
            with self.assertRaisesRegex(ValueError, "OUTPUT_LIMIT"):
                work.invoke("read_file", {"path": "large.ts"})
            self.assertEqual(work.reads, [])
