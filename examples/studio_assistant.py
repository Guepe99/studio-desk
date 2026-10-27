"""Studio Desk from your own agent: a Microsoft Agent Framework agent that answers a producer's question about a
match up to a given minute, reading the match only through the Studio Desk MCP server.

    .venv/bin/python examples/studio_assistant.py --match M001 --minute 30 "Who has created the most chances so far?"
    .venv/bin/python examples/studio_assistant.py --match M001 --minute 30 --dry-run    # offline: no model

The server (studiodesk/mcp_server.py) runs as a child process over stdio, with STUDIODESK_CLOCK set to the minute's
end: every tool then sees the match up to that moment only, whatever the model asks for. The model is gpt-5-mini on
Azure AI Foundry with the same client and Entra ID auth as studiodesk/agents (AZURE_OPENAI_ENDPOINT, `az login`).
--dry-run lists the server's tools and calls get_team_totals directly, with no model and no Azure.
"""
import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from agent_framework import Agent, MCPStdioTool

ROOT = Path(__file__).resolve().parent.parent
INSTRUCTIONS = (
    "You help a TV football producer. Answer the question about the match in one or two sentences, using only what "
    "the Studio Desk tools return; they already stop at the minute given. Quote numbers exactly as the facts give "
    "them and list the fact_ids you used. If the tools do not answer the question, say so.")


def server(clock=None):
    """The Studio Desk MCP server as a stdio child process, held at `clock` match seconds (None: the whole match)."""
    # the stdio client passes the child only a minimal environment: forward the server's own settings
    env = {k: v for k, v in os.environ.items() if k.startswith("STUDIODESK_")}
    if clock is not None:
        env["STUDIODESK_CLOCK"] = str(clock)
    return MCPStdioTool(name="studiodesk", command=sys.executable, args=["-m", "studiodesk.mcp_server"], env=env,
                        cwd=str(ROOT), load_prompts=False)


def data(contents):
    """A tool result as JSON data: the server's structured output, which wraps a list as {"result": [...]}."""
    out = json.loads(contents if isinstance(contents, str) else "".join(c.text or "" for c in contents))
    return out["result"] if isinstance(out, dict) and set(out) == {"result"} else out


async def clock_for(match_id, minute):
    """Match seconds at the end of `minute` (1 to 45 first half, 46 on second half), as the page counts minutes."""
    if minute <= 45:
        return minute * 60.0
    async with server() as mcp:  # the first half's length, stoppage included, sets where the second half starts
        info = data(await mcp.call_tool("get_match_info", match_id=match_id))
    return info["period1_s"] + (minute - 45) * 60.0


async def dry_run(match_id, minute):
    async with server(await clock_for(match_id, minute)) as mcp:
        print("tools:", ", ".join(f.name for f in mcp.functions))
        totals = data(await mcp.call_tool("get_team_totals", match_id=match_id))
    print(f"get_team_totals({match_id}) up to minute {minute}:")
    for f in totals:
        print(f"  {f['team_id']} {f['label_en']} [{f['fact_id']}]")
    return totals


async def ask(question, match_id, minute, client=None):
    """The agent's answer and the tool calls it made, as (name, arguments) pairs."""
    from studiodesk.agents.llm import Answer, azure_client
    async with server(await clock_for(match_id, minute)) as mcp:
        agent = Agent(client or azure_client(), INSTRUCTIONS, name="studio_assistant", tools=[mcp],
                      default_options={"reasoning": {"effort": "minimal"}, "store": False})  # as studiodesk/agents/ask.py
        res = await agent.run(json.dumps({"match_id": match_id, "minute": minute, "question": question}),
                              options={"response_format": Answer})
    calls = [(c.name, c.arguments) for m in res.messages for c in m.contents if c.type == "function_call"]
    return Answer.model_validate_json(res.text), calls


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("question", nargs="?", default="Who has created the most chances so far?")
    p.add_argument("--match", default="M001")
    p.add_argument("--minute", type=int, default=30, help="the match so far: up to the end of this minute")
    p.add_argument("--dry-run", action="store_true", help="list the tools and call one, no model")
    a = p.parse_args(argv)
    if a.dry_run:
        asyncio.run(dry_run(a.match, a.minute))
        return
    answer, calls = asyncio.run(ask(a.question, a.match, a.minute))
    for name, args in calls:
        print(f"tool: {name} {args}")
    print(answer.answer)
    print("facts:", ", ".join(answer.fact_ids) or "none")


if __name__ == "__main__":
    main()
