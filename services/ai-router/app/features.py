"""Feature encoding shared by training (train.py) and serving (app.model), so both always agree."""

import math

METHODS = ("UPI", "CARD", "NETBANKING")


def encode(provider: str, method: str, amount_paise: int, hour: int, providers: list[str]) -> list[float]:
    """One row of model features.

    provider and method one-hot, their interaction (a rail can be good at UPI and bad at cards),
    log-scaled amount and the hour of day on a circle (23:00 is close to 00:00).
    """
    method = method.upper()
    provider_hot = [1.0 if provider == p else 0.0 for p in providers]
    method_hot = [1.0 if method == m else 0.0 for m in METHODS]
    interaction = [p * m for p in provider_hot for m in method_hot]
    amount_rupees = max(amount_paise, 0) / 100.0
    angle = 2 * math.pi * (hour % 24) / 24
    return provider_hot + method_hot + interaction + [math.log10(amount_rupees + 1), math.sin(angle), math.cos(angle)]
