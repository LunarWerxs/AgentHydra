"""Spawn the MCP server over stdio exactly as Claude Code would and call its tools.

    python tests/mcp_smoke.py            # doctor + ask + a 3-task hswarm_run with an absolute cwd
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


async def main() -> int:
    sys.path.insert(0, str(REPO.parent))
    from hswarm import config
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    # The whole environment goes through (the SDK default passes a bare subset), so the server sees the calling
    # session's CLAUDE_CODE_* variables and its rows carry a real caller stamp, as under Claude Code.
    params = StdioServerParameters(command=config.launcher()[0], args=[*config.launcher()[1:], "mcp"], env=dict(os.environ))
    tmp = Path(tempfile.mkdtemp(prefix="hswarm-mcp-"))
    (tmp / "a.txt").write_text("apple\nbanana\ncherry\n")
    async with stdio_client(params) as (r, w):
        async with ClientSession(r, w) as s:
            await s.initialize()
            tools = await s.list_tools()
            names = sorted(t.name for t in tools.tools)
            print("tools:", names)
            assert {"hswarm_run", "hswarm_ask", "hswarm_status", "hswarm_results", "hswarm_cost", "hswarm_doctor", "hswarm_cancel", "hswarm_jobs"} <= set(names)

            d = await s.call_tool("hswarm_doctor", {})
            doc = json.loads(d.content[0].text)
            print("doctor key present:", doc["key"]["present"], "models:", doc.get("models"))
            assert doc["key"]["present"] and "sk-" not in json.dumps(doc)

            a = await s.call_tool("hswarm_ask", {"prompt": "Reply with exactly PONG.", "thinking": False, "max_tokens": 8})
            ans = json.loads(a.content[0].text)
            print("ask:", ans["status"], ans["answer"], f"${ans['cost_usd']:.6f}")
            assert ans["status"] == "ok" and "PONG" in ans["answer"].upper()

            run = await s.call_tool(
                "hswarm_run",
                {
                    "tasks": [
                        {"id": "lines", "prompt": "How many lines are in a.txt? Reply with the integer only."},
                        {"id": "second", "prompt": "What is the second line of a.txt? Reply with the word only."},
                        {"id": "structured", "prompt": "List the fruits in a.txt.", "schema": {"type": "object", "properties": {"fruits": {"type": "array", "items": {"type": "string"}}}, "required": ["fruits"]}},
                    ],
                    "cwd": str(tmp),
                    "label": "mcp-smoke",
                    "wait_s": 180,
                },
            )
            payload = json.loads(run.content[0].text)
            print("run summary:", payload["summary"]["counts"], f"${payload['summary']['cost_usd']:.6f}")
            by = {x["id"]: x for x in payload["results"]}
            assert by["lines"]["status"] == "ok" and "3" in by["lines"]["answer"], by["lines"]
            assert by["second"]["status"] == "ok" and "banana" in by["second"]["answer"].lower(), by["second"]
            assert by["structured"]["data"]["fruits"] and len(by["structured"]["data"]["fruits"]) == 3, by["structured"]

            st = await s.call_tool("hswarm_status", {"job_id": payload["summary"]["job_id"]})
            print("status:", json.loads(st.content[0].text)["state"])
            cost = await s.call_tool("hswarm_cost", {"days": 1, "balance": False})
            print("cost today:", json.loads(cost.content[0].text)["cost_usd"])
    print("MCP SMOKE OK")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
