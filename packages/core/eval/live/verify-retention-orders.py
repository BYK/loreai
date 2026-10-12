#!/usr/bin/env python3
"""Behavioral retention oracle without exposing facts to agent code."""

import json
import os
import subprocess
import sys
from pathlib import Path


WORKER = r'''
import importlib.util, json, sys
from pathlib import Path
source = Path("/project/src/orders_v2.py")
if not source.exists(): raise SystemExit(json.dumps({"error": "src/orders_v2.py was not created"}))
spec = importlib.util.spec_from_file_location("orders_v2", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
for line in sys.stdin:
    try:
        req = json.loads(line)
        value = module.create_order("acme", [("sku", 199, 2)])
        order = value if isinstance(value, dict) else value.__dict__
        print(json.dumps({"ok": True, "order": order}), flush=True)
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}), flush=True)
'''


def main():
    project = Path(sys.argv[1]).resolve()
    only = sys.argv[2] if len(sys.argv) > 2 else None
    facts = json.loads(os.environ["LORE_EVAL_FACTS"])
    image = os.environ.get("LORE_EVAL_AGENT_IMAGE", "python:3.12-alpine")
    child = subprocess.Popen(
        ["docker", "run", "--rm", "--network", "none", "-i", "-v", f"{project}:/project:ro", image, "python3", "-c", WORKER],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        child.stdin.write("{}\n")
        child.stdin.flush()
        response = json.loads(child.stdout.readline())
    finally:
        child.terminate()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    if not response.get("ok"):
        raise AssertionError(response.get("error", "create_order failed"))
    order = response["order"]
    expected = {"customer": "acme", "total_cents": 398, "line_count": 1, **facts}
    for key, value in expected.items():
        if only and key != only:
            continue
        if order.get(key) != value:
            raise AssertionError(f"{key} did not match the established value")
    print(json.dumps({"pass": True}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"pass": False, "error": str(error)}))
        raise SystemExit(1)
