"""Smart routing demo: watch the gateway move traffic away from a degrading bank rail and back.

Needs the gateway (:8080), the bank simulator (:8081) and the AI router (:8000) running. Runs
payments through the real checkout API in three phases and prints which rail each payment
tried first:

  1. all rails healthy
  2. provider-a's success rate drops to 20% (via the simulator's chaos API)
  3. provider-a recovers. The router stopped sending it traffic in phase 2, so it only finds out
     once its memory of the bad spell fades (AI_ROUTER_HALF_LIFE_SECONDS) and it explores again.
     The demo waits --fade-wait seconds first; start the router with a short half-life to keep it quick:

  AI_ROUTER_HALF_LIFE_SECONDS=15 uvicorn app.main:app --port 8000
  python demo.py --payments 60 --fade-wait 45

Uses only the standard library.
"""

import argparse
import base64
import json
import random
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor


class Gateway:
    def __init__(self, base: str):
        self.base = base
        self.auth = None

    def call(self, method: str, path: str, body=None):
        request = urllib.request.Request(self.base + path, method=method,
                                         data=json.dumps(body).encode() if body is not None else None,
                                         headers={"Content-Type": "application/json"})
        if self.auth:
            token = base64.b64encode(f"{self.auth[0]}:{self.auth[1]}".encode()).decode()
            request.add_header("Authorization", "Basic " + token)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as e:
            return json.load(e)


def pay_once(gateway: Gateway, key_id: str) -> str | None:
    order = gateway.call("POST", "/v1/orders", {"amount": random.randint(10_000, 500_000)})
    result = gateway.call("POST", "/v1/checkout/payments",
                          {"key_id": key_id, "order_id": order["id"], "method": "upi", "vpa": "demo.customer@okaxis"})
    payment_id = result.get("payment_id") or result.get("error", {}).get("metadata", {}).get("payment_id")
    if not payment_id:
        return None
    attempts = gateway.call("GET", f"/v1/payments/{payment_id}/attempts")["items"]
    return attempts[0]["provider"] if attempts else None


def run_phase(gateway: Gateway, key_id: str, name: str, payments: int) -> None:
    with ThreadPoolExecutor(max_workers=4) as pool:
        firsts = [p for p in pool.map(lambda _: pay_once(gateway, key_id), range(payments)) if p]
    counts = Counter(firsts)
    shares = ", ".join(f"{p}: {counts[p] * 100 // max(len(firsts), 1)}%" for p in sorted(counts))
    print(f"{name:<38} first rail tried -> {shares}")


def set_success_rate(simulator: str, provider: str, rate: float) -> None:
    urllib.request.urlopen(f"{simulator}/api/v1/chaos/success-rate?provider_id={provider}&rate={rate}", timeout=10).read()


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--gateway", default="http://localhost:8080")
    parser.add_argument("--simulator", default="http://localhost:8081")
    parser.add_argument("--router", default="http://localhost:8000")
    parser.add_argument("--payments", type=int, default=60, help="payments per phase")
    parser.add_argument("--fade-wait", type=float, default=45, help="seconds to wait after provider-a recovers")
    args = parser.parse_args(argv)

    gateway = Gateway(args.gateway)
    merchant = gateway.call("POST", "/v1/merchants", {"name": "Routing Demo", "email": f"routing-demo-{random.getrandbits(32):x}@example.com"})
    gateway.auth = (merchant["key_id"], merchant["key_secret"])

    try:
        run_phase(gateway, merchant["key_id"], "1. all rails healthy", args.payments)
        set_success_rate(args.simulator, "provider-a", 0.2)
        run_phase(gateway, merchant["key_id"], "2. provider-a degraded to 20% success", args.payments)
        set_success_rate(args.simulator, "provider-a", 0.96)
        print(f"   (provider-a recovered; waiting {args.fade_wait:.0f}s for the router's memory of it to fade)")
        time.sleep(args.fade_wait)
        run_phase(gateway, merchant["key_id"], "3. provider-a recovered", args.payments * 2)
    finally:
        set_success_rate(args.simulator, "provider-a", 0.96)

    stats = json.load(urllib.request.urlopen(f"{args.router}/v1/stats", timeout=10))
    print("\nAI router beliefs (UPI):")
    for arm in stats["arms"]:
        if arm["payment_method"] == "UPI":
            print(f"  {arm['provider']}: expected success {arm['expected_success']:.0%} over {arm['observations']} attempts")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
