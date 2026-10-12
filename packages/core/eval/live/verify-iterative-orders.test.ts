import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("held-out iterative workflow oracle", () => {
  it("accepts the documented two-argument order API before shipping is introduced", () => {
    const probe = String.raw`
import importlib.util, sys
spec = importlib.util.spec_from_file_location("oracle", sys.argv[1])
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)

class Api:
    def call(self, op, **args):
        if op == "create":
            return self.create_order(**args)
        if op == "discount":
            if args["code"] != "WELCOME10":
                raise ValueError("unknown code")
            return {**args["order"], "total_cents": 403}
        raise ValueError(op)

    def create_order(self, customer, items):
        if len(items) > 100:
            raise ValueError("too many items")
        return {"customer": customer,
                "total_cents": sum(price * qty for _, price, qty in items),
                "line_count": len(items)}

oracle.c1(Api(), {})
oracle.c2(Api(), {})
print("early API checks passed")
`;
    const result = execFileSync(
      "python3",
      ["-c", probe, path.join(here, "verify-iterative-orders.py")],
      { encoding: "utf8" },
    );
    expect(result.trim()).toBe("early API checks passed");
  });

  it("rejects wrong composed totals and lost early-session fields while keeping core separate", () => {
    const probe = String.raw`
import importlib.util, sys
spec = importlib.util.spec_from_file_location("oracle", sys.argv[1])
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)
facts = {"status": "STATUS-ONE", "channel": "CHANNEL-ONE",
         "region": "REGION-ONE", "warehouse": "WH-ONE"}

class Api:
    def __init__(self, incorrect_total=False, wrong_initial_status=False):
        self.incorrect_total = incorrect_total
        self.wrong_initial_status = wrong_initial_status

    def call(self, op, **args):
        if op == "create":
            total = sum(price * qty for _, price, qty in args["items"])
            shipping = 799 if args["shipping_zone"] == "REMOTE" else 0
            return {"customer": args["customer"], "total_cents": total,
                    "shipping_cents": shipping, "grand_total_cents": total + shipping,
                    "status": "OTHER" if self.wrong_initial_status else facts["status"],
                    "channel": facts["channel"], "region": facts["region"],
                    "warehouse": facts["warehouse"]}
        if op == "discount":
            order = args["order"]
            discounted = order["total_cents"] * 9 // 10
            return {**order, "total_cents": discounted,
                    "grand_total_cents": (order["grand_total_cents"] if self.incorrect_total
                                          else discounted + order["shipping_cents"])}
        if op == "discounted_quote":
            total = sum(price * qty for _, price, qty in args["items"])
            shipping = 799 if args["shipping_zone"] == "REMOTE" else 0
            return {"subtotal_cents": total * 9 // 10, "shipping_cents": shipping,
                    "grand_total_cents": total * 9 // 10 + shipping}
        if op == "fulfill":
            return {**args["order"], "status": "FULFILLED",
                    "tracking_code": args["tracking_code"]}
        raise ValueError(op)

for check in (oracle.c6, oracle.c7, oracle.c8):
    check(Api(), facts)
try:
    oracle.c6(Api(incorrect_total=True), facts)
except AssertionError:
    pass
else:
    raise AssertionError("c6 accepted a stale grand total")
oracle.c8_core(Api(wrong_initial_status=True), facts)
try:
    oracle.c8(Api(wrong_initial_status=True), facts)
except AssertionError:
    pass
else:
    raise AssertionError("strict c8 accepted a lost initial status")
assert len(oracle.CHECKPOINTS) == 8
assert len(oracle.CORE_CHECKPOINTS) == 8
print("hidden oracle checks passed")
`;
    const result = execFileSync(
      "python3",
      ["-c", probe, path.join(here, "verify-iterative-orders.py")],
      { encoding: "utf8" },
    );
    expect(result.trim()).toBe("hidden oracle checks passed");
  });
});
