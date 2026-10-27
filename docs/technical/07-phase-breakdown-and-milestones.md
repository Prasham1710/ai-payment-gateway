# Phase Breakdown and Milestones

What has been built, how each piece is verified, and what comes next. Status is stated plainly: **Done** means the code is in this repository and covered by automated tests; **Planned** means it does not exist yet.

## Status at a glance

```text
Phase 1    Core engine & bank simulator ............................ Done
Phase 1.5  Razorpay-style merchant platform ........................ Done
Phase 2    Reliability: reconciliation, webhooks, circuit breakers . Done
Phase 4    AI smart routing ........................................ Done
Ops        Operations dashboard (Next.js) .......................... Done (test-mode console)
Phase 3    Event streaming (Kafka) ................................. Planned
Phase 5    Fraud detection & velocity limits (Redis) ............... Planned
Phase 6    Settlement reconciliation & observability ............... Planned
```

Phases are numbered by the original plan, which is why Phase 4 was finished before Phase 3.

---

## Phase 1: Core engine and bank simulator (Done)

**Goal.** Route a payment across several bank rails, fail over when a rail is down, never charge twice.

**Delivered.**

* `services/bank-simulator` (Go, :8081): three rails (`provider-a` HDFC, `provider-b` ICICI, `provider-c` SBI profiles) with success rate, latency and kill switch; chaos API (`kill`, `restore` one or all, `latency`, `success-rate`, `status`); charge, status enquiry and refund endpoints; sandbox test instruments.
* `services/payment-orchestrator` (Spring Boot, :8080): failover chain, one `transactions` row per rail attempt, idempotency.
* `docker/docker-compose.yml`: PostgreSQL 16 and Redis 7 (Redis reserved).

**Verified by.** Go tests (`go test -race`), e.g. `TestKilledProviderReturns503EvenForTestInstruments`, `TestStatusEnquiryReportsPendingWhileTheChargeIsProcessing`, `TestRestoreWithoutProviderRestoresEveryRail`; orchestrator tests `failsOverOnlyWhenARailIsDown`, `idempotencyKeyReplaysTheSamePayment`.

---

## Phase 1.5: Razorpay-style merchant platform (Done)

**Goal.** Let a merchant integrate the way they would with Razorpay.

**Delivered.** Merchant signup with `key_id` / `key_secret` (AES-256-GCM at rest) and Basic auth; Orders API; hosted checkout (`checkout.js`, `/checkout/frame.html`) with UPI, card and netbanking and a demo store at `/`; payment lifecycle `created → authorized → captured → refunded | failed` with auto or manual capture, 2% fee + 18% GST; payment signature; full and partial refunds and reversal of uncaptured authorizations; Razorpay conventions (paise, prefixed ids, snake_case, error format, paginated collections, `Idempotency-Key`). The Phase 1 endpoints (`/api/v1/payments`, unauthenticated, merchant id in the body) were replaced by the authenticated `/v1` API.

**Verified by.** `GatewayApiIntegrationTest`: `signupIssuesApiKeysAndMerchantApisRequireThem`, `checkoutAutoCapturesAndReturnsVerifiableSignature`, `manualCaptureFlow`, `partialThenFullRefund`, `cardAndNetbankingPayments`, `merchantsCannotSeeEachOthersData`, `orderValidationUsesRazorpayErrorFormat`.

---

## Phase 2: Reliability and operations (Done)

**Goal.** Make every failure mode safe: no lost events, no double charges or refunds, no time wasted on dead rails.

