"""Chat clients for the agents: gpt-5-mini on Azure AI Foundry, or a deterministic offline fake.

Every agent asks for JSON with a pydantic `response_format`; the schemas live here so the fake can
answer each agent by schema name.
"""
import asyncio
import json
import os

from agent_framework import (BaseChatClient, ChatMiddlewareLayer, ChatResponse, Content, FunctionInvocationLayer,
                             Message, UsageDetails)
from pydantic import BaseModel

from .. import config

TOOL_LOOP = {"max_iterations": 3, "max_function_calls": 4}  # bounds the MCP tool round trips per agent run


class Pick(BaseModel):
    candidate_id: str
    confidence: float
    angle: str


class Picks(BaseModel):
    picks: list[Pick]


class Analysis(BaseModel):
    story_id: str
    analysis_en: str
    fact_ids: list[str]


class Analyses(BaseModel):
    stories: list[Analysis]


class Line(BaseModel):
    story_id: str
    text: str


class Lines(BaseModel):
    lines: list[Line]


class Verdict(BaseModel):
    story_id: str
    lang: str
    ok: bool
    issue: str


class Verdicts(BaseModel):
    verdicts: list[Verdict]


def cost_usd(usage):
    """Cost of one usage record at config.MODEL_PRICE_PER_M."""
    p = config.MODEL_PRICE_PER_M
    cached = usage.get("cache_read_input_token_count") or 0
    tin, tout = usage.get("input_token_count") or 0, usage.get("output_token_count") or 0
    return ((tin - cached) * p["input"] + cached * p["cached_input"] + tout * p["output"]) / 1e6


def azure_client(endpoint=None):
    """gpt-5-mini through the Responses API at <endpoint>/openai/v1/, Entra ID auth (no keys).

    DefaultAzureCredential: the az CLI login locally, the managed identity in Container Apps.
    """
    from agent_framework.openai import OpenAIChatClient
    from azure.identity import DefaultAzureCredential

    endpoint = endpoint or os.environ.get("AZURE_OPENAI_ENDPOINT")
    if not endpoint:
        raise SystemExit("set AZURE_OPENAI_ENDPOINT=https://<account>.openai.azure.com (or use --fake)")
    return OpenAIChatClient(model=os.environ.get("AZURE_OPENAI_DEPLOYMENT", config.MODEL_DEPLOYMENT),
                            azure_endpoint=endpoint.removesuffix("/").removesuffix("/openai/v1"),
                            credential=DefaultAzureCredential(exclude_interactive_browser_credential=True),
                            function_invocation_configuration=TOOL_LOOP)


class FakeChatClient(FunctionInvocationLayer, ChatMiddlewareLayer, BaseChatClient):
    """Deterministic offline stand-in for gpt-5-mini, used by tests and `--fake`.

    It reads the JSON payload of the last user message and answers by response schema: the finder
    picks every candidate, the analyst cites the facts, the commentator writes the fact labels in its
    language, the judge approves. `responder(schema_name, payload)` may return a dict to answer
    instead, raise to simulate a failing agent, or return None to keep the default. A dict
    `{"tool_call": {"name": .., "arguments": {..}}}` makes the model call that tool first; the tool
    results it gets back are kept in `tool_results` and the next answer is the default one.
    """

    OTEL_PROVIDER_NAME = "fake"

    def __init__(self, responder=None, delay_s=0.0):
        super().__init__(function_invocation_configuration=TOOL_LOOP)
        self.responder, self.delay_s, self.calls, self.tool_results = responder, delay_s, [], []

    async def _inner_get_response(self, *, messages, stream, options, **kwargs):
        schema = options["response_format"].__name__
        text = next(m.text for m in reversed(messages) if m.role == "user")
        payload = json.loads(text)
        self.calls.append((schema, payload))
        if self.delay_s:
            await asyncio.sleep(self.delay_s)
        results = [c.result for m in messages for c in m.contents if c.type == "function_result"]
        self.tool_results += results
        out = self.responder(schema, payload) if self.responder and not results else None
        if isinstance(out, dict) and "tool_call" in out:
            body, contents = json.dumps(out), [Content.from_function_call(
                call_id=f"call-{len(self.calls)}", name=out["tool_call"]["name"], arguments=out["tool_call"]["arguments"])]
        else:
            out = out if out is not None else getattr(self, f"_{schema.lower()}")(payload)
            body = json.dumps(out, ensure_ascii=False)
            contents = [body]
        return ChatResponse(messages=[Message(role="assistant", contents=contents)], model="fake",
                            usage_details=UsageDetails(input_token_count=len(text) // 4,
                                                       output_token_count=len(body) // 4))

    @staticmethod
    def _picks(p):
        return {"picks": [{"candidate_id": c["candidate_id"], "confidence": 0.9, "angle": c["note"]}
                          for c in p["candidates"]]}

    @staticmethod
    def _analyses(p):
        return {"stories": [{"story_id": s["story_id"], "fact_ids": [f["fact_id"] for f in s["facts"][:2]],
                             "analysis_en": " ".join(f"{f['label']} [{f['fact_id']}]." for f in s["facts"][:2])}
                            for s in p["stories"]]}

    @staticmethod
    def _lines(p):
        return {"lines": [{"story_id": s["story_id"],
                           "text": f"{s['phase']}, {s['score']['write']}." if s["kind"] == "recap" else
                           f"{s['player'] or s['team']}, {s['minute']}': {s['facts'][0]['label']}."}
                          for s in p["stories"]]}

    @staticmethod
    def _verdicts(p):
        return {"verdicts": [{"story_id": t["story_id"], "lang": t["lang"], "ok": True, "issue": ""}
                             for t in p["texts"]]}
