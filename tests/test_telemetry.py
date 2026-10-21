"""OpenTelemetry spans for Application Insights, offline: an in-memory exporter in place of Azure Monitor."""
import sys
from types import SimpleNamespace

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from studiodesk import telemetry
from studiodesk.agents.llm import FakeChatClient
from test_agents import desk_db, rows, run  # noqa: F401 - fixtures and helpers
from test_ask import SPRINT, body, studio  # noqa: F401


@pytest.fixture
def spans():
    """Spans finished during the test. The global provider is set once per process (OpenTelemetry allows
    one); each test gets its own exporter, stopped afterwards so later tests store nothing."""
    if not isinstance(trace.get_tracer_provider(), TracerProvider):
        trace.set_tracer_provider(TracerProvider())
    exporter = InMemorySpanExporter()
    trace.get_tracer_provider().add_span_processor(SimpleSpanProcessor(exporter))
    yield exporter.get_finished_spans
    exporter.shutdown()


def by_name(finished, prefix):
    return [s for s in finished() if s.name.startswith(prefix)]


def test_without_the_connection_string_nothing_is_configured(monkeypatch):
    monkeypatch.delenv(telemetry.ENV, raising=False)
    monkeypatch.setattr(telemetry, "_configured", False)
    monkeypatch.setitem(sys.modules, "azure.monitor.opentelemetry",
                        SimpleNamespace(configure_azure_monitor=lambda **kw: pytest.fail("Azure Monitor configured")))
    assert telemetry.setup() is False


def test_the_connection_string_configures_azure_monitor_once_without_addresses(monkeypatch):
    calls = []
    monkeypatch.setenv(telemetry.ENV, "InstrumentationKey=00000000-0000-0000-0000-000000000000")
    monkeypatch.setattr(telemetry, "_configured", False)
    monkeypatch.setitem(sys.modules, "azure.monitor.opentelemetry",
                        SimpleNamespace(configure_azure_monitor=lambda **kw: calls.append(kw)))
    assert telemetry.setup() and telemetry.setup()
    (kw,) = calls
    assert kw["connection_string"].startswith("InstrumentationKey=")
    assert kw["instrumentation_options"] == {"fastapi": {"enabled": False}}  # it records client addresses
    assert kw["logger_name"] == "studiodesk" and kw["enable_live_metrics"] is False  # no access log
    from agent_framework.observability import OBSERVABILITY_SETTINGS
    assert OBSERVABILITY_SETTINGS.ENABLED and not OBSERVABILITY_SETTINGS.SENSITIVE_DATA_ENABLED


def test_a_bad_connection_string_never_stops_the_app(monkeypatch):
    monkeypatch.setenv(telemetry.ENV, "not a connection string")
    monkeypatch.setattr(telemetry, "_configured", False)

    def bad(**kw):
        raise ValueError("bad connection string")
    monkeypatch.setitem(sys.modules, "azure.monitor.opentelemetry", SimpleNamespace(configure_azure_monitor=bad))
    assert telemetry.setup() is False


