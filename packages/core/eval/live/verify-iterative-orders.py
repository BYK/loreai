#!/usr/bin/env python3
"""Held-out oracle for the iterative orderkit benchmark.

The parent process holds facts; an env-scrubbed child imports agent code and only
receives behavior requests. Agent code therefore never shares a process or an
environment with hidden values.
"""

import argparse
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path


def fail(message):
    raise AssertionError(message)


WORKER = r'''
import importlib.util, json, sys
from pathlib import Path
source = Path(sys.argv[1]) / "src" / "orders.py"
if not source.exists():
    raise SystemExit(json.dumps({"error": "src/orders.py was not created"}))
spec = importlib.util.spec_from_file_location("orders", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def mapping(value):
    if isinstance(value, dict): return value
    if hasattr(value, "__dict__"): return value.__dict__
    raise TypeError("public API must return a mapping or named object")
for line in sys.stdin:
    try:
        req = json.loads(line)
        op = req["op"]
        if op == "create":
            try: value = module.create_order(**req["args"])
            except TypeError:
                args = dict(req["args"]); args.pop("shipping_zone", None)
                value = module.create_order(**args)
            out = mapping(value)
        elif op == "discount": out = mapping(module.apply_discount(**req["args"]))
        elif op == "quote": out = mapping(module.quote_order(**req["args"]))
        else: raise ValueError("unknown operation")
        print(json.dumps({"ok": True, "value": out}), flush=True)
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}), flush=True)
'''


class AgentApi:
    def __init__(self, project):
        image = os.environ.get("LORE_EVAL_AGENT_IMAGE", "python:3.12-alpine")
        self.child = subprocess.Popen(
            ["docker", "run", "--rm", "--network", "none", "-i",
             "-e", "PYTHONDONTWRITEBYTECODE=1",
             "-v", f"{Path(project).resolve()}:/project:ro",
             image, "python3", "-c", WORKER, "/project"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
        )

    def call(self, op, **args):
        self.child.stdin.write(json.dumps({"op": op, "args": args}) + "\n")
        self.child.stdin.flush()
        response = self.child.stdout.readline()
        if not response:
            fail("agent API process exited")
        data = json.loads(response)
        if not data.get("ok"):
            raise RuntimeError(data.get("error", "agent API failed"))
        return data["value"]

    def close(self):
        self.child.terminate()
        try:
            self.child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.child.kill()
            self.child.wait()


def create(api, customer="acme", items=None, shipping_zone="LOCAL"):
    if items is None:
        items = [("sku-1", 199, 2), ("sku-2", 50, 1)]
    return api.call("create", customer=customer, items=items, shipping_zone=shipping_zone)


def c1(api, facts):
    result = create(api)
    assert result["customer"] == "acme"
    assert result["total_cents"] == 448
    assert result["line_count"] == 2
    try:
        create(api, items=[("x", 1, 1)] * 101)
    except Exception:
        return
    fail("create_order must reject more than 100 line items")


def c2(api, facts):
    order = create(api)
    discounted = api.call("discount", order=order, code="WELCOME10")
    assert discounted["total_cents"] == 403
    assert order["total_cents"] == 448
    try:
        api.call("discount", order=order, code="UNKNOWN")
    except Exception:
        return
    fail("unknown discount code must raise")


def c3(api, facts):
    remote = create(api, shipping_zone="REMOTE")
    assert remote["shipping_cents"] == 799
    assert remote["grand_total_cents"] == remote["total_cents"] + 799
    assert create(api, shipping_zone="LOCAL")["shipping_cents"] == 0


def c4(api, facts):
    quote = api.call("quote", customer="acme", items=[("sku-1", 200, 1)], shipping_zone="REMOTE")
    assert quote == {"subtotal_cents": 200, "shipping_cents": 799, "grand_total_cents": 999}
    assert create(api, items=[("sku-1", 200, 1)], shipping_zone="REMOTE")["grand_total_cents"] == 999


def c5(api, facts):
    order = create(api, shipping_zone="REMOTE")
    assert order["grand_total_cents"] == 1247
    for key in ("status", "channel", "region", "warehouse"):
        assert order[key] == facts[key], f"{key} must use the earlier project value"


def c5_core(api, facts):
    order = create(api, shipping_zone="REMOTE")
    assert order["grand_total_cents"] == 1247
    for key in ("status", "channel", "region", "warehouse"):
        assert key in order, f"{key} must be part of the public result"


CHECKPOINTS = [c1, c2, c3, c4, c5]
CORE_CHECKPOINTS = [c1, c2, c3, c4, c5_core]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--scope", choices=["strict", "isolated", "core"], required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--agent-image", required=True)
    args = parser.parse_args()
    encoded = os.environ.get("LORE_EVAL_FACTS")
    if not encoded:
        fail("verifier facts were not provided")
    facts = json.loads(encoded)
    index = int(args.checkpoint.removeprefix("c")) - 1
    if not 0 <= index < len(CHECKPOINTS): fail(f"unknown checkpoint {args.checkpoint!r}")
    checks = CORE_CHECKPOINTS if args.scope == "core" else CHECKPOINTS
    selected = checks[: index + 1] if args.scope in ("strict", "core") else [checks[index]]
    os.environ["LORE_EVAL_AGENT_IMAGE"] = args.agent_image
    api = AgentApi(args.project)
    try:
        for check in selected: check(api, facts)
    finally:
        api.close()
    print(json.dumps({"pass": True}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"pass": False, "error": str(error)}))
        raise SystemExit(1)
