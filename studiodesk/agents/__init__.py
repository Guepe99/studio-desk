"""Studio Desk agents on Microsoft Agent Framework: story finder, analyst, commentators, verifier, director.

`rules` is the deterministic half (candidates, number checks, templates, risk, director), `llm` the
chat clients (gpt-5-mini on Azure or an offline fake), `workflow` the graph and the run loop.
Run with `python -m studiodesk.agents run M001`.
"""
