"""Discounted Thompson sampling over (provider, payment method) arms.

Each arm keeps a Beta(alpha, beta) belief about its success rate. Ranking samples from every
candidate's belief, so good rails get most traffic while uncertain ones are still explored.

Evidence is forgotten in two ways, so the router keeps up with rails that change:
- per update: old evidence is discounted before each new result (busy arms track the last ~1/(1-d) results);
- over time: evidence halves every ``half_life`` seconds. A rail that lost its traffic after a bad
  spell drifts back towards "unknown", gets explored again, and wins its traffic back once it recovers.
"""

import random
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass


@dataclass
class ArmStats:
    provider: str
    method: str
    alpha: float
    beta: float
    observations: int

    @property
    def mean(self) -> float:
        return self.alpha / (self.alpha + self.beta)


class DiscountedThompsonBandit:
    def __init__(self, discount: float = 0.98, half_life: float = 120.0, prior_alpha: float = 1.0,
                 prior_beta: float = 1.0, max_arms: int = 1000, rng: random.Random | None = None,
                 clock: Callable[[], float] = time.monotonic):
        if not 0 < discount <= 1:
            raise ValueError("discount must be in (0, 1]")
        if half_life <= 0:
            raise ValueError("half_life must be positive")
        self._discount = discount
        self._half_life = half_life
        self._prior = (prior_alpha, prior_beta)
        self._max_arms = max_arms
        self._rng = rng or random.Random()
        self._clock = clock
        self._arms: dict[tuple[str, str], list[float]] = {}   # key -> [alpha, beta, observations, updated_at]
        self._lock = threading.Lock()

    def sample(self, provider: str, method: str) -> float:
        with self._lock:
            alpha, beta = self._belief(self._key(provider, method))
            return self._rng.betavariate(alpha, beta)

    def mean(self, provider: str, method: str) -> float:
        with self._lock:
            alpha, beta = self._belief(self._key(provider, method))
            return alpha / (alpha + beta)

    def update(self, provider: str, method: str, success: bool) -> None:
        key = self._key(provider, method)
        with self._lock:
            if key not in self._arms and len(self._arms) >= self._max_arms:
                return
            alpha, beta = self._belief(key)
            prior_alpha, prior_beta = self._prior
            alpha = prior_alpha + self._discount * (alpha - prior_alpha) + (1 if success else 0)
            beta = prior_beta + self._discount * (beta - prior_beta) + (0 if success else 1)
            observations = self._arms[key][2] + 1 if key in self._arms else 1
            self._arms[key] = [alpha, beta, observations, self._clock()]

    def stats(self) -> list[ArmStats]:
        with self._lock:
            result = []
            for key in sorted(self._arms):
                alpha, beta = self._belief(key)
                result.append(ArmStats(key[0], key[1], alpha, beta, int(self._arms[key][2])))
            return result

    def _belief(self, key: tuple[str, str]) -> tuple[float, float]:
        """Current (alpha, beta) with time decay applied; the prior for unseen arms."""
        arm = self._arms.get(key)
        prior_alpha, prior_beta = self._prior
        if arm is None:
            return prior_alpha, prior_beta
        alpha, beta, _, updated_at = arm
        fade = 0.5 ** (max(self._clock() - updated_at, 0.0) / self._half_life)
        return prior_alpha + fade * (alpha - prior_alpha), prior_beta + fade * (beta - prior_beta)

    @staticmethod
    def _key(provider: str, method: str) -> tuple[str, str]:
        return provider, method.upper()
