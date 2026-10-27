"""Thresholds and caps named in docs/CONTRACT.md."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MATCHES_DB = ROOT / "data" / "matches.sqlite"
RUNTIME_DB = ROOT / "data" / "runtime.sqlite"
FORBIDDEN_NAMES = ROOT / "data" / "forbidden_names.txt"

FPS = 10
AUTO_APPROVE_RISK = 0.35
MAX_GRAPHICS_ON_SCREEN = 2
DAILY_COST_STOP_USD = 25.0
ASK_PER_SESSION_PER_DAY = 10
# The Content Safety resource is on the free tier F0: 5,000 text records a month. One question makes 3 calls
# (text:analyze and text:shieldPrompt on the question, text:analyze on the answer), each one record (question
# and answer are under 1,000 characters). 40 a day x 3 x 31 days = 3,720 records, which leaves 1,280 for the
# stories' checks (studiodesk/agents/safety.py: at most 100 calls a match, so 4 matches checked 3 times).
# Override with ASK_PER_DAY on a paid tier.
ASK_PER_DAY = int(os.environ.get("ASK_PER_DAY", "40"))
ASK_PER_CLIENT_PER_DAY = 30   # per client address: dropping the cookie does not reset it
ASK_TIMEOUT_S = 55.0          # the whole answer, under the page's 60 s
ASK_SAFETY_TIMEOUT_S = 5.0    # each Content Safety call made for a question

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
