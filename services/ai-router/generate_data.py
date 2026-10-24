"""Generate labelled training data by charging the Go bank simulator directly.

Each row is one charge on one rail with a random payment method, amount and hour. The outcome
comes from the simulator's per-rail success rate and kill switch, so shape the data with its
chaos API first, for example:

  curl "localhost:8081/api/v1/chaos/success-rate?provider_id=provider-c&rate=0.6"
  python generate_data.py --count 3000 --out data/attempts.csv

Uses only the standard library, so it also runs outside the virtualenv.
"""

import argparse
import csv
import json
import random
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

METHODS = ("UPI", "CARD", "NETBANKING")


def charge(simulator: str, provider: str, method: str, amount_paise: int, index: int) -> str:
    body = {"transaction_id": f"tx_train_{index}_{random.getrandbits(32):08x}", "provider_id": provider,
            "amount": amount_paise / 100, "currency": "INR", "payment_method": method}
    if method == "UPI":
        body["customer_vpa"] = "trainer@okaxis"   # not a fixed-outcome test VPA
    request = urllib.request.Request(f"{simulator}/api/v1/bank/charge", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            status = json.load(response).get("status", "")
    except urllib.error.HTTPError as e:
        if e.code == 503:
            return "UNAVAILABLE"
        status = json.load(e).get("status", "")
    return "SUCCESS" if status == "SUCCESS" else "DECLINED"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--simulator", default="http://localhost:8081")
    parser.add_argument("--providers", default="provider-a,provider-b,provider-c")
    parser.add_argument("--count", type=int, default=3000)
    parser.add_argument("--workers", type=int, default=32)
    parser.add_argument("--out", default="data/attempts.csv")
    args = parser.parse_args(argv)

    providers = args.providers.split(",")
    plan = [(i, random.choice(providers), random.choice(METHODS), random.randint(100, 5_000_000), random.randrange(24))
            for i in range(args.count)]
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        outcomes = list(pool.map(lambda p: charge(args.simulator, p[1], p[2], p[3], p[0]), plan))

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["provider", "payment_method", "amount", "hour", "outcome"])
        for (_, provider, method, amount, hour), outcome in zip(plan, outcomes):
            writer.writerow([provider, method, amount, hour, outcome])
    print(f"Wrote {len(plan)} attempts to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
