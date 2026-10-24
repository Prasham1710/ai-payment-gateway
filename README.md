# AI Payment Gateway

A Razorpay-style payment gateway built on a multi-rail **payment orchestrator**. Merchants integrate the way they would with Razorpay (Orders API, a drop-in checkout, signature verification, webhooks), while every payment is routed across several bank rails with automatic failover.

> Test mode only. Payments run against the bundled Go bank simulator; no real money moves.

## Features

| Area | What you get |
| :--- | :--- |
| **Merchant accounts & API keys** | Sign up via API, get a `key_id` / `key_secret` pair, authenticate with HTTP Basic auth. Secrets are AES-256-GCM encrypted at rest. |
| **Orders API** | Create an order server-side with the amount (in paise), receipt and notes before taking payment. |
| **Hosted checkout (`checkout.js`)** | Drop-in modal with UPI, cards and netbanking. Mobile friendly. Card numbers and CVVs are never stored (only last 4 + network). |
| **Authorize → capture** | Auto-capture (default) or manual capture via API. Platform fee (2%) and GST (18% of fee) are computed on capture. |
| **Payment signature** | Checkout returns `HMAC_SHA256(order_id + "\|" + payment_id, key_secret)` so your server can prove the result is genuine. |
| **Refunds** | Full and partial refunds. The amount is reserved immediately, so concurrent refunds can never exceed what was captured. If the bank rail is down the refund stays `pending` and is retried automatically. |
| **Webhooks** | `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`, `refund.created`, `refund.processed`, `refund.failed`. Signed with HMAC-SHA256, written to an outbox in the same DB transaction as the change, retried with exponential backoff. |
| **Smart routing & failover** | Each payment tries HDFC → ICICI → SBI rails. It fails over only when a rail is down; a bank decline or an unresolved timeout is never retried elsewhere (that would double-charge the customer). Every attempt is recorded. |
| **Razorpay API conventions** | Amounts in paise, prefixed ids (`order_…`, `pay_…`, `rfnd_…`), snake_case JSON, `{"error": {code, description, source, step, reason, field, metadata}}` errors, `count`/`skip`/`from`/`to` collections, `Idempotency-Key` support. |

## Architecture

```
 Merchant server ──(Basic auth: key_id:key_secret)──► Payment Orchestrator (Spring Boot, :8080) ──► PostgreSQL
 Customer browser ─(checkout.js, key_id only)───────►   ├─ orders / payments / refunds / webhooks
                                                        ├─ smart routing + failover ──► Go Bank Simulator (:8081)
                                                        └─ webhook dispatcher ────────► merchant webhook URL
```

| Component | Tech | Port |
| :--- | :--- | :--- |
| Payment orchestrator + hosted checkout | Java 17, Spring Boot 3.2 | 8080 |
| Bank & provider simulator (3 rails, chaos controls) | Go | 8081 |
| Database | PostgreSQL 16 | 5432 |
| Cache (reserved for Phase 2 locks/velocity) | Redis 7 | 6380 |

See [`flow.md`](flow.md) for the full payment flow and roadmap.

## Quick start

Prerequisites: Docker, Go 1.20+, Java 17+ and Maven 3.9+.

```bash
# 1. PostgreSQL + Redis
docker compose -f docker/docker-compose.yml up -d
#    Upgrading from the Phase 1 schema? Reset the dev database first:
#    docker compose -f docker/docker-compose.yml down -v && docker compose -f docker/docker-compose.yml up -d

# 2. Bank simulator
cd services/bank-simulator && go run .

# 3. Orchestrator (new terminal)
cd services/payment-orchestrator && mvn spring-boot:run
```

Open **http://localhost:8080**. The demo store creates a test merchant, opens checkout, verifies the signature, and lets you capture and refund from one page.

Set `GATEWAY_MASTER_KEY` (base64 of 32 random bytes, e.g. `openssl rand -base64 32`) anywhere other than your laptop. The default key in `application.yml` is for local development only.

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

Leave out `amount` to refund everything that is left. The `Idempotency-Key` makes retries safe.

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
| `GET` | `/v1/payments/{id}/attempts` | Every bank rail tried while routing the payment |
| `POST` | `/v1/payments/{id}/refund` | Refund: `amount` (optional), `receipt`, `notes`. Supports `Idempotency-Key`. |
| `GET` | `/v1/payments/{id}/refunds` | Refunds of a payment |
| `GET` | `/v1/refunds` | List refunds |
| `GET` | `/v1/refunds/{id}` | Fetch a refund |
| `POST` | `/v1/webhooks` | Register an endpoint: `url`, `secret`, `events` |
| `GET` | `/v1/webhooks`, `/v1/webhooks/{id}` | List / fetch endpoints |
| `DELETE` | `/v1/webhooks/{id}` | Remove an endpoint |
| `GET` | `/v1/webhooks/{id}/deliveries` | Recent deliveries with status and last response |
| `GET` | `/v1/checkout/orders/{id}?key_id=` | Order summary for checkout |
| `POST` | `/v1/checkout/payments` | Pay an order (used by checkout). Supports `Idempotency-Key`. |

Errors look like Razorpay's:

```json
{ "error": { "code": "BAD_REQUEST_ERROR", "description": "The amount must be at least INR 1.00 (100 paise).",
             "source": "business", "step": "NA", "reason": "input_validation_failed", "field": "amount", "metadata": {} } }
```

### Lifecycles

```
Payment:  created ──► authorized ──► captured ──► refunded   (refunded only once fully refunded;
             │                                                partial refunds keep it captured
             └──► failed                                      with refund_status = partial)

Order:    created ──► attempted ──► paid
Refund:   pending ──► processed | failed
```

## Testing

### Test instruments

| Method | Succeeds | Declined |
| :--- | :--- | :--- |
| UPI | `success@gateway` | `failure@gateway` |
| Card | `4111 1111 1111 1111` | `4000 0000 0000 0002` |

Use any future expiry and any CVV. Every other UPI ID, card or bank succeeds at the rail's configured success rate.

### Chaos and failover

```bash
curl "localhost:8081/api/v1/chaos/kill?provider_id=provider-a"      # rail down -> payments fail over to provider-b
curl "localhost:8081/api/v1/chaos/restore?provider_id=provider-a"
curl "localhost:8081/api/v1/chaos/latency?provider_id=provider-b&ms=900"
curl "localhost:8081/api/v1/chaos/success-rate?provider_id=provider-c&rate=0.5"
curl "localhost:8081/api/v1/chaos/status"
```

Then `GET /v1/payments/{id}/attempts` shows which rails were tried.

### Automated tests

```bash
cd services/payment-orchestrator && mvn test   # API integration tests (H2 + in-process fake bank)
cd services/bank-simulator && go test -race ./...
```

## Limitations

- Test mode only: INR, a simulated bank, no settlements or payouts yet.
- The webhook dispatcher and refund retry job assume a single orchestrator instance.
- Webhook URLs are not restricted. A shared deployment should block private and internal addresses (SSRF).
- Schema changes are applied with Hibernate `ddl-auto: update`. Production would use versioned migrations (Flyway/Liquibase).
