# AI Payment Gateway

A Razorpay-style payment gateway built on a multi-rail **payment orchestrator**. Merchants integrate the way they would with Razorpay (Orders API, a drop-in checkout, signature verification, webhooks), while every payment is routed across several bank rails with automatic failover, per-rail circuit breakers and AI-assisted rail ordering. A Next.js operations dashboard lets you drive and observe the whole system locally.

> Test mode only. Payments run against the bundled Go bank simulator; no real money moves.

## Features

| Area | What you get |
| :--- | :--- |
| **Merchant accounts & API keys** | Sign up via API, get a `key_id` / `key_secret` pair, authenticate with HTTP Basic auth. Secrets are AES-256-GCM encrypted at rest. |
| **Orders API** | Create an order server-side with the amount (in paise), receipt and notes before taking payment. |
| **Hosted checkout (`checkout.js`)** | Drop-in modal with UPI, cards and netbanking. Mobile friendly. Card numbers and CVVs are never stored (only last 4 + network). |
| **Authorize → capture** | Auto-capture (default) or manual capture via API. Platform fee (2%) and GST (18% of fee) are computed on capture. |
| **Payment signature** | Checkout returns `HMAC_SHA256(order_id + "\|" + payment_id, key_secret)` so your server can prove the result is genuine. |
| **Refunds** | Full and partial refunds of captured payments, and full reversal of authorized payments that were never captured. The amount is reserved immediately, so concurrent refunds can never exceed the payment. If the bank rail is down the refund stays `pending` and is retried automatically; a refund the bank never confirmed is never released on a guess. |
| **Automatic refunds** | Authorized payments that can no longer be captured (the order was paid by another payment, or 5 days passed) are refunded automatically, so a customer's money is never held indefinitely. |
| **Reconciliation** | If a bank times out or answers with an unclear error, the payment is reported failed but the gateway keeps checking with the bank. A charge the bank later confirms becomes a late authorization (captured, or refunded if the order was already paid). Checkouts interrupted by a crash are settled the same way. |
| **Webhooks** | `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`, `refund.created`, `refund.processed`, `refund.failed`. Signed with HMAC-SHA256, written to an outbox in the same DB transaction as the change, delivered in parallel and retried with exponential backoff. URLs on private or internal networks are refused (SSRF protection). |
| **AI smart routing** | An AI router picks the order in which rails are tried for each payment, from live success rates (a multi-armed bandit) blended with a model trained on past attempts. Traffic moves away from a degrading rail within a few dozen payments and comes back when it recovers. If the router is down or slower than 150 ms, the gateway uses the configured order. |
| **Failover** | Each payment tries the rails in order (provider-a → provider-b → provider-c without the AI router), skipping any rail whose circuit breaker is open. It fails over only when a rail definitely did not process the charge (503, connection refused, breaker open). A bank decline, timeout or 502/504 is never retried elsewhere, because that could charge the customer twice. Every attempt is recorded. |
| **Circuit breakers** | Each rail has a Resilience4j circuit breaker. A rail that keeps failing (unavailable, or no usable answer) is skipped without sending the charge until it recovers; bank declines count as healthy answers. Operators can inspect and reset breakers through `/ops/circuit-breakers`. See [Circuit breakers](#circuit-breakers). |
| **Merchant analytics** | `GET /v1/analytics` returns payment counts, success rate, gross / captured / refunded volume, fees including GST, net settlement and breakdowns by status, method and rail. |
| **Operations dashboard** | A Next.js console (port 3000) for test mode: checkout, analytics, live circuit breakers, an idempotency stress test, webhook deliveries, chaos controls and a transaction ledger with refunds. See [Operations dashboard](#operations-dashboard). |
| **Razorpay API conventions** | Amounts in paise, prefixed ids (`order_…`, `pay_…`, `rfnd_…`), snake_case JSON, `{"error": {code, description, source, step, reason, field, metadata}}` errors, `count`/`skip`/`from`/`to` collections, `Idempotency-Key` support. |

## Architecture

```
 Merchant server ──(Basic auth: key_id:key_secret)──► Payment Orchestrator (Spring Boot, :8080) ──► PostgreSQL (:5432)
 Customer browser ─(checkout.js, key_id only)───────►   ├─ orders / payments / refunds / webhooks / analytics
 Operations dashboard (Next.js, :3000) ─(/v1, /ops)─►   ├─ "which rail first?" ─────────► AI Router (Python, :8000)
        │                                               ├─ circuit breakers + failover ─► Go Bank Simulator (:8081)
        │                                               └─ webhook dispatcher ──────────► merchant webhook URL
        ├─ chaos controls ─────────────────────────────────────────────────────────────► Go Bank Simulator
        └─ /health, /v1/stats, /v1/route ──────────────────────────────────────────────► AI Router
```

| Component | Tech | Port |
| :--- | :--- | :--- |
| Payment orchestrator + hosted checkout + demo store | Java 17, Spring Boot 3.5, Resilience4j | 8080 |
| Bank & provider simulator (3 rails, chaos controls) | Go 1.22 | 8081 |
| AI router (bandit + success model) | Python 3.12, FastAPI, scikit-learn | 8000 |
| Operations dashboard | Next.js 16, React 19, TypeScript, Tailwind CSS | 3000 |
| Database | PostgreSQL 16 | 5432 |
| Cache (reserved for a later phase; not used by any service yet) | Redis 7 | 6380 |

See [`flow.md`](flow.md) for the full payment flow and roadmap, and [Documentation](#documentation) for the detailed guides.

## Quick start

Prerequisites: Docker, JDK 17+, Go 1.22+, Python 3.11+ and Node.js 20.9+ (for the dashboard). Maven is not needed: the orchestrator ships the Maven Wrapper (`./mvnw`).

```bash
# 1. PostgreSQL + Redis (Redis is provisioned for a later phase; nothing uses it yet)
docker compose -f docker/docker-compose.yml up -d

# 2. Bank simulator
cd services/bank-simulator && go run .

# 3. AI router (new terminal; optional, payments use the static rail order without it)
cd services/ai-router && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --port 8000

# 4. Orchestrator (new terminal)
cd services/payment-orchestrator && ./mvnw spring-boot:run

# 5. Operations dashboard (new terminal; optional)
cd services/frontend && npm install && npm run dev
```

Open **http://localhost:8080** for the demo store: it creates a test merchant, opens checkout, verifies the signature, and lets you capture and refund from one page. Open **http://localhost:3000** for the operations dashboard.

### Database from an earlier version

The orchestrator creates and updates its own tables (Hibernate `ddl-auto: update`). It cannot convert the tables left by the Phase 1 prototype, so if your `payment_db` volume predates this version, pick one of these:

```bash
# Option A: keep the old data and use a fresh database next to it
docker exec payment_postgres psql -U postgres -c "CREATE DATABASE payment_gateway;"
cd services/payment-orchestrator && SPRING_DATASOURCE_URL=jdbc:postgresql://localhost:5432/payment_gateway ./mvnw spring-boot:run

# Option B: reset the dev database. This deletes everything in the Postgres and Redis volumes.
docker compose -f docker/docker-compose.yml down -v && docker compose -f docker/docker-compose.yml up -d
```

A fresh clone needs neither: the compose file creates `payment_db` and the orchestrator creates the tables on first start.

### Local services

| Service | Address | Credentials (local development only) |
| :--- | :--- | :--- |
| Operations dashboard | http://localhost:3000 | None. Creates a sandbox merchant on first use. |
| Orchestrator, demo store, `checkout.js` | http://localhost:8080 | Merchant APIs: `key_id:key_secret` (Basic auth). `/ops` has no auth. |
| Bank simulator | http://localhost:8081 | None |
| AI router | http://localhost:8000 | None |
| PostgreSQL | `localhost:5432`, database `payment_db` (or `payment_gateway`, Option A) | `postgres` / `postgrespassword` |
| Redis (reserved) | `localhost:6380` (container port 6379) | No password |

Nothing in this repository listens on 8002, 9090 or 9092; the dashboard's consoles for those ports are labelled previews of planned components. External GUIs such as pgAdmin or RedisInsight are not part of this repository; see [Tools and GUIs](docs/user-guide/04-tools-and-guis-guide.md) for how to point one at the services.

### Configuration

Orchestrator:

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `GATEWAY_MASTER_KEY` | built-in dev key (logs a warning) | Base64 of 32 random bytes (`openssl rand -base64 32`). Encrypts key secrets and webhook secrets. Set it anywhere other than your laptop. |
| `GATEWAY_WEBHOOKS_ALLOW_PRIVATE_NETWORK` | `false` | Set to `true` to deliver webhooks to a receiver on `localhost` or your LAN while developing. |
| `GATEWAY_AI_ROUTING_ENABLED` | `true` | Set to `false` to always use the configured rail order. |
| `GATEWAY_AI_ROUTER_URL` | `http://localhost:8000` | Where the AI router runs. |
| `GATEWAY_CIRCUIT_BREAKER_ENABLED` | `true` | Set to `false` to turn off the per-rail circuit breakers (every rail in the order is always tried). |
| `GATEWAY_CORS_ALLOWED_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | Comma-separated browser origins allowed to call `/v1` and `/ops`. Add the dashboard's origin if you serve it elsewhere. |
| `SPRING_DATASOURCE_URL` | `jdbc:postgresql://localhost:5432/payment_db` | Database to use (standard Spring Boot property, like `SPRING_DATASOURCE_USERNAME` and `SPRING_DATASOURCE_PASSWORD`). |

AI router:

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `AI_ROUTER_MODEL_PATH` | `models/routing-model.joblib` | Trained model to load, if present. |
| `AI_ROUTER_MODEL_WEIGHT` | `0.3` | Weight of the model's prediction against the bandit. |
| `AI_ROUTER_DISCOUNT` | `0.98` | How much old results are discounted on each new one. |
| `AI_ROUTER_HALF_LIFE_SECONDS` | `120` | Evidence halves after this many seconds. |
| `AI_ROUTER_TIMEZONE` | `Asia/Kolkata` | Time zone for the hour-of-day feature. |
| `AI_ROUTER_CORS_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | Comma-separated browser origins allowed to call the router (the dashboard). |

See [AI smart routing](#ai-smart-routing) for what these do. The dashboard's variables are listed under [Operations dashboard](#operations-dashboard).

## Integration guide

### 1. Get API keys

```bash
curl -X POST http://localhost:8080/v1/merchants \
  -H 'Content-Type: application/json' \
  -d '{"name": "Acme Store", "email": "owner@acme.test"}'
```

```json
{ "id": "acc_ZbLLDOMRvHsSDC", "entity": "merchant", "name": "Acme Store", "email": "owner@acme.test",
  "key_id": "key_test_QdTbA1lGIYcrY0", "key_secret": "PhT3fpEzPDEQBtQkmHaxjkO1", "created_at": 1792836971 }
```

The `key_secret` is shown only once. Keep it on your server.

### 2. Create an order (your server)

```bash
curl -u key_test_xxx:your_secret -X POST http://localhost:8080/v1/orders \
  -H 'Content-Type: application/json' \
  -d '{"amount": 50000, "currency": "INR", "receipt": "rcpt_001", "notes": {"sku": "HP-01"}}'
```

`amount` is in paise (50000 = ₹500.00, minimum 100). Pass `"payment_capture": false` to capture manually later.

### 3. Open checkout (your web page)

```html
<script src="http://localhost:8080/checkout.js"></script>
<script>
  const checkout = new GatewayCheckout({
    key: "key_test_xxx",                 // public key id only
    order_id: "order_fz8q7fkUZJ416o",    // from step 2
    name: "Acme Store",
    description: "Order #1234",
    prefill: { email: "ravi@example.com", contact: "9876543210" },
    theme: { color: "#2563eb" },
    handler: (response) => {
      // { payment_id, order_id, signature } -> send to your server for verification
    },
    modal: { ondismiss: () => console.log("closed") }
  });
  checkout.on("payment.failed", (response) => console.log(response.error));
  checkout.open();
</script>
```

### 4. Verify the signature (your server)

Only fulfil the order after this check passes.

```js
// Node.js
const crypto = require("crypto");
const expected = crypto.createHmac("sha256", KEY_SECRET).update(`${order_id}|${payment_id}`).digest("hex");
const valid = expected.length === signature.length &&
  crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
```

```python
# Python
import hmac, hashlib
expected = hmac.new(KEY_SECRET.encode(), f"{order_id}|{payment_id}".encode(), hashlib.sha256).hexdigest()
valid = hmac.compare_digest(expected, signature)
```

```java
// Java
Mac mac = Mac.getInstance("HmacSHA256");
mac.init(new SecretKeySpec(keySecret.getBytes(UTF_8), "HmacSHA256"));
String expected = HexFormat.of().formatHex(mac.doFinal((orderId + "|" + paymentId).getBytes(UTF_8)));
boolean valid = MessageDigest.isEqual(expected.getBytes(UTF_8), signature.getBytes(UTF_8));
```

### 5. Capture (only when `payment_capture` was `false`)

```bash
curl -u key_test_xxx:your_secret -X POST http://localhost:8080/v1/payments/pay_xxx/capture \
  -H 'Content-Type: application/json' -d '{"amount": 50000, "currency": "INR"}'
```

### 6. Refund

```bash
curl -u key_test_xxx:your_secret -X POST http://localhost:8080/v1/payments/pay_xxx/refund \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: refund-rcpt_001' \
  -d '{"amount": 20000, "notes": {"reason": "size exchange"}}'
```

Leave out `amount` to refund everything that is left. The `Idempotency-Key` makes retries safe. A payment that was authorized but never captured can only be refunded in full; this reverses the authorization and no fee is charged.

### 7. Webhooks

```bash
curl -u key_test_xxx:your_secret -X POST http://localhost:8080/v1/webhooks \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://your.server/webhooks/gateway", "secret": "whsec_choose_a_secret", "events": ["*"]}'
```

Each delivery is a `POST` with these headers:

| Header | Value |
| :--- | :--- |
| `X-Gateway-Signature` | hex `HMAC_SHA256(raw_body, webhook_secret)` |
| `X-Gateway-Event-Id` | same for every retry of an event, so you can de-duplicate |
| `X-Gateway-Event` | e.g. `payment.captured` |

```json
{
  "entity": "event",
  "account_id": "acc_ZbLLDOMRvHsSDC",
  "event": "order.paid",
  "contains": ["payment", "order"],
  "payload": {
    "payment": { "entity": { "id": "pay_itDV2qMbyfwpKf", "status": "captured", "amount": 50000, "...": "..." } },
    "order":   { "entity": { "id": "order_fz8q7fkUZJ416o", "status": "paid", "...": "..." } }
  },
  "created_at": 1792836971
}
```

Respond with any `2xx` within 5 seconds. Failed deliveries are retried with exponential backoff (5s, 10s, 20s, … up to 8 attempts). `GET /v1/webhooks/{id}/deliveries` shows the delivery log.

Events can arrive out of order (for example `payment.captured` before `payment.authorized`) and an event can arrive more than once. Use `X-Gateway-Event-Id` to ignore duplicates, and use the entity's `status` rather than the arrival order.

Webhook URLs must resolve to public addresses. Loopback, private, link-local and similar addresses are refused, both when the endpoint is registered and before each delivery. To test with a receiver on your own machine, start the orchestrator with `GATEWAY_WEBHOOKS_ALLOW_PRIVATE_NETWORK=true`. Each merchant can register up to 10 endpoints. Endpoints are served round robin, with at most 2 deliveries per endpoint and 4 per merchant in flight, so a slow receiver only delays its own events. An endpoint that fails is paused with increasing back-off (up to an hour) and then probed again. Its other queued events wait during the pause without using up their retry attempts, and are delivered once it recovers.

## API reference

Merchant APIs use HTTP Basic auth with `key_id:key_secret`. Checkout APIs are called by `checkout.js` and only take the public `key_id`.

| Method | Path | Description |
| :--- | :--- | :--- |
| `POST` | `/v1/merchants` | Sign up (no auth). Returns `key_id` and `key_secret`. |
| `GET` | `/v1/merchants/me` | Current account |
| `POST` | `/v1/orders` | Create an order: `amount`, `currency`, `receipt`, `notes`, `payment_capture` |
| `GET` | `/v1/orders` | List orders (`count`, `skip`, `from`, `to`) |
| `GET` | `/v1/orders/{id}` | Fetch an order |
| `GET` | `/v1/orders/{id}/payments` | Payments made against an order |
| `GET` | `/v1/payments` | List payments |
| `GET` | `/v1/payments/{id}` | Fetch a payment |
| `POST` | `/v1/payments/{id}/capture` | Capture an authorized payment: `amount`, `currency` |
| `GET` | `/v1/payments/{id}/attempts` | Every bank rail tried while routing the payment (a rail skipped by its circuit breaker shows `response_code: "CB_OPEN"`) |
| `POST` | `/v1/payments/{id}/refund` | Refund: `amount` (optional), `receipt`, `notes`. Captured payments: full or partial. Authorized payments: full reversal only. Supports `Idempotency-Key`. |
| `GET` | `/v1/payments/{id}/refunds` | Refunds of a payment |
| `GET` | `/v1/refunds` | List refunds |
| `GET` | `/v1/refunds/{id}` | Fetch a refund |
| `POST` | `/v1/webhooks` | Register an endpoint: `url`, `secret`, `events` |
| `GET` | `/v1/webhooks`, `/v1/webhooks/{id}` | List / fetch endpoints |
| `DELETE` | `/v1/webhooks/{id}` | Remove an endpoint |
| `GET` | `/v1/webhooks/{id}/deliveries` | Recent deliveries with status and last response |
| `GET` | `/v1/analytics` | Totals across your payments: counts, `success_rate`, `gross_volume`, `captured_volume`, `refunded_volume`, `fees` (incl. GST), `taxes`, `net_settlement` (= captured − refunded − fees), breakdowns by status, method and rail. Amounts in paise. |
| `GET` | `/v1/checkout/orders/{id}?key_id=` | Order summary for checkout |
| `POST` | `/v1/checkout/payments` | Pay an order (used by checkout). Supports `Idempotency-Key`. |

Operator endpoints are not part of the merchant API and have **no authentication**, like the bank simulator's chaos controls. Expose them only on a trusted network.

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/ops/circuit-breakers` | State (`CLOSED`, `OPEN`, `HALF_OPEN`) and recent statistics of each rail's circuit breaker |
| `POST` | `/ops/circuit-breakers/{providerId}/reset` | Close a rail's breaker and clear its statistics, e.g. after the rail was restored |

Errors look like Razorpay's:

```json
{ "error": { "code": "BAD_REQUEST_ERROR", "description": "The amount must be at least INR 1.00 (100 paise).",
             "source": "business", "step": "NA", "reason": "input_validation_failed", "field": "amount", "metadata": {} } }
```

The complete reference, including request and response fields and the bank simulator and AI router endpoints, is in [docs/technical/03-api-reference.md](docs/technical/03-api-reference.md).

### Lifecycles

```
Payment:  created ──► authorized ──► captured ──► refunded
             │            ▲    └──────────────► refunded   reversal or automatic refund of an uncaptured payment
             └──► failed ─┘                                late authorization: the bank confirmed after all

Order:    created ──► attempted ──► paid
Refund:   pending ──► processed | failed
```

A partially refunded payment stays `captured` with `refund_status: partial`; it becomes `refunded` once fully refunded.

## AI smart routing

For every payment the orchestrator asks the AI router (`POST /v1/route`) in which order to try the rails, then reports each attempt's outcome back (`POST /v1/feedback`). The router never adds or drops rails: the gateway keeps only the rails it has configured and appends any the router left out. If the router fails or takes longer than 150 ms, the configured order is used, so the router can never block or break a payment.

How the order is chosen:

- **Live success rates (multi-armed bandit).** Each (rail, payment method) pair keeps a Beta belief about its success rate, updated by every attempt. Ranking samples from these beliefs (Thompson sampling), so the best rail gets most traffic while the others still get enough to notice changes. Old results count for less: each new result discounts the history (`AI_ROUTER_DISCOUNT`), and evidence halves every `AI_ROUTER_HALF_LIFE_SECONDS`. A rail that lost its traffic after a bad spell therefore drifts back to "unknown", is tried again, and wins its traffic back once it has recovered.
- **Trained model (optional).** A logistic regression predicts P(success | rail, method, amount, hour of day) from past attempts. When a model is loaded its prediction is blended in at `AI_ROUTER_MODEL_WEIGHT`; without one the router uses the bandit alone. The strategy used is logged by the orchestrator and returned by the router (`thompson_sampling` or `thompson_sampling+model`).

Train a model:

```bash
cd services/ai-router
# from the gateway's own attempts (export query in train.py), or synthesize data from the simulator:
.venv/bin/python generate_data.py --count 3000 --out data/attempts.csv
.venv/bin/python train.py data/attempts.csv --out models/routing-model.joblib   # prints accuracy and AUC
curl -X POST localhost:8000/v1/model/reload
```

Watch it work: with everything running, the demo sends payments through the real checkout API while it degrades provider-a to 20% success and then restores it.

```bash
AI_ROUTER_HALF_LIFE_SECONDS=15 .venv/bin/uvicorn app.main:app --port 8000   # short memory keeps the demo quick
.venv/bin/python demo.py --payments 60 --fade-wait 45
```

```
1. all rails healthy                   first rail tried -> provider-a: 66%, provider-b: 26%, provider-c: 6%
2. provider-a degraded to 20% success  first rail tried -> provider-a: 21%, provider-b: 73%, provider-c: 5%
3. provider-a recovered                first rail tried -> provider-a: 73%, provider-b: 25%, provider-c: 1%
```

These numbers come from one run; yours will differ because routing samples at random. `GET localhost:8000/v1/stats` shows the router's current beliefs per rail and the loaded model's metrics.

## Circuit breakers

The AI router learns which rail is *best*; the circuit breakers stop the gateway from wasting time on a rail that is *broken*. Each rail (`provider-a`, `provider-b`, `provider-c`) has its own Resilience4j breaker, configured in the `resilience4j` section of `services/payment-orchestrator/src/main/resources/application.yml`:

| Setting | Value | Meaning |
| :--- | :--- | :--- |
| `slidingWindowSize` | 10 | The breaker looks at the rail's last 10 calls. |
| `minimumNumberOfCalls` | 5 | It does not judge a rail before 5 calls. |
| `failureRateThreshold` | 50 | It opens when at least half of those calls failed. |
| `waitDurationInOpenState` | 5000 ms | After 5 seconds the next payment may try the rail again (half-open). |
| `permittedNumberOfCallsInHalfOpenState` | 3 for provider-a, the Resilience4j default (10) for the others | Trial calls allowed while half-open; if they succeed the breaker closes, otherwise it opens again. |

What counts:

- **Failure:** the rail was unavailable (503, connection refused, request rejected) or gave no usable answer (timeout, 502/504, unreadable response).
- **Success:** the bank answered, whether it approved or **declined** the charge. A decline means the rail works and the customer's bank said no, so a run of declines never opens the breaker.

While a breaker is open, the rail is skipped **without sending the charge**, which is always safe to fail over from. The skip is recorded as an attempt with status `unavailable`, `response_code: "CB_OPEN"` and latency 0, so `GET /v1/payments/{id}/attempts` shows exactly why a rail was not used. A breaker moves from open to half-open only when a payment arrives after the wait, so `/ops/circuit-breakers` can show `OPEN` for longer than 5 seconds on an idle system.

```bash
curl -s localhost:8080/ops/circuit-breakers                              # state, failure_rate, not_permitted_calls per rail
curl -s -X POST localhost:8080/ops/circuit-breakers/provider-a/reset     # close it again, e.g. after a chaos restore
```

Breaker state is kept in memory, per orchestrator instance, and starts closed after a restart. Set `GATEWAY_CIRCUIT_BREAKER_ENABLED=false` to turn the breakers off.

## Operations dashboard

`services/frontend` is a Next.js console for running the gateway in test mode from a browser. It talks to the real services through one typed client, [`services/frontend/src/lib/gateway.ts`](services/frontend/src/lib/gateway.ts).

```bash
cd services/frontend && npm install && npm run dev     # http://localhost:3000
```

The dashboard acts as **one sandbox merchant**: on first use it signs up through `POST /v1/merchants` and keeps the key id and key secret in the browser's `localStorage`. That is acceptable only for a local test-mode console; a real merchant keeps the key secret on its server. If the stored keys stop working (for example after a database reset) it creates a new sandbox merchant.

| Tab | What it does |
| :--- | :--- |
| Checkout | A direct API form (creates an order, then pays it through `POST /v1/checkout/payments`, with an editable `Idempotency-Key`) and a drop-in checkout modal. |
| Analytics | The sandbox merchant's `GET /v1/analytics` totals. |
| Circuits & Idempotency | Live circuit breakers from `/ops/circuit-breakers` with reset, and an idempotency stress test that sends many concurrent payments with the same `Idempotency-Key` and checks that only one payment is created. |
| Webhook Inspector | Registers webhook endpoints and shows their real deliveries (`/v1/webhooks`, `/v1/webhooks/{id}/deliveries`). |
| Developer API Keys | The sandbox merchant's test keys, with options to paste existing keys or start a new merchant. |
| Chaos Matrix | Kill, restore, slow down or degrade each simulator rail, or restore all. |
| Transaction Ledger | The merchant's payments with their rail attempts, and refunds (full or partial). |

Per-port consoles under `/services/{port}`: 8080 (orchestrator), 8081 (bank simulator), 8000 (AI router) and 5432 (database, read through the orchestrator's API) show live data. 8002 (fraud detector), 6380 (Redis), 9092 (Kafka) and 9090 (Prometheus) are clearly labelled **simulated previews** of roadmap components; no such service runs in this repository.

Configuration: copy `services/frontend/.env.example` to `.env.local` to point the dashboard at other hosts.

| Variable | Default |
| :--- | :--- |
| `NEXT_PUBLIC_ORCHESTRATOR_URL` | `http://localhost:8080` |
| `NEXT_PUBLIC_BANK_SIMULATOR_URL` | `http://localhost:8081` |
| `NEXT_PUBLIC_AI_ROUTER_URL` | `http://localhost:8000` |

The browser calls these services directly, so the orchestrator (`GATEWAY_CORS_ALLOWED_ORIGINS`) and the AI router (`AI_ROUTER_CORS_ORIGINS`) must allow the dashboard's origin; both allow `http://localhost:3000` and `http://127.0.0.1:3000` by default. The bank simulator allows any origin.

## Testing

### Test instruments

| Method | Succeeds | Declined |
| :--- | :--- | :--- |
| UPI | `success@gateway` | `failure@gateway` |
| Card | `4111 1111 1111 1111` | `4000 0000 0000 0002` |

Use any future expiry and any CVV. Every other UPI ID, card or bank succeeds at the rail's configured success rate. A killed rail still returns 503 for the test instruments.

### Chaos and failover

```bash
curl "localhost:8081/api/v1/chaos/kill?provider_id=provider-a"      # rail down -> payments fail over to the next rail
curl "localhost:8081/api/v1/chaos/restore?provider_id=provider-a"
curl "localhost:8081/api/v1/chaos/restore"                          # no provider_id (or provider_id=all): restore every rail
curl "localhost:8081/api/v1/chaos/latency?provider_id=provider-b&ms=900"
curl "localhost:8081/api/v1/chaos/success-rate?provider_id=provider-c&rate=0.5"
curl "localhost:8081/api/v1/chaos/status"
```

Then `GET /v1/payments/{id}/attempts` shows which rails were tried. Once a killed rail has been tried and failed 5 times (five payments in a row with the static order; more with the AI router, which soon stops putting a failing rail first), its circuit breaker opens: later payments skip it with a `CB_OPEN` attempt until it recovers or you reset the breaker. The [chaos testing guide](docs/user-guide/03-chaos-testing-guide.md) walks through these scenarios step by step.

### Automated tests

```bash
cd services/payment-orchestrator && ./mvnw test      # 65 tests: API integration tests (H2 + in-process fake bank) and unit tests
cd services/bank-simulator && go test -race ./...    # 9 tests, with the race detector
cd services/ai-router && .venv/bin/python -m pytest  # 11 tests
cd services/frontend && npm run typecheck && npm run build
```

### Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push to `main` and on pull requests: `./mvnw verify` for the orchestrator (JDK 17), `gofmt`, `go vet` and `go test -race` for the simulator, `pytest` for the AI router (Python 3.12), and `npm ci`, `npm run typecheck` and `npm run build` for the dashboard (Node 24). Run the same commands locally before opening a pull request.

## Documentation

[`docs/README.md`](docs/README.md) is the index. The documentation has three tracks:

- **Product and business** ([docs/non-technical](docs/non-technical/01-product-overview.md)): what the gateway does, payment economics, and a plain-English glossary.
- **Engineering** ([docs/technical](docs/technical/01-system-architecture.md)): architecture, state machines and flows, the full API reference, database schema, infrastructure, technology choices, and the phase breakdown with the roadmap.
- **User guides** ([docs/user-guide](docs/user-guide/01-quickstart-and-setup.md)): setup, merchant checkout testing, chaos testing, and tools.

## Limitations

- Test mode only: INR, a simulated bank, no settlements or payouts yet.
- The background jobs (webhook dispatcher, refund retries, automatic refunds, reconciliation) assume a single orchestrator instance. Circuit breaker state is also per instance and in memory.
- Merchant signup is open and nothing is rate limited. A shared deployment needs signup verification and rate limits at the edge; otherwise many accounts could, for example, tie up webhook senders with slow receivers or slow DNS.
- The operator endpoints (`/ops`), the bank simulator's chaos API and the AI router have no authentication. Run them on a trusted network only.
- The operations dashboard stores its sandbox merchant's key secret in browser `localStorage`. It is a local test-mode tool, not a merchant dashboard.
- The webhook SSRF check resolves the host before connecting. A DNS answer that changes between the check and the connection (DNS rebinding) is not fully prevented; a production deployment should also send webhooks through an egress proxy.
- A payment whose outcome the bank never confirms within 24 hours is logged for manual reconciliation.
- The AI router keeps its live success rates in memory, per router instance; they start from scratch when it restarts (the trained model is loaded from disk). Several router instances would each learn separately.
- Redis is provisioned by the compose file but not used by any service yet. Fraud detection, Kafka event streaming and Prometheus/Grafana metrics are on the roadmap, not implemented.
- Schema changes are applied with Hibernate `ddl-auto: update`. Production would use versioned migrations (Flyway/Liquibase).
