"""Times N operator model pings against a deployed Studio Desk. Usage: measure_latency.py URL N

Each ping is one paid Azure OpenAI call on the deployment: never run it from tests."""
import json
import math
import statistics
import sys
import time
import urllib.request
from pathlib import Path

url, n = sys.argv[1].rstrip("/"), int(sys.argv[2])
token = (Path(__file__).resolve().parent.parent / "out" / "admin-token.txt").read_text().strip()
model, total = [], []
for _ in range(n):
    req = urllib.request.Request(f"{url}/api/admin/model-ping", method="POST", headers={"x-admin-token": token})
    t0 = time.perf_counter()
    body = json.load(urllib.request.urlopen(req, timeout=90))
    total.append((time.perf_counter() - t0) * 1000)
    model.append(body["model_ms"])
    time.sleep(1)


def summary(xs):
    xs = sorted(xs)
    return {"median_ms": round(statistics.median(xs)), "p90_ms": round(xs[math.ceil(0.9 * len(xs)) - 1]), "max_ms": round(xs[-1])}


print(json.dumps({"calls": n, "model_call_inside_azure": summary(model), "round_trip_from_client": summary(total)}, indent=1))
