# System Architecture & Execution Flow (`flow.md`)

## 1. Project Overview & Technology Stack

The **AI-Powered Payment Orchestration & Smart Routing Platform** is a distributed, multi-language payment infrastructure designed to dynamically route merchant payments across multiple bank rails and providers based on real-time success probability, latency, transaction cost, and provider health.

On top of the orchestrator sits a **Razorpay-style merchant platform**: merchant accounts with API keys, an Orders API, a hosted checkout (`checkout.js`), authorize/capture, payment signatures, refunds and signed webhooks.

### Technology Stack & Component Roles

| Component / Layer | Technology | Port | Purpose & Role |
| :--- | :--- | :--- | :--- |
| **Payment Orchestrator** | **Java 17 + Spring Boot 3.2** | `8080` | Merchant APIs (orders, payments, refunds, webhooks), hosted checkout, payment state machine, JPA persistence, idempotency, fallback routing. |
| **Bank & Provider Simulator** | **Go 1.22** | `8081` | Ultra-fast high-concurrency bank rail simulator (HDFC, ICICI, SBI) with goroutine chaos injection & ledger. |
| **Relational Database** | **PostgreSQL 16** | `5432` | ACID-compliant ledger: `merchants`, `orders`, `payments`, `transactions` (rail attempts), `refunds`, `webhook_endpoints`, `webhook_deliveries` (outbox). |
| **In-Memory Cache & Locks** | **Redis 7** | `6380` | Distributed lock engine (`SETNX`), idempotency TTL cache, provider health state, velocity counters. |
| **Messaging & Events** | **Apache Kafka** | `9092` | Event-driven streaming backbone (`payment-events`, `routing-metrics`, `reconciliation-dlq`). |
| **AI Routing & Fraud Engine** | **Python 3.12 + FastAPI** | `8000` | ML routing classifier (XGBoost/Scikit-Learn), real-time feature extraction, and fraud risk scorer. |
| **Containerization** | **Docker & Docker Compose** | — | Single-command local infrastructure provisioning (`docker-compose.yml`). |

---

## 2. End-to-End Payment Execution Flow

```
 MERCHANT SERVER                   CUSTOMER BROWSER                 PAYMENT ORCHESTRATOR (8080)           GO BANK SIMULATOR (8081)
       │                                  │                                    │                                    │
       │ POST /v1/orders (Basic auth)     │                                    │                                    │
       │─────────────────────────────────────────────────────────────────────►│ order: created                     │
       │◄──────────────────────────────── order_id ───────────────────────────│                                    │
       │ order_id + key_id ──────────────►│                                    │                                    │
       │                                  │ checkout.js opens hosted frame     │                                    │
       │                                  │ POST /v1/checkout/payments ───────►│ 1. lock order, idempotency check   │
       │                                  │    (UPI / card / netbanking)       │ 2. payment: created, order: attempted
       │                                  │                                    │ 3. smart routing ─────────────────►│ provider-a
       │                                  │                                    │      rail down (503)? ─ fail over ►│ provider-b ...
       │                                  │                                    │      decline? ─ stop (no retry)    │
       │                                  │                                    │      timeout/502? ─ enquiry, else  │
       │                                  │                                    │        failed + reconciler         │
       │                                  │                                    │ 4. payment: authorized             │
       │                                  │                                    │    auto-capture → captured,        │
       │                                  │                                    │    fee + GST, order: paid          │
       │                                  │                                    │ 5. webhook events → outbox (same tx)
       │                                  │◄── payment_id, order_id, signature │                                    │
       │◄── handler(response) ────────────│                                    │                                    │
       │ verify HMAC_SHA256(order_id|payment_id, key_secret)                   │                                    │
       │                                                                       │                                    │
       │◄─────────── signed webhooks: payment.captured, order.paid ... ────────│ dispatcher (retries w/ backoff)    │
       │ POST /v1/payments/{id}/refund ──────────────────────────────────────►│ reserve amount → bank refund ─────►│
       │                                                                       │ rail down? refund stays pending,   │
       │                                                                       │ background job retries             │
```

