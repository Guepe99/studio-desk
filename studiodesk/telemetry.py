"""OpenTelemetry traces to Azure Application Insights, only when APPLICATIONINSIGHTS_CONNECTION_STRING is set.

Agent Framework already emits the GenAI spans (invoke_agent <agent>, chat <model> with token usage,
execute_tool, the MCP tools/call, the workflow steps); this only gives them an exporter, the way
FoundryChatClient.configure_azure_monitor does. Message content stays out (sensitive data off). The
FastAPI instrumentation and the root logger are left out: they would send client addresses and the
access log. Without the variable nothing is imported and nothing changes.
"""
import logging
import os

ENV = "APPLICATIONINSIGHTS_CONNECTION_STRING"
_configured = False


def setup():
    """Configures the Azure Monitor exporter once per process; True when traces go to Application Insights.
    A bad connection string or a missing package logs a warning: the app runs on without telemetry."""
    global _configured
    if _configured or not os.environ.get(ENV):
        return _configured
    try:
        from agent_framework.observability import create_metric_views, create_resource, enable_instrumentation
        from azure.monitor.opentelemetry import configure_azure_monitor

        configure_azure_monitor(
            connection_string=os.environ[ENV], resource=create_resource(service_name="studiodesk"),
            views=create_metric_views(), logger_name="studiodesk", enable_live_metrics=False,
            enable_performance_counters=False, instrumentation_options={"fastapi": {"enabled": False}})
        enable_instrumentation(enable_sensitive_data=False)
    except Exception as e:  # noqa: BLE001 - telemetry never stops the broadcast
        logging.getLogger("uvicorn.error").warning("Application Insights not configured: %s", type(e).__name__)
        return False
    _configured = True
    return True
