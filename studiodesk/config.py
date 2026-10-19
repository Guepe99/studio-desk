"""Thresholds and caps named in docs/CONTRACT.md."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MATCHES_DB = ROOT / "data" / "matches.sqlite"
RUNTIME_DB = ROOT / "data" / "runtime.sqlite"
FORBIDDEN_NAMES = ROOT / "data" / "forbidden_names.txt"

FPS = 10
AUTO_APPROVE_RISK = 0.35
MAX_GRAPHICS_ON_SCREEN = 2
LIVE_RUNS_PER_SESSION_PER_DAY = 2
LIVE_RUNS_PER_DAY = 20
DAILY_COST_STOP_USD = 25.0

# Agents (studiodesk/agents): gpt-5-mini on Azure AI Foundry, reasoning effort minimal.
MODEL_DEPLOYMENT = "gpt-5-mini"
# USD per 1M tokens, Azure OpenAI Global Standard, gpt-5-mini: input 0.25, cached input 0.025, output 2.00.
# Sources: https://azure.microsoft.com/en-us/pricing/details/azure-openai/ and
# https://www.azurespeed.com/AzureAiModelPricing/Models/openai-gpt-5-mini (checked 19 Oct 2026).
MODEL_PRICE_PER_M = {"input": 0.25, "cached_input": 0.025, "output": 2.00}
AGENT_TIMEOUT_S = 45.0
MAX_REWRITES = 2
# One agents run (studiodesk/agents/workflow.py): past either ceiling every agent falls back to rules
# and templates. A match costs about 0.10 USD and 150 to 250 calls.
RUN_MAX_COST_USD = 0.50
RUN_MAX_CALLS = 400
MAX_PARALLEL_CALLS = 2   # model calls in flight at once; more trips the endpoint's rate limit (429)
