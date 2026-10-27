# Technology Rationale

Why each technology and major design choice was made, what the alternatives were, and what was tried and dropped along the way. Each section is a short decision record: context, decision, consequences.

---

## 1. Payment orchestrator: Java 17 and Spring Boot 3.5

**Context.** The orchestrator owns money movement: it needs reliable transactions, row locks, a mature HTTP stack and a circuit-breaker library.

**Decision.** Java 17 with Spring Boot 3.5, Spring Data JPA (Hibernate 6.6) and Resilience4j 2.3.

* `@Transactional` and `TransactionTemplate` keep each state change in one short database transaction; the code deliberately calls banks *between* transactions so no lock is held while a bank responds.
* Spring Data makes pessimistic locks (`SELECT … FOR UPDATE`) a one-line repository method, which is how orders, payments and refunds are protected from concurrent updates.
* Resilience4j provides per-rail circuit breakers configured in `application.yml` and inspectable at runtime.
* Static typing and `long` paise amounts avoid rounding and type-coercion mistakes in money code.

**Alternatives.** Node.js or Python would also work; Spring was chosen for its transaction management, JPA and Resilience4j integration. Spring Boot was upgraded from 3.2 to 3.5 to stay on a supported line.

**Consequences.** A JVM process with a slower start than the other services. Builds use the Maven Wrapper, so contributors need only a JDK.

---

## 2. Bank simulator: Go

**Context.** Testing failover, timeouts and reconciliation needs a "bank" whose behaviour can be changed while payments are running, and that behaves like a real bank in the ways that matter (records a charge on receipt, answers status enquiries, de-duplicates refunds).

**Decision.** A single-file Go service using only the standard library (`net/http`, `sync`).

* Each request runs in its own goroutine, so injected latency on one rail does not slow the others.
* A `sync.RWMutex` protects the rail profiles and the ledgers; request handling copies a rail's profile under the lock, so chaos changes never race with a charge in progress (the tests run with `-race`).
* Behaviour that the orchestrator depends on is explicit and tested: charges are recorded as `PENDING` on receipt, a killed rail answers 503 without recording a refund, refunds are idempotent per `refund_id` even under concurrent retries.

**Alternatives.** A mock inside the orchestrator's tests (that exists too: `FakeBankServer`), or a generic mock server. A separate process was preferred so the real HTTP failure modes (connection refused, timeouts, 503s) are exercised.

**Consequences.** The ledger is in memory and is lost on restart; the reconciler is designed for that (it only treats "not found" as final at the end of its window).

---

## 3. Database: PostgreSQL 16

**Context.** Payment state must be consistent and auditable; duplicate payments must be impossible.

**Decision.** PostgreSQL as the single system of record.

* ACID transactions and row-level locks serialize work on the same order, payment or refund.
* **Unique indexes enforce idempotency**: `(merchant_id, idempotency_key)` on `payments` and on `refunds`. The guarantee lives in the database, so it holds across threads, requests and restarts.
* The transactional outbox for webhooks lives in the same database, so an event is stored if and only if its change commits.
* Money is stored as `bigint` paise, which is exact and avoids decimal conversions in the API.

**Alternatives.** A document store would make multi-row invariants (reserve a refund amount *and* insert the refund) harder to guarantee. MySQL would also have worked.

**Consequences.** The background jobs assume one orchestrator instance; scaling out would need `SKIP LOCKED` claiming. Schema changes use Hibernate's `ddl-auto: update`, convenient in development but to be replaced by versioned migrations.

---

## 4. Idempotency without a distributed lock

**Context.** An early prototype planned to make payments idempotent with a Redis cache of responses plus a Redis-based distributed lock ("Redlock") per idempotency key.

**Decision.** Dropped in favour of the database: the order row lock plus the unique `(merchant_id, idempotency_key)` index, with an in-flight check (a second payment for an order is refused while one is still `created` and younger than 2 minutes).

**Why.** The database already has to record the payment; making it the arbiter removes a second system whose failure modes (lock expiry while a bank call is slow, cache and database disagreeing) would themselves need reconciling. A replay is answered from the stored payment, so the response is always consistent with the ledger.

**Consequences.** Redis is not needed for correctness. It stays in the compose file, reserved for velocity limits in the fraud-detection phase.

---

## 5. Failover rules: never retry an unknown outcome

**Decision.** Fail over only when the rail definitely did not process the charge (503, connection refused, request rejected, or skipped by an open circuit breaker). Stop on a decline. On a timeout or 502/504, ask the bank (status enquiry) and, if still unclear, report the payment failed and hand it to the reconciler.

**Why.** Retrying an unknown outcome on another rail is the classic way gateways double-charge customers. Treating "unknown" as its own state, writing every attempt before it is sent, and following up later turns a possible double charge into, at worst, a late authorization that is captured or refunded automatically.

