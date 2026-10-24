"""Train the routing model: P(success | provider, payment method, amount, hour of day).

Input: a CSV of past provider attempts with columns provider, payment_method, amount (paise),
hour (0-23) and outcome (SUCCESS, DECLINED, UNAVAILABLE or UNKNOWN; UNKNOWN rows are skipped).
Produce one from the gateway's database:

  psql -d payment_db -c "\\copy (select t.provider_id as provider, p.method as payment_method, t.amount,
    extract(hour from t.created_at at time zone 'Asia/Kolkata')::int as hour, t.status as outcome
    from transactions t join payments p on p.id = t.payment_id where t.status <> 'UNKNOWN')
    to 'data/attempts.csv' csv header"

or synthesize one with generate_data.py. Then:

  python train.py data/attempts.csv --out models/routing-model.joblib
  curl -X POST localhost:8000/v1/model/reload
"""

import argparse
import csv
import sys
import warnings
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, roc_auc_score
from sklearn.model_selection import train_test_split

from app.features import METHODS, encode

OUTCOMES = {"SUCCESS", "DECLINED", "UNAVAILABLE"}


def load_rows(path: str) -> list[dict]:
    rows = []
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            outcome = row["outcome"].strip().upper()
            method = row["payment_method"].strip().upper()
            if outcome not in OUTCOMES or method not in METHODS:
                continue
            rows.append({"provider": row["provider"].strip(), "method": method, "amount": int(float(row["amount"])),
                         "hour": int(row["hour"]) % 24, "success": outcome == "SUCCESS"})
    return rows


def train(rows: list[dict], seed: int = 7) -> dict:
    if len(rows) < 50:
        raise ValueError(f"need at least 50 labelled attempts to train, got {len(rows)}")
    providers = sorted({r["provider"] for r in rows})
    x = np.array([encode(r["provider"], r["method"], r["amount"], r["hour"], providers) for r in rows])
    y = np.array([1 if r["success"] else 0 for r in rows])
    if len(set(y)) < 2:
        raise ValueError("training data needs both successful and failed attempts")

    x_train, x_test, y_train, y_test = train_test_split(x, y, test_size=0.2, random_state=seed, stratify=y)
    # Some scipy releases warn about an "iprint" option that scikit-learn's lbfgs call still passes; harmless.
    warnings.filterwarnings("ignore", message="Unknown solver options")
    model = LogisticRegression(max_iter=1000)
    model.fit(x_train, y_train)
    probabilities = model.predict_proba(x_test)[:, 1]
    metrics = {
        "rows": len(rows),
        "test_accuracy": round(float(accuracy_score(y_test, probabilities >= 0.5)), 4),
        "test_auc": round(float(roc_auc_score(y_test, probabilities)), 4) if len(set(y_test)) > 1 else None,
    }

    # Refit on everything for the artifact that will be served.
    model.fit(x, y)
    observed = defaultdict(lambda: [0, 0])
    for r in rows:
        observed[r["provider"]][0] += r["success"]
        observed[r["provider"]][1] += 1
    metrics["observed_success_by_provider"] = {p: round(s / n, 4) for p, (s, n) in sorted(observed.items())}
    return {
        "model": model,
        "providers": providers,
        "version": datetime.now(timezone.utc).strftime("lr-%Y%m%dT%H%M%SZ"),
        "metrics": metrics,
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("csv", help="labelled attempts (see above)")
    parser.add_argument("--out", default="models/routing-model.joblib")
    args = parser.parse_args(argv)

    artifact = train(load_rows(args.csv))
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(artifact, args.out)
    print(f"Saved {artifact['version']} to {args.out}")
    for key, value in artifact["metrics"].items():
        print(f"  {key}: {value}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