### Routing & Failover Rules

| Bank rail outcome | Action | Why |
| :--- | :--- | :--- |
| Approved | Payment `authorized` (then `captured` if auto-capture) | — |
| Rail down: HTTP 503, kill switch, connection refused, request rejected | Try the next rail in the chain | The charge was definitely not processed |
| Declined by issuing bank (HTTP 4xx with a bank status) | Payment `failed`, no further rails | Retrying elsewhere would charge the customer again |
| Unknown: timeout, other 5xx (502/504), unreadable answer | Status enquiry on the same rail; if still unknown, payment `failed` (`bank_outcome_unknown`) and handed to the reconciler | The bank may have debited the customer |

### Reconciliation & Automatic Refunds

- **Reconciler** (every 30s, backing off as a payment ages): re-checks `failed` payments with an unknown outcome for up to 24h, and settles checkouts that died mid-flight (`created` for more than 2 minutes). Every bank attempt is written before it is sent, so even a crash mid-call leaves a transaction id to ask the bank about. A charge the bank confirms becomes a **late authorization** (`failed → authorized`), then is captured as usual. The bank records charges as `PENDING` on receipt, so "not found" means it never arrived; that is only taken as final at the end of the 24h window.
- **Automatic refunds** (every 30s): an `authorized` payment that can no longer be captured (its order was paid by another payment, or it is older than the 5-day capture window) is refunded in full.
- **Refund retries** (every 5s): `pending` refunds are retried; a refund whose outcome is unknown is never released, so the payment can never be refunded twice.

---

## 3. What Has Been Completed

### Phase 1 — Core Engine & Go Simulator (DONE)

- [x] **Docker Infrastructure:** PostgreSQL 16 (`payment_postgres:5432`) and Redis 7 (`payment_redis:6380`) running via `docker-compose.yml`.
- [x] **Go Bank Simulator (`services/bank-simulator`):**
  - High-concurrency HTTP mock engine on port `8081`.
  - Rails: `provider-a` (HDFC Direct), `provider-b` (ICICI Payment), `provider-c` (SBI Gateway).
  - Chaos API: Live toggles for `/api/v1/chaos/kill`, `/api/v1/chaos/restore`, `/api/v1/chaos/latency`, `/api/v1/chaos/success-rate` and `/api/v1/chaos/status`.
- [x] **Java Spring Boot Payment Orchestrator (`services/payment-orchestrator`):** provider failover chain, transaction (attempt) logging, idempotency.
- [x] **Verified Scenarios:** successful payment, idempotent duplicate requests, chaos kill on `provider-a` failing over to `provider-b`.

### Phase 1.5 — Razorpay-Style Merchant Platform (DONE)

- [x] **Merchant accounts & API keys:** `POST /v1/merchants` issues `key_id` / `key_secret`; HTTP Basic auth on all merchant APIs; secrets AES-256-GCM encrypted at rest.
- [x] **Orders API:** `POST/GET /v1/orders`, amounts in paise, `receipt`, `notes`, `payment_capture`; order lifecycle `created → attempted → paid`.
- [x] **Hosted checkout:** `checkout.js` + `/checkout/frame.html` (UPI, cards, netbanking), `postMessage` hand-off with origin checks, demo store at `/`.
- [x] **Payments:** lifecycle `created → authorized → captured → refunded | failed`, auto or manual capture, 2% fee + 18% GST on capture, `GET /v1/payments/{id}/attempts` shows routing.
- [x] **Payment signature:** `HMAC_SHA256(order_id|payment_id, key_secret)` returned by checkout for server-side verification.
- [x] **Refunds:** full/partial, reversal of uncaptured authorizations, amount reserved up front (no over-refund under concurrency), `pending` refunds retried in the background, unconfirmed refunds never released; simulator refunds are idempotent per `refund_id` (including concurrent retries).
- [x] **Reconciliation:** late authorizations for charges the bank confirms after a timeout/502, crash recovery for interrupted checkouts, automatic refunds of authorizations that can no longer be captured.
- [x] **Webhooks:** 7 events, transactional outbox (`webhook_deliveries`), HMAC-SHA256 `X-Gateway-Signature`, parallel delivery with exponential backoff, endpoints served round robin with per-endpoint/per-merchant limits, failing endpoints paused instead of retried in a loop, delivery log API, SSRF protection for webhook URLs.
- [x] **Smarter failover:** fail over only when a rail definitely did not process the charge; declines and unknown outcomes are never retried on another rail.
- [x] **Razorpay API conventions:** prefixed ids, snake_case JSON, Razorpay-style error objects, paginated collections, `Idempotency-Key` on checkout and refunds.
- [x] **Tests:** Spring Boot integration tests (H2 + in-process fake bank) and Go handler tests (`go test -race`).