The original plan for this phase was Redis distributed locks plus circuit breakers. Idempotency ended up enforced by the database instead (unique `(merchant_id, idempotency_key)` indexes and an order row lock); see [technology rationale](06-technology-rationale.md#4-idempotency-without-a-distributed-lock). Redis-based velocity limits moved to Phase 5.

**Delivered.**

* **Safe failover**: fail over only when a rail provably did not process the charge; declines stop; unknown outcomes go to a status enquiry and then to the reconciler.
* **Reconciliation**: late authorizations, crash recovery from write-ahead attempts, a 24-hour follow-up window.
* **Refund safety**: amounts reserved up front, `pending` refunds retried, unconfirmed refunds never released, automatic refunds of authorizations that can no longer be captured.
* **Webhooks**: 7 events, transactional outbox, HMAC-SHA256 signatures, retries with backoff, round-robin fairness and endpoint pausing, SSRF protection, delivery log API.
* **Circuit breakers**: one Resilience4j breaker per rail; open rails skipped without sending the charge (`CB_OPEN` attempts); declines never trip a breaker; `GET /ops/circuit-breakers` and `POST /ops/circuit-breakers/{providerId}/reset`; `GATEWAY_CIRCUIT_BREAKER_ENABLED`.
* **Merchant analytics**: `GET /v1/analytics`.
* **Dashboard support**: CORS for the dashboard origin (`GATEWAY_CORS_ALLOWED_ORIGINS`, `AI_ROUTER_CORS_ORIGINS`).
* **Build and CI**: Spring Boot 3.5, Maven Wrapper, GitHub Actions for all four services.

**Verified by.** `ReliabilityIntegrationTest` (for example `ambiguousBankErrorIsNotFailedOverAndIsReconciledIntoALateCapture`, `readTimeoutIsTreatedAsUnknownNotAsAFailover`, `chargeInFlightDuringACrashIsFoundThroughItsWriteAheadAttempt`, `refundWithAnUnconfirmedOutcomeIsNeverReleased`, `failingEndpointIsPausedAndItsQueuedEventsKeepTheirAttempts`, `slowWebhookReceiverDoesNotHoldUpOtherMerchants`), `OperationsIntegrationTest` (`aRailThatKeepsFailingIsSkippedWithoutBeingChargedUntilItsBreakerIsReset`, `bankDeclinesDoNotOpenTheBreaker`, `analyticsSummarizesTheMerchantsOwnPaymentsOnly`, `theDashboardOriginMayCallTheApiFromABrowser`), and the Go refund tests (`TestConcurrentRetriesOfOneRefundPayOutOnce`, `TestRefundIsIdempotentPerRefundID`).

---

## Phase 4: AI smart routing (Done)

**Goal.** Send each payment to the rail most likely to approve it right now, and move away from a degrading rail without manual intervention.

**Delivered.** `services/ai-router` (FastAPI, :8000): a discounted bandit over (rail, payment method) fed by the orchestrator's attempt outcomes, optionally blended with a scikit-learn logistic-regression model trained by `train.py` (from the gateway's own `transactions` or data generated by `generate_data.py`); `demo.py` shows traffic moving off a degraded rail and back. The orchestrator asks for the rail order with a 150 ms deadline, falls back to the static order, never lets the router add or drop rails, and reports each attempt back. Details: [AI routing](02-state-machine-and-flows.md#8-ai-routing).

**Verified by.** Python tests (bandit, model training, API, CORS) and `SmartRoutingIntegrationTest` (`railOrderComesFromTheAiRouterAndOutcomesAreReportedBack`, `unknownOrDuplicateRailsFromTheRouterAreIgnoredAndNoneAreDropped`, `slowOrDownRouterFallsBackToTheConfiguredOrder`).

**Not carried over.** An earlier, unmerged prototype (`ai-smart-router`, XGBoost on synthetic data, `/api/v1/route`) is retired; see [technology rationale](06-technology-rationale.md#7-ai-router-python-fastapi-a-bandit-and-logistic-regression).

---

## Operations dashboard (Done, test-mode console)

**Goal.** Drive and observe the whole system from a browser.

**Delivered.** `services/frontend` (Next.js 16, :3000), wired to the real APIs through `src/lib/gateway.ts`: Checkout (direct API form and drop-in modal), Analytics, Circuits & Idempotency (live breakers and an idempotency stress test), Webhook Inspector, Developer API Keys, Chaos Matrix and a Transaction Ledger with refunds, plus per-port consoles. The 8080, 8081, 8000 and 5432 consoles show live data; 8002, 6380, 9092 and 9090 are labelled simulated previews of planned components. The dashboard acts as one sandbox merchant whose keys live in `localStorage`.

**Verified by.** CI type-checks and builds it (`npm run typecheck`, `npm run build`). It has no automated UI tests yet.

---

## Phase 3: Event streaming (Planned)

**Goal.** Make payment events available to internal consumers (fraud, analytics, settlement) without coupling them to the orchestrator.

**Plan.** Publish the events already written to the `webhook_deliveries` outbox (or a sibling outbox table) to Kafka with at-least-once delivery; add a dead-letter path for events that cannot be processed; load-test the gateway and record the results. Nothing Kafka-related exists today; the dashboard's 9092 console is a preview.

**Done when.** An event committed in PostgreSQL always reaches its Kafka topic, including across a broker outage, and this is covered by tests.

---

## Phase 5: Fraud detection and velocity limits (Planned)

**Goal.** Refuse or flag risky payments before they reach a bank.

**Plan.** Velocity counters in Redis (per card, VPA, contact and merchant, with expiry), a risk-scoring service consulted before routing with allow / review / block decisions, and a `risk` section on the payment. Nothing listens on port 8002 today; the dashboard's fraud console is a preview.

**Done when.** A burst of payments from one instrument is blocked or flagged according to configured limits, the decision is recorded on the payment, and the gateway still works when the fraud service is down (fail-open or fail-closed by configuration).

---

## Phase 6: Settlement reconciliation and observability (Planned)

**Goal.** Match money movement against the bank's records daily, and make the system's health visible.

**Plan.** Extend the reconciler (which already settles unknown bank outcomes) to daily settlement files from the rails; T+1 settlement reports per merchant using the fees and net amounts already computed; Prometheus metrics from all services (request rates, routing decisions, attempt outcomes per rail, breaker states, webhook backlog) and Grafana dashboards. Today no service exposes metrics; the dashboard's 9090 console is a preview.

---

## Merchant platform: next steps (Planned)

Payment Links; customers and saved cards; settlements and payouts; live/test key pairs; a merchant-facing dashboard with login (replacing the single sandbox merchant of the operations console); versioned schema migrations (Flyway or Liquibase); signup verification and rate limiting; running several orchestrator instances (`SKIP LOCKED` claiming, shared breaker state).

---

## Definition of done for a phase

Before a phase is marked **Done** in this document:

1. All CI jobs pass (`./mvnw verify`, `go vet` / `gofmt` / `go test -race`, `pytest`, dashboard `typecheck` and `build`).
2. New behaviour is covered by automated tests that exercise the real HTTP APIs where possible.
3. The README, `flow.md` and the affected pages in `docs/` describe what the code does, and nothing it does not.
4. The phase's work is merged through a reviewed pull request.
