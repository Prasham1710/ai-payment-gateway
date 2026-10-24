import csv
import random

import joblib
from fastapi.testclient import TestClient

from app.main import create_app
from train import load_rows, train

PROVIDERS = ["provider-a", "provider-b", "provider-c"]


def client(model_path="does-not-exist.joblib", **kwargs):
    return TestClient(create_app(model_path=model_path, seed=11, **kwargs))


def test_route_returns_every_candidate_once():
    c = client()
    body = c.post("/v1/route", json={"providers": PROVIDERS + ["provider-a"], "payment_method": "upi", "amount": 50000}).json()
    assert sorted(body["providers"]) == PROVIDERS
    assert body["strategy"] == "thompson_sampling"
    assert body["model_version"] is None


def test_feedback_moves_traffic_to_the_healthy_rail():
    c = client()
    for _ in range(80):
        c.post("/v1/feedback", json={"provider": "provider-a", "payment_method": "UPI", "outcome": "unavailable"})
        c.post("/v1/feedback", json={"provider": "provider-b", "payment_method": "UPI", "outcome": "success"})
    firsts = [c.post("/v1/route", json={"providers": PROVIDERS, "payment_method": "UPI", "amount": 1000}).json()["providers"][0]
              for _ in range(50)]
    assert firsts.count("provider-b") > 40
    arms = {a["provider"]: a for a in c.get("/v1/stats").json()["arms"]}
    assert arms["provider-a"]["expected_success"] < 0.1
    assert arms["provider-b"]["observations"] == 80


def test_invalid_requests_are_rejected():
    c = client()
    assert c.post("/v1/route", json={"providers": [], "payment_method": "UPI", "amount": 100}).status_code == 422
    assert c.post("/v1/route", json={"providers": PROVIDERS, "payment_method": "CASH", "amount": 100}).status_code == 422
    assert c.post("/v1/route", json={"providers": ["bad id!"], "payment_method": "UPI", "amount": 100}).status_code == 422
    assert c.post("/v1/feedback", json={"provider": "provider-a", "payment_method": "UPI", "outcome": "maybe"}).status_code == 422


def test_trained_model_is_blended_in_and_can_be_reloaded(tmp_path):
    rng = random.Random(9)
    data = tmp_path / "attempts.csv"
    with open(data, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["provider", "payment_method", "amount", "hour", "outcome"])
        for _ in range(1200):
            p = rng.choice(PROVIDERS)
            rate = {"provider-a": 0.5, "provider-b": 0.97, "provider-c": 0.6}[p]
            w.writerow([p, "UPI", 50000, 10, "SUCCESS" if rng.random() < rate else "DECLINED"])
    model_path = tmp_path / "model.joblib"

    c = client(model_path=str(model_path), model_weight=1.0)
    assert c.post("/v1/model/reload").json() == {"loaded": False, "model_version": None}
    joblib.dump(train(load_rows(str(data))), model_path)
    assert c.post("/v1/model/reload").json()["loaded"] is True

    body = c.post("/v1/route", json={"providers": PROVIDERS, "payment_method": "UPI", "amount": 50000, "hour": 10}).json()
    assert body["strategy"] == "thompson_sampling+model"
    assert body["providers"][0] == "provider-b"
    assert body["expected_success"]["provider-b"] > 0.9
    assert c.get("/health").json()["model_version"] == body["model_version"]
