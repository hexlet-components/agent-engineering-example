import json
import tempfile
import unittest
from pathlib import Path

from agent_example.agent import investigate, resume
from agent_example.workspace import load


class AgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_all_scenarios(self):
        for scenario in load("scenarios"):
            result = await investigate(scenario=scenario)
            for run in result["runs"]:
                with self.subTest(scenario=scenario, case=run["case"]):
                    events = run["trace"]
                    calls = [e["call_id"] for e in events if e["type"] == "call"]
                    self.assertTrue(calls)
                    self.assertEqual(calls, [e["call_id"] for e in events if e["type"] == "result"])
                    self.assertEqual(len(calls), len(set(calls)))
                    expected = ["accepted"]
                    if scenario == "verification":
                        expected = ["retry", "accepted" if run["case"] == "repair" else "exhausted"]
                    self.assertEqual([d["decision"] for d in run["decisions"]], expected)
            if scenario == "trust-boundaries":
                self.assertEqual(
                    [r["labels"] for r in result["runs"]], [{}, {"T-42": "needs-info"}]
                )
            if scenario == "task-state":
                self.assertEqual(result["paused"]["request_id"], result["resumed"]["request_id"])
                self.assertEqual(result["resumed"]["status"], "resumed")

    async def test_trajectory(self):
        result = await investigate(scenario="trajectories")
        tickets = load("tickets")
        events = result["runs"][0]["trace"]
        for index, ticket_id in enumerate(["T-42", "T-17"]):
            request, response = events[2 * index : 2 * index + 2]
            self.assertEqual(request["name"], "read_ticket")
            self.assertEqual(request["arguments"], {"ticket_id": ticket_id})
            self.assertEqual(response["call_id"], request["call_id"])
            self.assertEqual(response["output"]["ticket"], tickets[ticket_id])

    def test_wrong_reply_keeps_pause(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "task.json"
            state = {
                "status": "waiting",
                "request_id": "Q-42",
                "ticket_id": "T-42",
                "reason": "Фильтр?",
            }
            path.write_text(json.dumps(state))
            with self.assertRaises(ValueError):
                resume(path, {"request_id": "Q-17", "ticket_id": "T-42", "text": "Да"})
            self.assertEqual(json.loads(path.read_text()), state)
