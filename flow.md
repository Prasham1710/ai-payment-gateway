# System Architecture & Execution Flow (`flow.md`)

## 1. Project Overview & Technology Stack

The **AI-Powered Payment Orchestration & Smart Routing Platform** is a multi-language payment system that routes merchant payments across several simulated bank rails. The rail order for each payment comes from an AI router that learns live success rates; per-rail circuit breakers skip rails that keep failing, and failover only happens when it cannot charge the customer twice.

On top of the orchestrator sits a **Razorpay-style merchant platform**: merchant accounts with API keys, an Orders API, a hosted checkout (`checkout.js`), authorize/capture, payment signatures, refunds, signed webhooks and merchant analytics. A Next.js **operations dashboard** drives and observes the whole system in test mode.

### Technology Stack & Component Roles

| Component / Layer | Technology | Port | Purpose & Role |
| :--- | :--- | :--- | :--- |
| **Payment Orchestrator** | **Java 17 + Spring Boot 3.5** | `8080` | Merchant APIs (orders, payments, refunds, webhooks, analytics), hosted checkout, payment state machine, JPA persistence, idempotency, failover routing, Resilience4j circuit breakers, operator endpoints (`/ops`). |
| **Bank & Provider Simulator** | **Go 1.22** | `8081` | Three simulated bank rails (HDFC, ICICI, SBI profiles) with an in-memory ledger, status enquiry, idempotent refunds and chaos controls. |
| **AI Router** | **Python 3.12 + FastAPI + scikit-learn** | `8000` | Orders the rails for each payment: discounted Thompson sampling over live outcomes, optionally blended with a logistic-regression success model. |
| **Operations Dashboard** | **Next.js 16 + React 19 + TypeScript** | `3000` | Test-mode console: checkout, analytics, circuit breakers, idempotency stress test, webhook deliveries, chaos controls, transaction ledger with refunds. |
| **Relational Database** | **PostgreSQL 16** | `5432` | `merchants`, `orders`, `payments`, `transactions` (rail attempts), `refunds`, `webhook_endpoints`, `webhook_deliveries` (outbox). |
| **Cache (reserved)** | **Redis 7** | `6380` | Provisioned by `docker/docker-compose.yml` for a later phase (velocity limits). Not used by any service yet. |
| **Containerization** | **Docker Compose** | — | Runs PostgreSQL and Redis locally (`docker/docker-compose.yml`). |

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
       │                                  │                                    │ 3. rail order from AI router (or static)
       │                                  │                                    │    breaker open? ─ skip (CB_OPEN)  │
       │                                  │                                    │    charge ────────────────────────►│ provider-a
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
| Rail's circuit breaker is open | Skip the rail without sending the charge (attempt recorded with `response_code` `CB_OPEN`), try the next rail | Nothing was sent, so failing over cannot double charge |
| Rail down: HTTP 503, kill switch, connection refused, request rejected | Try the next rail in the chain | The charge was definitely not processed |
| Declined by issuing bank (HTTP 4xx with a bank status) | Payment `failed`, no further rails | Retrying elsewhere would charge the customer again |
| Unknown: timeout, other 5xx (502/504), unreadable answer | Status enquiry on the same rail; if still unknown, payment `failed` (`bank_outcome_unknown`) and handed to the reconciler | The bank may have debited the customer |

Circuit breakers count "rail down" and "unknown" as failures and both approvals and declines as healthy answers. A breaker opens when at least 50% of the rail's last 10 calls failed (after at least 5 calls) and lets trial calls through after 5 seconds. Operators read and reset them with `GET /ops/circuit-breakers` and `POST /ops/circuit-breakers/{providerId}/reset`.

### Reconciliation & Automatic Refunds

- **Reconciler** (every 30s, backing off as a payment ages): re-checks `failed` payments with an unknown outcome for up to 24h, and settles checkouts that died mid-flight (`created` for more than 2 minutes). Every bank attempt is written before it is sent, so even a crash mid-call leaves a transaction id to ask the bank about. A charge the bank confirms becomes a **late authorization** (`failed → authorized`), then is captured as usual. The bank records charges as `PENDING` on receipt, so "not found" means it never arrived; that is only taken as final at the end of the 24h window.
- **Automatic refunds** (every 30s): an `authorized` payment that can no longer be captured (its order was paid by another payment, or it is older than the 5-day capture window) is refunded in full.
- **Refund retries** (every 5s): `pending` refunds are retried; a refund whose outcome is unknown is never released, so the payment can never be refunded twice.

---

## 3. What Has Been Completed

### Phase 1 — Core Engine & Go Simulator (DONE)

- [x] **Docker Infrastructure:** PostgreSQL 16 (`payment_postgres:5432`) and Redis 7 (`payment_redis:6380`, reserved) via `docker/docker-compose.yml`.
- [x] **Go Bank Simulator (`services/bank-simulator`):**
  - HTTP bank simulator on port `8081`.
  - Rails: `provider-a` (HDFC Direct), `provider-b` (ICICI Payment), `provider-c` (SBI Gateway).
  - Chaos API: `/api/v1/chaos/kill`, `/api/v1/chaos/restore` (one rail, or all without `provider_id`), `/api/v1/chaos/latency`, `/api/v1/chaos/success-rate` and `/api/v1/chaos/status`.
- [x] **Java Spring Boot Payment Orchestrator (`services/payment-orchestrator`):** provider failover chain, transaction (attempt) logging, idempotency.
- [x] **Verified Scenarios:** successful payment, idempotent duplicate requests, chaos kill on `provider-a` failing over to `provider-b`.

### Phase 1.5 — Razorpay-Style Merchant Platform (DONE)