---

## 6. Circuit breakers: Resilience4j with manual permission handling

**Decision.** One count-based breaker per rail (window 10, minimum 5 calls, 50% failure threshold, 5 s open). The orchestrator calls `tryAcquirePermission`, `onSuccess` and `onError` itself instead of wrapping the bank call in a decorator.

**Why.**

* The bank client never throws for a decline; it returns a classified outcome. Manual reporting lets the gateway count **declines as successes** (the rail worked) and only `UNAVAILABLE` / `UNKNOWN` as failures. Wrapped in a decorator, declines would either trip the breaker or need exception gymnastics.
* A skipped rail is recorded as a normal attempt (`CB_OPEN`), so the audit trail explains every routing decision.
* If writing the attempt row fails, the permission is released, so database problems are never blamed on a rail.

**Consequences.** Breaker state is in memory per instance. A half-open transition happens on the next call after the wait, so an idle breaker shows `OPEN` until traffic arrives.

---

## 7. AI router: Python, FastAPI, a bandit and logistic regression

**Context.** Rail quality changes minute to minute (a bank degrades, recovers); a static order cannot follow that.

**Decision.** A separate Python FastAPI service that ranks rails with **discounted Thompson sampling** over (rail, payment method), optionally blended (30%) with a **scikit-learn logistic regression** of P(success | rail, method, amount, hour).

* The bandit adapts online from every attempt, needs no training run, and explores enough to notice a recovery. Discounting and a half-life make old evidence fade.
* Logistic regression is small, fast and easy to inspect, and adds what is *usually* true (time of day, amount) that the bandit cannot know from recent traffic alone.
* The gateway treats the router as advice: a 150 ms deadline, fallback to the static order, and it can only reorder configured rails.

**What was dropped.** An earlier prototype (`ai-smart-router`, local work that was never merged into this repository) used an XGBoost classifier trained on synthetic data and ranked rails by a weighted mix of predicted success, latency and cost, reading the simulator's configuration (including kill switches) as live input. It is retired: it never learned from real payment outcomes, so it could not notice a rail whose approvals were dropping, and its model was only ever evaluated on synthetic data. Its accuracy figures are therefore not carried over.

**Consequences.** Router beliefs are in memory per instance and reset on restart; the model file survives. Rail cost is not yet part of the score.

---

## 8. Webhooks: transactional outbox in PostgreSQL, not Kafka

**Decision.** Write each event to `webhook_deliveries` in the same transaction as the state change; a dispatcher inside the orchestrator signs (HMAC-SHA256) and delivers with retries, endpoint pausing and per-merchant fairness.

**Why.** It gives at-least-once delivery without adding a message broker to run, and it cannot publish an event for a change that was rolled back. Kafka would add value when several internal consumers need the same events (fraud, analytics, reconciliation); that is a roadmap item, and the outbox is the natural source for it.

**Consequences.** Delivery order is not guaranteed and duplicates are possible; receivers de-duplicate by `X-Gateway-Event-Id`. One dispatcher per instance.

---

## 9. Security primitives

* **HMAC-SHA256** for payment signatures (`order_id|payment_id` with the key secret) and webhook signatures (raw body with the webhook secret): the same scheme merchants already know from Razorpay, verifiable in any language with constant-time comparison.
* **AES-256-GCM** for key secrets and webhook secrets at rest: the gateway must be able to read them back to sign, so they are encrypted rather than hashed. GCM authenticates the ciphertext as well.
* **HTTP Basic auth** with `key_id:key_secret`, as Razorpay does. Simple for merchants, and only ever sent from their servers.
* **SSRF guard** on webhook URLs (no loopback, private or link-local targets), checked at registration and before each delivery.

---

## 10. Operations dashboard: Next.js 16, React 19, TypeScript, Tailwind CSS

**Context.** Operators and testers need to see and drive the system: take payments, kill rails, watch breakers and webhooks, refund.

**Decision.** A Next.js app that runs in the browser and calls the services directly through one typed client (`src/lib/gateway.ts`). TypeScript types mirror the API's snake_case responses, and the CI type-checks and builds it.

**Why.** One client file documents every call the dashboard makes and keeps amounts in paise on the wire. Calling the services directly (with CORS) keeps the dashboard free of a backend of its own.

**Consequences.** The dashboard holds a sandbox merchant's key secret in `localStorage`, which is acceptable only for a local test-mode console. Consoles for components that do not exist yet (fraud, Kafka, Prometheus, Redis) are labelled simulated previews.

---

## 11. Redis 7: reserved

Redis is in the compose file because the next reliability and fraud features (velocity counters per customer or card, rate limits) need fast shared counters with expiry, which Redis provides. Today no service uses it, and the orchestrator has no Redis dependency.
