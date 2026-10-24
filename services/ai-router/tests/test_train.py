import csv
import random

import pytest

from train import load_rows, train


def write_attempts(path, rates, n=1500, seed=5):
    rng = random.Random(seed)
    with open(path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["provider", "payment_method", "amount", "hour", "outcome"])
        for _ in range(n):
            provider = rng.choice(list(rates))
            outcome = "SUCCESS" if rng.random() < rates[provider] else "DECLINED"
            writer.writerow([provider, rng.choice(["UPI", "CARD", "NETBANKING"]), rng.randint(100, 500000), rng.randrange(24), outcome])
        writer.writerow(["provider-a", "UPI", 1000, 3, "UNKNOWN"])   # skipped


def test_model_learns_which_rail_succeeds_more(tmp_path):
    path = tmp_path / "attempts.csv"
    write_attempts(path, {"provider-a": 0.95, "provider-b": 0.55})
    rows = load_rows(str(path))
    assert len(rows) == 1500

    artifact = train(rows)
    from app.features import encode
    model = artifact["model"]
    p_a = model.predict_proba([encode("provider-a", "UPI", 50000, 12, artifact["providers"])])[0][1]
    p_b = model.predict_proba([encode("provider-b", "UPI", 50000, 12, artifact["providers"])])[0][1]
    assert p_a > p_b + 0.2
    assert artifact["metrics"]["observed_success_by_provider"]["provider-a"] > 0.9


def test_refuses_too_little_data(tmp_path):
    path = tmp_path / "attempts.csv"
    write_attempts(path, {"provider-a": 0.9}, n=10)
    with pytest.raises(ValueError):
        train(load_rows(str(path)))