### REST Endpoints

| Method | Path | Auth |
| :--- | :--- | :--- |
| `POST` | `/v1/merchants` | none |
| `GET` | `/v1/merchants/me` | key |
| `POST`, `GET` | `/v1/orders`, `/v1/orders/{id}`, `/v1/orders/{id}/payments` | key |
| `GET` | `/v1/payments`, `/v1/payments/{id}`, `/v1/payments/{id}/attempts` | key |
| `POST` | `/v1/payments/{id}/capture`, `/v1/payments/{id}/refund` | key |
| `GET` | `/v1/payments/{id}/refunds`, `/v1/refunds`, `/v1/refunds/{id}` | key |
| `POST`, `GET`, `DELETE` | `/v1/webhooks`, `/v1/webhooks/{id}`, `/v1/webhooks/{id}/deliveries` | key |
| `GET`, `POST` | `/v1/checkout/orders/{id}`, `/v1/checkout/payments` | public `key_id` |

The Phase 1 endpoints (`/api/v1/payments`, unauthenticated, merchant id in the body) were replaced by the authenticated `/v1` APIs above.

---

## 4. Upcoming Project Phases & Roadmap

```text
  Phase 1 + 1.5 (DONE)      Phase 2                  Phase 3                  Phase 4 (DONE)           Phase 5                  Phase 6
┌────────────────┐     ┌────────────────┐     ┌────────────────┐     ┌────────────────┐     ┌────────────────┐     ┌────────────────┐
│ Core Engine &  │ ──> │ Idempotency &  │ ──> │ Kafka Scaling  │ ──> │ AI/ML Smart    │ ──> │ Real-Time      │ ──> │ Reconciliation │
│ Go Simulator   │     │ CircuitBreaker │     │ & Outbox       │     │ Routing Engine │     │ Fraud Detector │     │ & Observability│
└────────────────┘     └────────────────┘     └────────────────┘     └────────────────┘     └────────────────┘     └────────────────┘
```

1. **Phase 2 — Distributed Reliability:** Redis distributed locking (`SETNX`), Resilience4j provider circuit breakers, and timeout management.
2. **Phase 3 — Scale & Kafka Outbox:** Asynchronous Kafka event processing, extending the transactional outbox (already used for webhooks) to Kafka, and high-TPS load testing (10,000+ payments/min).
3. **Phase 4 — AI Smart Routing (done):** `services/ai-router`, a Python FastAPI service. Discounted Thompson sampling over (provider, payment method) success rates with time-based forgetting, blended with a scikit-learn logistic regression predicting $P(\text{success} \mid \text{provider, method, amount, hour})$. The orchestrator asks it for the rail order with a 150 ms deadline, falls back to the static order, and feeds every attempt's outcome back. See the README's "AI smart routing" section.
4. **Phase 5 — Fraud Detection:** Velocity tracking in Redis + XGBoost anomaly risk scoring model.
5. **Phase 6 — Reconciliation & Observability:** Extend the payment reconciler (already settling unknown bank outcomes) to daily settlement-file reconciliation, plus Prometheus metrics & Grafana dashboards.
6. **Merchant platform next steps:** Payment Links, settlements & payouts, customers & saved cards, merchant dashboard, live/test mode key pairs.