- [x] **Merchant accounts & API keys:** `POST /v1/merchants` issues `key_id` / `key_secret`; HTTP Basic auth on all merchant APIs; secrets AES-256-GCM encrypted at rest.
- [x] **Orders API:** `POST/GET /v1/orders`, amounts in paise, `receipt`, `notes`, `payment_capture`; order lifecycle `created → attempted → paid`.
- [x] **Hosted checkout:** `checkout.js` + `/checkout/frame.html` (UPI, cards, netbanking), `postMessage` hand-off with origin checks, demo store at `/`.
- [x] **Payments:** lifecycle `created → authorized → captured → refunded | failed`, auto or manual capture, 2% fee + 18% GST on capture, `GET /v1/payments/{id}/attempts` shows routing.
- [x] **Payment signature:** `HMAC_SHA256(order_id|payment_id, key_secret)` returned by checkout for server-side verification.
- [x] **Refunds:** full/partial, reversal of uncaptured authorizations, amount reserved up front (no over-refund under concurrency), `pending` refunds retried in the background, unconfirmed refunds never released; simulator refunds are idempotent per `refund_id` (including concurrent retries).
- [x] **Smarter failover:** fail over only when a rail definitely did not process the charge; declines and unknown outcomes are never retried on another rail.
- [x] **Razorpay API conventions:** prefixed ids, snake_case JSON, Razorpay-style error objects, paginated collections, `Idempotency-Key` on checkout and refunds.

### Phase 2 — Reliability & Operations (DONE)

- [x] **Reconciliation:** late authorizations for charges the bank confirms after a timeout/502, crash recovery for interrupted checkouts, automatic refunds of authorizations that can no longer be captured.
- [x] **Webhooks:** 7 events, transactional outbox (`webhook_deliveries`), HMAC-SHA256 `X-Gateway-Signature`, parallel delivery with exponential backoff, endpoints served round robin with per-endpoint/per-merchant limits, failing endpoints paused instead of retried in a loop, delivery log API, SSRF protection for webhook URLs.
- [x] **Circuit breakers:** one Resilience4j breaker per rail; open rails are skipped without sending the charge (`CB_OPEN` attempt); declines do not count as failures; `GET /ops/circuit-breakers` and `POST /ops/circuit-breakers/{providerId}/reset`; toggle `GATEWAY_CIRCUIT_BREAKER_ENABLED`.
- [x] **Merchant analytics:** `GET /v1/analytics` (counts, success rate, volumes, fees incl. GST, net settlement, breakdowns).
- [x] **Operations dashboard (`services/frontend`):** Next.js console wired to the real APIs through `src/lib/gateway.ts`; CORS for its origin via `GATEWAY_CORS_ALLOWED_ORIGINS` and `AI_ROUTER_CORS_ORIGINS`.
- [x] **Tests & CI:** 65 orchestrator tests (H2 + in-process fake bank), 9 Go tests (`go test -race`), 11 AI router tests; GitHub Actions also type-checks and builds the dashboard.

Idempotency is enforced by the database (unique `(merchant_id, idempotency_key)` plus a row lock on the order) rather than by Redis locks, which the original Phase 2 plan proposed.

### Phase 4 — AI Smart Routing (DONE)

`services/ai-router`, a Python FastAPI service. Discounted Thompson sampling over (provider, payment method) success rates with time-based forgetting, blended with a scikit-learn logistic regression predicting $P(\text{success} \mid \text{provider, method, amount, hour})$. The orchestrator asks it for the rail order with a 150 ms deadline, falls back to the static order, and feeds every attempt's outcome back. See the README's "AI smart routing" section.

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
| `GET` | `/v1/analytics` | key |
| `GET`, `POST` | `/v1/checkout/orders/{id}`, `/v1/checkout/payments` | public `key_id` |
| `GET`, `POST` | `/ops/circuit-breakers`, `/ops/circuit-breakers/{providerId}/reset` | none (trusted network only) |

The Phase 1 endpoints (`/api/v1/payments`, unauthenticated, merchant id in the body) were replaced by the authenticated `/v1` APIs above.

---

## 4. Upcoming Project Phases & Roadmap

```text
  Phase 1 + 1.5 (DONE)      Phase 2 (DONE)           Phase 3                  Phase 4 (DONE)           Phase 5                  Phase 6
┌────────────────┐     ┌────────────────┐     ┌────────────────┐     ┌────────────────┐     ┌────────────────┐     ┌────────────────┐
│ Core Engine &  │ ──> │ Reliability &  │ ──> │ Kafka Event    │ ──> │ AI/ML Smart    │ ──> │ Fraud Detection│ ──> │ Settlement &   │
│ Merchant APIs  │     │ CircuitBreaker │     │ Streaming      │     │ Routing Engine │     │ & Velocity     │     │ Observability  │
└────────────────┘     └────────────────┘     └────────────────┘     └────────────────┘     └────────────────┘     └────────────────┘
```

1. **Phase 3 — Event Streaming (planned):** publish the payment events already written to the transactional outbox to Kafka, and load-test the gateway. Kafka is not part of the system today.
2. **Phase 5 — Fraud Detection (planned):** velocity limits in Redis and a risk-scoring service consulted before routing. Nothing listens on port 8002 today; the dashboard's fraud console is a labelled preview.
3. **Phase 6 — Settlement & Observability (planned):** extend the payment reconciler (already settling unknown bank outcomes) to daily settlement-file reconciliation, plus Prometheus metrics and Grafana dashboards. The services expose no metrics endpoint yet.
4. **Merchant platform next steps:** Payment Links, settlements & payouts, customers & saved cards, a merchant-facing dashboard with login, live/test mode key pairs, versioned schema migrations.

Detailed phase notes: [docs/technical/07-phase-breakdown-and-milestones.md](docs/technical/07-phase-breakdown-and-milestones.md).
