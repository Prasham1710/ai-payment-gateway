"""AI routing service for the payment orchestrator.

POST /v1/route     -> provider rails ordered by expected success for this payment
POST /v1/feedback  -> outcome of one attempt on one rail (updates the bandit)
GET  /v1/stats     -> current beliefs per (provider, method)
POST /v1/model/reload, GET /health

Internal service: bind it to localhost / a private network; it has no authentication.
"""

import logging
import os
import random
import re
from datetime import datetime
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, field_validator

from app.bandit import DiscountedThompsonBandit
from app.features import METHODS
from app.model import SuccessModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

PROVIDER_PATTERN = r"^[a-zA-Z0-9_.\-]{1,30}$"


class RouteRequest(BaseModel):
    providers: list[str] = Field(min_length=1, max_length=20, description="Candidate rails, in the fallback order")
    payment_method: str
    amount: int = Field(gt=0, description="In paise")
    currency: str = "INR"
    hour: int | None = Field(default=None, ge=0, le=23, description="Hour of day in IST; defaults to now")

    @field_validator("providers")
    @classmethod
    def valid_providers(cls, providers: list[str]) -> list[str]:
        for provider in providers:
            if not re.match(PROVIDER_PATTERN, provider):
                raise ValueError(f"invalid provider id: {provider!r}")
        return list(dict.fromkeys(providers))   # drop duplicates, keep order

    @field_validator("payment_method")
    @classmethod
    def valid_method(cls, method: str) -> str:
        if method.upper() not in METHODS:
            raise ValueError(f"payment_method must be one of {', '.join(METHODS)}")
        return method.upper()


class RouteResponse(BaseModel):
    providers: list[str]
    scores: dict[str, float]
    expected_success: dict[str, float]
    strategy: str
    model_version: str | None


class FeedbackRequest(BaseModel):
    provider: str = Field(pattern=PROVIDER_PATTERN)
    payment_method: str
    outcome: Literal["success", "declined", "unavailable", "unknown"]
    amount: int | None = Field(default=None, gt=0)
    latency_ms: int | None = Field(default=None, ge=0)

    @field_validator("payment_method")
    @classmethod
    def valid_method(cls, method: str) -> str:
        if method.upper() not in METHODS:
            raise ValueError(f"payment_method must be one of {', '.join(METHODS)}")
        return method.upper()


def create_app(model_path: str | None = None, discount: float | None = None, half_life: float | None = None,
               model_weight: float | None = None, timezone: str | None = None, seed: int | None = None) -> FastAPI:
    model_path = model_path if model_path is not None else os.getenv("AI_ROUTER_MODEL_PATH", "models/routing-model.joblib")
    discount = discount if discount is not None else float(os.getenv("AI_ROUTER_DISCOUNT", "0.98"))
    half_life = half_life if half_life is not None else float(os.getenv("AI_ROUTER_HALF_LIFE_SECONDS", "120"))
    model_weight = model_weight if model_weight is not None else float(os.getenv("AI_ROUTER_MODEL_WEIGHT", "0.3"))
    zone = ZoneInfo(timezone or os.getenv("AI_ROUTER_TIMEZONE", "Asia/Kolkata"))

    bandit = DiscountedThompsonBandit(discount=discount, half_life=half_life, rng=random.Random(seed))
    model = SuccessModel(model_path)
    app = FastAPI(title="AI Router", version="1.0.0")
    app.state.bandit = bandit
    app.state.model = model

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "model_version": model.version}

    @app.post("/v1/route", response_model=RouteResponse)
    def route(req: RouteRequest) -> RouteResponse:
        hour = req.hour if req.hour is not None else datetime.now(zone).hour
        scores: dict[str, float] = {}
        expected: dict[str, float] = {}
        strategy = "thompson_sampling"
        for provider in req.providers:
            sampled = bandit.sample(provider, req.payment_method)
            recent = bandit.mean(provider, req.payment_method)
            predicted = model.predict(provider, req.payment_method, req.amount, hour)
            if predicted is None:
                scores[provider] = sampled
                expected[provider] = recent
            else:
                # The model knows the usual pattern; the bandit reacts to what is happening right now.
                strategy = "thompson_sampling+model"
                scores[provider] = model_weight * predicted + (1 - model_weight) * sampled
                expected[provider] = model_weight * predicted + (1 - model_weight) * recent
        ordered = sorted(req.providers, key=lambda p: scores[p], reverse=True)
        return RouteResponse(providers=ordered, scores={p: round(s, 4) for p, s in scores.items()},
                             expected_success={p: round(e, 4) for p, e in expected.items()},
                             strategy=strategy, model_version=model.version)

    @app.post("/v1/feedback")
    def feedback(req: FeedbackRequest) -> dict:
        bandit.update(req.provider, req.payment_method, req.outcome == "success")
        return {"ok": True}

    @app.get("/v1/stats")
    def stats() -> dict:
        return {
            "model_version": model.version,
            "model_metrics": model.metrics,
            "arms": [{"provider": a.provider, "payment_method": a.method, "alpha": round(a.alpha, 3),
                      "beta": round(a.beta, 3), "expected_success": round(a.mean, 4), "observations": a.observations}
                     for a in bandit.stats()],
        }

    @app.post("/v1/model/reload")
    def reload_model() -> dict:
        try:
            loaded = model.reload()
        except Exception as e:   # corrupt or incompatible artifact: keep serving without it
            raise HTTPException(status_code=500, detail=f"Could not load model: {e}") from e
        return {"loaded": loaded, "model_version": model.version}

    return app


app = create_app()
