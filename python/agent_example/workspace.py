import json
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel

FIXTURE = Path(__file__).resolve().parents[2] / "fixture"


def load(name: str) -> Any:
    return json.loads((FIXTURE / f"{name}.json").read_text())


class Report(BaseModel):
    action: Literal["ask_author", "check_export"]
    reason: str
    sources: list[str]


class Workspace:
    def __init__(self, case: dict[str, Any]):
        self.case = case
        self.tickets = load("tickets")
        self.labels: dict[str, str] = {}
        if case.get("reply"):
            self.tickets["T-42"]["comments"].append(case["reply"])

    def read_ticket(self, ticket_id: str) -> dict:
        ticket = self.tickets.get(ticket_id)
        return {"status": "found", "ticket": ticket} if ticket else {"status": "empty"}

    def search_tickets(self, query: str) -> dict:
        if self.case.get("offline"):
            return {"status": "unavailable"}
        ids = [key for key, t in self.tickets.items() if query.lower() in t["text"].lower()]
        return {"status": "found" if ids else "empty", "ids": ids}

    def set_label(self, ticket_id: str, label: str) -> dict:
        if not self.case.get("write_labels"):
            return {"status": "denied"}
        if ticket_id not in self.tickets or label != "needs-info":
            return {"status": "invalid"}
        self.labels[ticket_id] = label
        return {"status": "updated", "label": label}
