from mcp.server.mcpserver import MCPServer

from .workspace import Workspace

server = MCPServer("training-tracker")
tracker = Workspace({})


@server.tool()
def read_ticket(ticket_id: str) -> str:
    """Read one ticket from the training tracker."""
    import json

    return json.dumps(tracker.read_ticket(ticket_id), ensure_ascii=False)


if __name__ == "__main__":
    server.run()
