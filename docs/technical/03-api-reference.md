# API Reference

This reference covers the three HTTP services:

1. [Payment orchestrator](#1-payment-orchestrator-httplocalhost8080) (`http://localhost:8080`): merchant API, checkout API, operator API.
2. [Bank simulator](#2-bank-simulator-httplocalhost8081) (`http://localhost:8081`): bank rails and chaos controls.
3. [AI router](#3-ai-router-httplocalhost8000) (`http://localhost:8000`): rail ordering.

Source of truth: the controllers in `services/payment-orchestrator/src/main/java/com/gateway/orchestrator/api/`, `services/bank-simulator/main.go` and `services/ai-router/app/main.py`.

---

## 1. Payment orchestrator (`http://localhost:8080`)

### 1.1 Conventions

| Topic | Rule |
| :--- | :--- |
| Format | JSON request and response bodies with **snake_case** keys. Unknown request fields are ignored. |
| Amounts | Whole **paise** (`50000` = ₹500.00). Decimals such as `500.00` are rejected with 400. Minimum 100, maximum 10,000,000,000 (₹10 crore). Currency: `INR` only (the default when omitted). |
| Ids | Prefixed, 14 random base62 characters: `acc_` merchant, `key_test_` key id, `order_`, `pay_`, `tx_` (rail attempt), `rfnd_`, `wh_` webhook endpoint, `whd_` delivery, `evt_` event. |
| Timestamps | Unix seconds (`created_at`). |
| Statuses | Lower case in responses (`captured`, `pending`, …). |
| Authentication | Merchant API: HTTP Basic, username `key_id`, password `key_secret`. Not required for `POST /v1/merchants`, `/v1/checkout/**`, `/ops/**` and the static files. A missing or wrong key gives 401 with `WWW-Authenticate: Basic realm="gateway"`. |
| Idempotency | Optional `Idempotency-Key` header (1–64 characters) on `POST /v1/checkout/payments` and `POST /v1/payments/{id}/refund`. See [idempotency](02-state-machine-and-flows.md#4-idempotency-and-concurrency). |
| Collections | `{"entity": "collection", "count": <items returned>, "items": [...]}`. The paged lists (`/v1/orders`, `/v1/payments`, `/v1/refunds`) are newest first; `count` is the number of items returned, not a total. |
| List filters | `count` (1–100, default 10), `skip` (≥ 0, default 0), `from` and `to` (unix seconds, inclusive bounds on `created_at`). |
| CORS | Allowed for `GATEWAY_CORS_ALLOWED_ORIGINS` on `/v1/**` and `/ops/**` (methods `GET`, `POST`, `DELETE`; headers `Authorization`, `Content-Type`, `Idempotency-Key`). |

### 1.2 Errors

Every error uses Razorpay's shape:

```json
{
  "error": {
    "code": "BAD_REQUEST_ERROR",
    "description": "The amount must be at least INR 1.00 (100 paise).",
    "source": "business",
    "step": "NA",
    "reason": "input_validation_failed",
    "field": "amount",
    "metadata": {}
  }
}
```

| HTTP | `code` | Typical cause |
| :--- | :--- | :--- |
| 400 | `BAD_REQUEST_ERROR` | Validation failed (`reason: input_validation_failed`, `field` names the input), a bank decline at checkout (`source: bank`), malformed JSON or a wrongly typed field. |
| 401 | `BAD_REQUEST_ERROR` | `Authentication failed`: missing or wrong API key, or an unknown `key_id` at checkout. |
| 404 | `BAD_REQUEST_ERROR` | Unknown or other merchant's id (`The id provided does not exist`), unknown order at checkout, unknown rail on `/ops`, unknown URL. |
| 409 | `BAD_REQUEST_ERROR` | A payment for the order is already in progress, an `Idempotency-Key` replay of a payment still being processed, or a concurrent duplicate caught by a unique index. |
| 502 | `GATEWAY_ERROR` / `SERVER_ERROR` | Checkout only: all rails unavailable, the bank's answer is unknown, or an internal error while routing. |
| 500 | `SERVER_ERROR` | Unexpected server error. |

`field` is omitted when it does not apply. Fields not set are reported as `"NA"` (`source`, `step`, `reason`).

### 1.3 Merchants

#### `POST /v1/merchants` (no auth)

Creates a test-mode merchant account and its API key pair.

| Field | Type | Rules |
| :--- | :--- | :--- |
| `name` | string | Required, 1–120 characters. |
| `email` | string | Required, valid email, unique across merchants (stored in lower case). |

Response `200`:

```json
{ "id": "acc_ZbLLDOMRvHsSDC", "entity": "merchant", "name": "Acme Store", "email": "owner@acme.test",
  "key_id": "key_test_QdTbA1lGIYcrY0", "key_secret": "PhT3fpEzPDEQBtQkmHaxjkO1", "created_at": 1792836971 }
```

`key_secret` is returned only here and never again.

#### `GET /v1/merchants/me`

The authenticated merchant, same shape without `key_secret`.

### 1.4 Orders

#### `POST /v1/orders`

| Field | Type | Rules |
| :--- | :--- | :--- |
| `amount` | integer (paise) | Required, 100 to 10,000,000,000. |
| `currency` | string | Optional, `INR`. |
| `receipt` | string | Optional, up to 40 characters. |
| `notes` | object of strings | Optional, up to 15 keys; keys and values up to 256 characters. |
| `payment_capture` | boolean | Optional, default `true`. `false` leaves payments `authorized` until you capture them. |

Response `200`, the order:

```json
{ "id": "order_fz8q7fkUZJ416o", "entity": "order", "amount": 50000, "amount_paid": 0, "amount_due": 50000,
  "currency": "INR", "receipt": "rcpt_001", "status": "created", "attempts": 0,
  "notes": { "sku": "HP-01" }, "created_at": 1792836971 }
```

`status`: `created`, `attempted` or `paid`.

#### `GET /v1/orders`

List filters: `count`, `skip`, `from`, `to`.

#### `GET /v1/orders/{id}`

One order.

#### `GET /v1/orders/{id}/payments`

All payments made against the order, oldest first.

### 1.5 Payments

#### The payment object

```json
{
  "id": "pay_itDV2qMbyfwpKf", "entity": "payment", "amount": 50000, "currency": "INR",
  "status": "captured", "order_id": "order_fz8q7fkUZJ416o", "method": "upi",
  "amount_refunded": 0, "refund_status": null, "captured": true,
  "card": null, "bank": null, "vpa": "success@gateway",
  "email": "ravi@example.com", "contact": "9876543210",
  "fee": 1180, "tax": 180,
  "error_code": null, "error_description": null, "error_source": null, "error_step": null, "error_reason": null,
  "acquirer_data": { "bank_reference": "BANKREF_5499420840" },
  "provider": "provider-b", "attempts": 2, "created_at": 1792836971
}
```

| Field | Notes |
| :--- | :--- |
| `status` | `created`, `authorized`, `captured`, `refunded`, `failed`. See [payment lifecycle](02-state-machine-and-flows.md#2-payment-lifecycle). |
| `method` | `upi`, `card` or `netbanking`. |
| `card` | `{ "last4": "1111", "network": "Visa" }` for card payments, else `null`. Networks: `Visa`, `MasterCard`, `American Express`, `RuPay`, `Unknown`. |
| `bank` | Netbanking bank code (`HDFC`, `ICIC`, `SBIN`, `UTIB`, `KKBK`). |
| `amount_refunded`, `refund_status` | Amount reserved by refunds (pending or processed) and `partial` / `full` / `null`. |
| `fee`, `tax` | Set on capture: platform fee including GST, and the GST part. |
| `error_*` | Set when `failed`. See [failure reasons](02-state-machine-and-flows.md#failure-reasons). |
| `acquirer_data.bank_reference` | The approving bank's reference. |
| `provider`, `attempts` | The rail that approved the payment, or the rail where routing stopped (`null` if every rail was unavailable), and how many rails were considered, including rails skipped by a circuit breaker. |

#### `GET /v1/payments`

List filters: `count`, `skip`, `from`, `to`.

#### `GET /v1/payments/{id}`

One payment.

#### `POST /v1/payments/{id}/capture`

| Field | Type | Rules |
| :--- | :--- | :--- |
| `amount` | integer (paise) | Required, must equal the authorized amount. |
| `currency` | string | Optional, must match the payment (`INR`). |

Only `authorized`, not yet captured payments. Refused with 400 if the order was already paid by another payment (that payment will be refunded automatically). Response: the captured payment.

#### `GET /v1/payments/{id}/attempts`

Every rail considered while routing, oldest first:

```json
{ "entity": "collection", "count": 2, "items": [
  { "id": "tx_8Hc2kLmQ0aZr1T", "entity": "payment_attempt", "provider": "provider-a", "status": "unavailable",
    "response_code": "CB_OPEN", "message": "Circuit breaker open: rail skipped without sending the charge",
    "bank_reference": null, "latency_ms": 0, "created_at": 1792836971 },
  { "id": "tx_Jw4nB7pX2sYq9e", "entity": "payment_attempt", "provider": "provider-b", "status": "success",
    "response_code": "00", "message": "Transaction Approved",
    "bank_reference": "BANKREF_5499420840", "latency_ms": 184, "created_at": 1792836971 } ] }
```

`status`: `success`, `declined`, `unavailable` or `unknown`. `response_code` is the bank's code (`00` approved, `51` declined, `503` rail killed, `09` still processing) or `CB_OPEN` for a rail skipped by its circuit breaker.

#### `POST /v1/payments/{id}/refund`

Headers: optional `Idempotency-Key`. Body (optional):

| Field | Type | Rules |
| :--- | :--- | :--- |
| `amount` | integer (paise) | Optional. Default: everything not yet refunded. For an `authorized` (uncaptured) payment it must be omitted or equal the full amount. |
| `receipt` | string | Optional, up to 40 characters. |
| `notes` | object of strings | Optional, same limits as orders. |

Response `200`, the refund:

```json
{ "id": "rfnd_Fq3ZpL0xYv8KcD", "entity": "refund", "amount": 20000, "currency": "INR",
  "payment_id": "pay_itDV2qMbyfwpKf", "notes": { "reason": "size exchange" }, "receipt": null,
  "acquirer_data": { "arn": "ARN4829174621" }, "status": "processed", "failure_reason": null,
  "created_at": 1792836971 }
```

`status`: `pending`, `processed` or `failed`. The first bank attempt happens during the request, so the response is usually already `processed`; it stays `pending` if the rail is down and is retried in the background.

#### `GET /v1/payments/{id}/refunds`

Refunds of one payment, oldest first.

### 1.6 Refunds

#### `GET /v1/refunds`

List filters: `count`, `skip`, `from`, `to`.

#### `GET /v1/refunds/{id}`

One refund.

### 1.7 Webhooks

#### `POST /v1/webhooks`

| Field | Type | Rules |
| :--- | :--- | :--- |
| `url` | string | Required, `http` or `https`, up to 2048 characters. Must resolve to a public address unless `GATEWAY_WEBHOOKS_ALLOW_PRIVATE_NETWORK=true`. |
| `secret` | string | Required, 8–128 characters. Used to sign deliveries; stored encrypted. |
| `events` | array of strings | Required. Any of `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`, `refund.created`, `refund.processed`, `refund.failed`, or `["*"]` for all. |

At most 10 endpoints per merchant. Response:

```json
{ "id": "wh_3RkT9bQx1mPz7L", "entity": "webhook", "url": "https://your.server/webhooks/gateway",
  "events": ["*"], "active": true, "created_at": 1792836971 }
```

#### `GET /v1/webhooks`, `GET /v1/webhooks/{id}`

List (oldest first, no paging) or fetch endpoints. The secret is never returned.

#### `DELETE /v1/webhooks/{id}`

Removes the endpoint; its pending deliveries are marked `failed`. Response `204 No Content`.

#### `GET /v1/webhooks/{id}/deliveries`

Most recent deliveries first; `count` 1–100, default 10.

```json
{ "entity": "collection", "count": 1, "items": [
  { "id": "whd_Vb6sN2qW8eHk4J", "entity": "webhook_delivery", "event_id": "evt_P0aZ7cT5yR1uXm",
    "event": "payment.captured", "status": "delivered", "attempts": 1, "last_response_code": 200,
    "last_error": null, "next_attempt_at": null, "delivered_at": 1792836972, "created_at": 1792836971 } ] }
```

`status`: `pending`, `delivered` or `failed`. `next_attempt_at` is only set while `pending`.

#### What a delivery looks like

`POST` to the endpoint URL with `Content-Type: application/json` and:

| Header | Value |
| :--- | :--- |
| `X-Gateway-Signature` | Hex `HMAC_SHA256(raw_body, webhook_secret)` |
| `X-Gateway-Event-Id` | The `evt_…` id, the same for every retry and every endpoint receiving the event |
| `X-Gateway-Event` | The event name |
| `User-Agent` | `AI-Payment-Gateway-Webhooks/1.0` |

Body:

```json
{ "entity": "event", "account_id": "acc_ZbLLDOMRvHsSDC", "event": "order.paid", "contains": ["payment", "order"],
  "payload": { "payment": { "entity": { "...": "payment object" } }, "order": { "entity": { "...": "order object" } } },
  "created_at": 1792836971 }
```

Answer with any 2xx within 5 seconds. Retry schedule and fairness rules: [webhooks](02-state-machine-and-flows.md#10-webhooks-outbox-and-delivery).

### 1.8 Analytics

#### `GET /v1/analytics`

Totals over all of the authenticated merchant's payments. All amounts in paise.

```json
{
  "entity": "analytics", "currency": "INR",
  "payments": 4, "successful_payments": 3, "failed_payments": 1, "success_rate": 75.0,
  "gross_volume": 150000, "captured_volume": 150000, "refunded_volume": 20000,
  "fees": 3540, "taxes": 540, "net_settlement": 126460, "average_payment_value": 50000,
  "count_by_status": { "captured": 3, "failed": 1 },
  "count_by_method": { "card": 1, "upi": 3 },
  "successful_by_provider": { "provider-a": 2, "provider-b": 1 }
}
```

| Field | Definition |
| :--- | :--- |
| `payments` | All payments, including `failed` and `created` (in progress). |
| `successful_payments` | Payments in `authorized`, `captured` or `refunded`. |
| `failed_payments` | Payments in `failed`. |
| `success_rate` | `successful_payments / (payments − created) × 100`, one decimal; `0` when nothing has finished. |
| `gross_volume` | Sum of `amount` over successful payments. |
| `captured_volume` | Sum of `amount` over payments that were captured (including ones refunded since). |
| `refunded_volume` | Sum of `amount_refunded` over all payments: pending and processed refunds, including full reversals of payments that were never captured. |
| `fees`, `taxes` | Sum of `fee` (including GST) and `tax` (the GST part). |
| `net_settlement` | `captured_volume − refunded_volume − fees`. |
| `average_payment_value` | `gross_volume / successful_payments`, rounded; `0` if none. |
| `count_by_status`, `count_by_method` | Payment counts keyed by lower-case status and method. |
| `successful_by_provider` | Successful payments per rail. |

### 1.9 Checkout API (public)

Used by `checkout.js` and the dashboard. Runs in the customer's browser, so it takes the public `key_id` and never the secret.

#### `GET /v1/checkout/orders/{id}?key_id=`

```json
{ "order_id": "order_fz8q7fkUZJ416o", "amount": 50000, "currency": "INR", "status": "created", "merchant_name": "Acme Store" }
```

#### `POST /v1/checkout/payments`

Headers: optional `Idempotency-Key`.

| Field | Type | Rules |
| :--- | :--- | :--- |
| `key_id` | string | Required. Unknown → 401. |
| `order_id` | string | Required; the merchant's order. |
| `method` | string | Required: `upi`, `card` or `netbanking`. |
| `vpa` | string | UPI: `handle@psp`, e.g. `success@gateway`. |
| `card` | object | Card: `number` (12–19 digits, Luhn-valid), `name`, `expiry_month` (1–12), `expiry_year` (2 or 4 digits, not expired), `cvv` (3 digits, 4 for American Express). Only last 4 and network are stored. |
| `bank` | string | Netbanking: `HDFC`, `ICIC`, `SBIN`, `UTIB` or `KKBK`. |
| `email` | string | Optional, valid email. |
| `contact` | string | Optional, 8–15 digits, optional leading `+`. |

Success `200`:

```json
{ "payment_id": "pay_itDV2qMbyfwpKf", "order_id": "order_fz8q7fkUZJ416o",
  "signature": "a7c1…(hex HMAC_SHA256(order_id|payment_id, key_secret))", "status": "captured" }
```

`status` is `captured` with auto-capture, else `authorized`. Failure: 400 (declined) or 502 (gateway or bank problem) with the payment's error and `metadata: {payment_id, order_id}`; 409 while another payment for the order is in progress. Payment routing rules: [routing and failover](02-state-machine-and-flows.md#5-routing-and-failover).

### 1.10 Operator API (no authentication)

For the operations dashboard. Not part of the merchant API; expose only on a trusted network.

#### `GET /ops/circuit-breakers`

One entry per configured rail:

```json
{ "entity": "collection", "count": 3, "items": [
  { "entity": "circuit_breaker", "provider_id": "provider-a", "state": "OPEN", "failure_rate": 100.0,
    "buffered_calls": 5, "failed_calls": 5, "successful_calls": 0, "not_permitted_calls": 3,
    "failure_rate_threshold": 50.0, "minimum_number_of_calls": 5, "wait_duration_in_open_state_ms": 5000 },
  { "entity": "circuit_breaker", "provider_id": "provider-b", "state": "CLOSED", "failure_rate": -1.0,
    "buffered_calls": 3, "failed_calls": 0, "successful_calls": 3, "not_permitted_calls": 0,
    "failure_rate_threshold": 50.0, "minimum_number_of_calls": 5, "wait_duration_in_open_state_ms": 5000 },
  { "...": "provider-c" } ] }
```

| Field | Meaning |
| :--- | :--- |
| `state` | `CLOSED`, `OPEN`, `HALF_OPEN` (or `DISABLED`, `FORCED_OPEN`, `METRICS_ONLY` if set by hand). |
| `failure_rate` | Percent failed in the sliding window; `-1` until `minimum_number_of_calls` calls were recorded. |
| `buffered_calls`, `failed_calls`, `successful_calls` | Calls in the current window. |
| `not_permitted_calls` | Payments that skipped the rail because the breaker was open. |

Breakers are listed even when `GATEWAY_CIRCUIT_BREAKER_ENABLED=false`; they then simply record nothing.

#### `POST /ops/circuit-breakers/{providerId}/reset`

Closes the rail's breaker and clears its statistics. Returns the breaker as above. Unknown rail → 404.

### 1.11 Static files

| Path | Content |
| :--- | :--- |
| `GET /` | Demo store: signs up a sandbox merchant (or uses pasted keys), creates an order, opens checkout, verifies the signature, captures and refunds. |
| `GET /checkout.js` | The drop-in checkout script (`new GatewayCheckout({...})`). |
| `GET /checkout/frame.html` | The hosted checkout page that `checkout.js` opens in an iframe. |

---

## 2. Bank simulator (`http://localhost:8081`)

Unauthenticated, in-memory, CORS open to any origin. Amounts are in **rupees** (decimal), not paise.

### Rails

| `provider_id` | Name | Default success rate | Default latency | `cost_inr` |
| :--- | :--- | :--- | :--- | :--- |
| `provider-a` | HDFC Direct Rail | 0.96 | 120 ms | 2.00 |
| `provider-b` | ICICI Payment Rail | 0.92 | 180 ms | 1.50 |
| `provider-c` | SBI Gateway Rail | 0.88 | 250 ms | 1.00 |

Test instruments override the success rate (not the kill switch): VPA `success@gateway` or card ending `1111` always approve; VPA `failure@gateway` or card ending `0002` always decline.

### `POST /api/v1/bank/charge`

Request:

```json
{ "transaction_id": "tx_Jw4nB7pX2sYq9e", "provider_id": "provider-b", "amount": 500.00, "currency": "INR",
  "payment_method": "UPI", "customer_vpa": "success@gateway", "card_last4": "", "bank_code": "" }
```

`transaction_id` defaults to a generated `tx_sim_…` and `provider_id` to `provider-a`. The charge is recorded as `PENDING` (code `09`) on receipt, then the rail's latency is simulated.

| HTTP | `status` | `response_code` | When |
| :--- | :--- | :--- | :--- |
| 200 | `SUCCESS` | `00` | Approved; `bank_reference` = `BANKREF_<10 digits>`. |
| 400 | `FAILED` | `51` | Declined (`Declined by issuing bank (Insufficient funds / Risk block)`). |
| 503 | `FAILED` | `503` | Rail killed; answered immediately. |
| 404 | (plain text) | | Unknown `provider_id`. |
| 400 | (plain text) | | Body is not valid JSON. |

Response body: `transaction_id`, `provider_id`, `status`, `bank_reference`, `response_code`, `message`, `latency_ms`, `timestamp` (RFC 3339).

### `GET /api/v1/bank/status?transaction_id=`

Status enquiry. Also accepts `tx_id` as the parameter name. Returns the recorded charge (same shape as above; `status` may be `PENDING`), or 404 if the simulator has no record of it, or 400 without an id.

### `POST /api/v1/bank/refund`

```json
{ "refund_id": "rfnd_Fq3ZpL0xYv8KcD", "transaction_id": "tx_Jw4nB7pX2sYq9e", "provider_id": "provider-b",
  "amount": 200.00, "currency": "INR" }
```

| HTTP | `status` | When |
| :--- | :--- | :--- |
| 200 | `PROCESSED` | Refunded; `bank_reference` = `ARN<10 digits>`. A repeated `refund_id` returns the original result. |
| 422 | `FAILED` | The original charge is known and was not successful (`response_code` `12`). |
| 503 | (message) | Rail killed (nothing recorded), or the same `refund_id` is being processed right now. |
| 404 | (message) | Unknown `provider_id`. |
| 400 | (message) | Missing `refund_id` or non-positive `amount`. |

Charges from before a simulator restart are unknown to it and are refunded.

### Chaos controls

Query parameters; any HTTP method works (the dashboard uses `POST`, the README uses `GET`).

| Path | Parameters | Effect |
| :--- | :--- | :--- |
| `/api/v1/chaos/status` | none | Returns all rails: `{"provider-a": {"id", "name", "success_rate", "latency_ms", "is_killed", "cost_inr"}, ...}` |
| `/api/v1/chaos/kill` | `provider_id` | Rail answers 503 to charges and refunds. |
| `/api/v1/chaos/restore` | `provider_id`, or none / `all` | Un-kills one rail, or every rail. |
| `/api/v1/chaos/latency` | `provider_id`, `ms` (≥ 0) | Sets the simulated latency. Above the orchestrator's 8 s read timeout, charges become "unknown outcome". |
| `/api/v1/chaos/success-rate` | `provider_id`, `rate` (0.0–1.0) | Sets the approval probability. |

Single-rail actions return `{"message": "...", "status": {rail}}`; unknown rail → 404; invalid `ms` or `rate` → 400.

---

## 3. AI router (`http://localhost:8000`)

FastAPI service, no authentication. CORS for `AI_ROUTER_CORS_ORIGINS` (methods `GET`, `POST`). Validation errors return FastAPI's standard 422 response. Interactive docs are served by FastAPI at `/docs`.

### `GET /health`

```json
{ "status": "ok", "model_version": "lr-20261026T101500Z" }
```

`model_version` is `null` when no model is loaded.

### `POST /v1/route`

| Field | Type | Rules |
| :--- | :--- | :--- |
| `providers` | array of strings | 1–20 rail ids matching `^[a-zA-Z0-9_.-]{1,30}$`; duplicates are dropped. |
| `payment_method` | string | `UPI`, `CARD` or `NETBANKING` (any case). |
| `amount` | integer | Paise, > 0. |
| `currency` | string | Optional, default `INR`. |
| `hour` | integer | Optional 0–23; default: the current hour in `AI_ROUTER_TIMEZONE`. |

```json
{ "providers": ["provider-b", "provider-a", "provider-c"],
  "scores": { "provider-a": 0.8112, "provider-b": 0.9034, "provider-c": 0.7421 },
  "expected_success": { "provider-a": 0.85, "provider-b": 0.9, "provider-c": 0.8 },
  "strategy": "thompson_sampling", "model_version": null }
```

`providers` is sorted by `scores` (highest first). `strategy` is `thompson_sampling+model` when a loaded model scored at least one rail.

### `POST /v1/feedback`

| Field | Type | Rules |
| :--- | :--- | :--- |
| `provider` | string | Rail id. |
| `payment_method` | string | `UPI`, `CARD` or `NETBANKING`. |
| `outcome` | string | `success`, `declined`, `unavailable` or `unknown`. Only `success` counts as a success. |
| `amount` | integer | Optional, > 0. |
| `latency_ms` | integer | Optional, ≥ 0. |

Response: `{"ok": true}`.

### `GET /v1/stats`

```json
{ "model_version": null, "model_metrics": null,
  "arms": [ { "provider": "provider-a", "payment_method": "UPI", "alpha": 12.4, "beta": 2.1,
              "expected_success": 0.8552, "observations": 15 } ] }
```

With a model loaded, `model_metrics` has `rows`, `test_accuracy`, `test_auc` and `observed_success_by_provider`.

### `POST /v1/model/reload`

Loads the model file at `AI_ROUTER_MODEL_PATH` again. Response `{"loaded": true, "model_version": "lr-…"}`, or `loaded: false` when the file does not exist. A corrupt or incompatible file gives 500 and the router keeps serving without a model.
