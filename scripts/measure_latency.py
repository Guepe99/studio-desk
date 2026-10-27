"""Times N operator model pings against a deployed Studio Desk. Usage: ADMIN_TOKEN=<token> measure_latency.py URL N

ADMIN_TOKEN is the deployment's admin token (the server reads the same variable).

Each ping is one paid Azure OpenAI call on the deployment: never run it from tests."""
import json
import math
import statistics
import sys
import time
import os
import urllib.request

if len(sys.argv) != 3 or not os.environ.get("ADMIN_TOKEN"):
    sys.exit("usage: ADMIN_TOKEN=<token> measure_latency.py URL N")
url, n = sys.argv[1].rstrip("/"), int(sys.argv[2])
token = os.environ["ADMIN_TOKEN"]
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
