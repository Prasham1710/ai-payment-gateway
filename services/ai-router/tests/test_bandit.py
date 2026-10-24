import random

from app.bandit import DiscountedThompsonBandit


def first_choice_share(bandit, winner, providers, method="UPI", rounds=500):
    wins = 0
    for _ in range(rounds):
        ranked = sorted(providers, key=lambda p: bandit.sample(p, method), reverse=True)
        wins += ranked[0] == winner
    return wins / rounds


def feed(bandit, provider, success_rate, n, rng, method="UPI"):
    for _ in range(n):
        bandit.update(provider, method, rng.random() < success_rate)


def test_traffic_shifts_away_from_a_degraded_rail_and_comes_back():
    rng = random.Random(1)
    bandit = DiscountedThompsonBandit(discount=0.98, rng=random.Random(2))
    providers = ["provider-a", "provider-b", "provider-c"]
    feed(bandit, "provider-a", 0.96, 150, rng)
    feed(bandit, "provider-b", 0.90, 150, rng)
    feed(bandit, "provider-c", 0.85, 150, rng)
    assert first_choice_share(bandit, "provider-a", providers) > 0.6

    feed(bandit, "provider-a", 0.30, 60, rng)       # provider-a starts failing
    assert first_choice_share(bandit, "provider-a", providers) < 0.05
    assert bandit.mean("provider-a", "UPI") < 0.6

    feed(bandit, "provider-a", 0.97, 150, rng)      # and recovers
    assert first_choice_share(bandit, "provider-a", providers) > 0.5


def test_arms_are_per_payment_method():
    bandit = DiscountedThompsonBandit(rng=random.Random(3))
    for _ in range(100):
        bandit.update("provider-a", "CARD", False)
        bandit.update("provider-a", "upi", True)
    assert bandit.mean("provider-a", "UPI") > 0.9
    assert bandit.mean("provider-a", "card") < 0.1


def test_unseen_arm_uses_the_prior_and_arm_count_is_bounded():
    bandit = DiscountedThompsonBandit(max_arms=2)
    assert bandit.mean("provider-x", "UPI") == 0.5
    for p in ("a", "b", "c"):
        bandit.update(p, "UPI", True)
    assert len(bandit.stats()) == 2


def test_an_avoided_rail_is_explored_again_after_its_evidence_fades():
    now = [0.0]
    rng = random.Random(4)
    bandit = DiscountedThompsonBandit(discount=0.98, half_life=30, rng=random.Random(5), clock=lambda: now[0])
    providers = ["provider-a", "provider-b"]
    feed(bandit, "provider-a", 0.2, 80, rng)     # provider-a had a bad spell
    feed(bandit, "provider-b", 0.88, 80, rng)
    assert first_choice_share(bandit, "provider-a", providers) < 0.02

    now[0] += 120                                 # four half-lives without trying provider-a
    feed(bandit, "provider-b", 0.88, 5, rng)       # provider-b keeps getting traffic
    assert first_choice_share(bandit, "provider-a", providers) > 0.15
    arm = next(a for a in bandit.stats() if a.provider == "provider-a")
    assert arm.alpha + arm.beta < 6                # the old evidence is now worth only a few results

    feed(bandit, "provider-a", 0.96, 40, rng)       # it is tried again and has recovered
    assert first_choice_share(bandit, "provider-a", providers) > 0.4