def test_ask_makes_one_span_with_the_agent_tool_and_verdict_and_no_question(studio, spans):
    studio.fake.responder = lambda schema, p: {"tool_call": {"name": "get_facts", "arguments": {"match_id": "M001", "kind": "sprint_speed"}}}
    c = studio.visitor()
    assert c.post("/api/ask", json=body()).json()["status"] == "declined"  # the fake says nothing after the tool
    studio.reply("The quickest sprint so far was 32 km/h.", [SPRINT])
    assert c.post("/api/ask", json=body()).json()["status"] == "answered"
    c.get("/api/health")
    c.get("/")  # the page and its files make no spans, only /api/ does

    requests = [s for s in spans() if s.parent is None]
    assert [s.name for s in requests] == ["POST /api/ask", "POST /api/ask", "GET /api/health"]
    asks = by_name(spans, "ask_studio")
    assert len(asks) == 2 and all(s.parent.trace_id == s.context.trace_id for s in asks)
    assert {s.context.trace_id for s in asks} == {s.context.trace_id for s in requests[:2]}
    assert dict(asks[0].attributes) == {"studiodesk.match_id": "M001", "studiodesk.ts": 100.0, "studiodesk.lang": "en"}
    verdicts = [dict(e.attributes) for s in asks for e in s.events if e.name == "studiodesk.verdict"]
    assert [(v["studiodesk.accepted"], v["studiodesk.reason"]) for v in verdicts] == [
        (False, "no answer from the facts"), (True, "")]
    agent = by_name(spans, "invoke_agent studio_host")
    assert len(agent) == 2 and {s.parent.span_id for s in agent} == {s.context.span_id for s in asks}
    a = agent[1].attributes
    assert a["gen_ai.operation.name"] == "invoke_agent" and a["gen_ai.agent.name"] == "studio_host"
    assert a["gen_ai.usage.input_tokens"] > 0 and a["gen_ai.usage.output_tokens"] > 0
    chat = by_name(spans, "chat ")
    assert chat and all(s.attributes["gen_ai.request.model"] == "fake" and s.attributes["gen_ai.usage.input_tokens"] > 0
                        for s in chat)
    (tool,) = by_name(spans, "execute_tool get_facts")
    assert tool.attributes["gen_ai.tool.name"] == "get_facts"
    # sensitive data stays off: neither the question, nor the tool arguments, nor the client address reach a span
    for s in spans():
        values = [str(v) for v in s.attributes.values()] + [str(v) for e in s.events for v in e.attributes.values()]
        assert not any(body()["question"] in v or "testclient" in v for v in values), s.name
        assert not any(k.startswith(("client.", "http.client", "user_agent", "http.request.header", "gen_ai.tool.call.arg",
                                     "gen_ai.input", "gen_ai.output")) for k in s.attributes), s.name


def test_workflow_spans_per_agent_mcp_tool_and_verdict_events(desk_db, spans):  # noqa: F811
    _, _, rt = desk_db
    asked = []

    def responder(schema, p):  # the story finder looks at the facts through MCP once
        if schema == "Picks" and not asked:
            asked.append(1)
            return {"tool_call": {"name": "get_facts", "arguments": {"match_id": "M001", "kind": "sprint_speed"}}}
    summary = run(rt, FakeChatClient(responder), to_ts=400)

    agents = by_name(spans, "invoke_agent ")
    assert {s.attributes["gen_ai.agent.name"] for s in agents} == {
        "story_finder", "analyst", "commentator_en", "commentator_it", "commentator_es", "verifier"}
    assert all(s.attributes["gen_ai.operation.name"] == "invoke_agent" and s.attributes["gen_ai.usage.input_tokens"] > 0
               for s in agents)
    assert len(by_name(spans, "chat fake")) == summary["model_calls"]  # one chat span per model call, model named
    assert by_name(spans, "tools/call get_facts") and by_name(spans, "execute_tool get_facts")
    verdicts = [dict(e.attributes) for s in by_name(spans, "executor.process verifier") for e in s.events
                if e.name == "studiodesk.verdict"]
    st = rows(rt, "stories")
    assert st and len(verdicts) == 3 * len(st)
    assert {(v["studiodesk.story_id"], v["studiodesk.lang"]) for v in verdicts} == {
        (s["story_id"], lang) for s in st for lang in ("en", "it", "es")}
    assert all(v["studiodesk.accepted"] and v["studiodesk.status"] == "pass" and v["studiodesk.reason"] == ""
               and v["studiodesk.match_id"] == "M001" for v in verdicts)


def test_a_rejected_text_carries_its_short_reason(desk_db, spans):  # noqa: F811
    _, _, rt = desk_db
    # the Italian writer keeps a number the facts do not give: after the rewrites the story is the template
    run(rt, FakeChatClient(lambda schema, p: {"lines": [{"story_id": s["story_id"], "text": "Minuto 1: 999 km/h."}
                                                        for s in p["stories"]]}
                           if schema == "Lines" and p["language"] == "it" else None), to_ts=400)
    verdicts = [dict(e.attributes) for s in by_name(spans, "executor.process verifier") for e in s.events
                if e.name == "studiodesk.verdict"]
    assert verdicts and {(v["studiodesk.lang"], v["studiodesk.accepted"], v["studiodesk.status"], v["studiodesk.reason"])
                         for v in verdicts} == {("it", False, "template", "a number the facts do not give"),
                                                ("en", True, "template", ""), ("es", True, "template", "")}
