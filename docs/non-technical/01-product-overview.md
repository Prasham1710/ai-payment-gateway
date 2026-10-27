# Product Overview

## 1. Summary

When a customer taps **Pay** in an online store, the payment passes through the merchant, a payment gateway, a bank connection ("rail") and the customer's bank. If any link in that chain fails, the sale is lost or, worse, the customer is charged and the merchant does not know it.

The **AI Payment Gateway** is a payment gateway in the style of Razorpay that sits between merchants and several bank rails. Merchants integrate once (an Orders API, a drop-in checkout, signed results and webhooks). Behind that single integration, the gateway decides which bank rail to use for each payment, moves traffic away from rails that are failing, and keeps track of every attempt so that no payment is lost and no customer is charged twice.

This repository runs entirely in **test mode**. The banks are simulated by a bundled service, so no real money moves. It is a working reference implementation, not a licensed payment processor.

---

## 2. How it relates to real payment gateways

* **Razorpay** (India) gives merchants an Orders API, a hosted checkout, payment signatures and webhooks. This gateway follows the same conventions: amounts in paise, ids like `order_…` and `pay_…`, the same error format, and the same "create order, open checkout, verify signature" integration.
* **Payment orchestration platforms** (such as Juspay in India, or the multi-acquirer setups of large merchants) connect to several banks and route each payment to the one most likely to succeed. This gateway does the same across its three simulated rails.

### Single bank versus multiple rails

```text
SINGLE BANK:
Merchant website ────> One bank connection ────> [every payment fails while that bank is down]

ORCHESTRATED:
Merchant website ────> Payment gateway ────┬───> Provider A (HDFC profile)
                                           ├───> Provider B (ICICI profile)
                                           └───> Provider C (SBI profile)
```

With a single bank connection:

1. When that bank is down, every payment fails until it comes back.
2. When a network glitch makes the customer's phone send the payment twice, a naive integration can charge the customer twice.

The gateway reduces both risks. It cannot make a declined card succeed, and it cannot help if every rail is down at once, but it can route around a single failing rail and it guarantees that a retried request does not create a second payment.

---

## 3. Key capabilities

### A. Multi-rail routing with safe failover

The gateway is connected to three simulated rails. The simulator's default profiles are:

| Rail | Profile | Default success rate | Default latency |
| :--- | :--- | :--- | :--- |
| `provider-a` | HDFC Direct Rail | 96% | 120 ms |
| `provider-b` | ICICI Payment Rail | 92% | 180 ms |
| `provider-c` | SBI Gateway Rail | 88% | 250 ms |

For each payment the gateway tries the rails one after another. It moves to the next rail **only when the current rail definitely did not process the charge** (for example, the rail is down). If the customer's bank declines the payment, the gateway stops: trying another rail would just charge the same customer again. If a rail times out and the outcome is unclear, the gateway also stops and checks with the bank later (see *Reconciliation* below).

### B. AI-assisted rail ordering

Rather than always trying the rails in a fixed order, the gateway asks an AI router which rail to try first. The router learns from every attempt which rail is currently doing best for each payment method, sends most traffic there, and keeps sampling the others so it notices when one recovers. In the bundled demo, traffic shifts away from a rail whose success rate drops and returns when it recovers. If the router is slow or unavailable, the gateway uses the fixed order, so routing advice can never stop a payment.

### C. Circuit breakers

If a rail keeps failing, its **circuit breaker** opens and the gateway skips that rail entirely for a short while, without sending it the charge. This saves the time a customer would otherwise spend waiting for a dead rail. After a few seconds the gateway lets a few trial payments through, and closes the breaker again once the rail answers. A rail whose customers' banks are declining payments is not "broken", so declines never trip a breaker. Operators can see each breaker's state and reset it from the operations dashboard.

### D. No double charges (idempotency)

A merchant or the checkout can send an `Idempotency-Key` with each payment or refund request. If the same request arrives twice, for example because a mobile connection dropped and the app retried, the gateway returns the result of the first request instead of creating a second payment or refund. The guarantee is enforced by the database itself, so it holds even when the two requests arrive at the same moment.

### E. Drop-in checkout

Merchants add one script (`checkout.js`) to their page and open a checkout modal with UPI (UPI ID), card or netbanking (HDFC, ICICI, SBI, Axis, Kotak). Card numbers and CVVs are never stored; only the last four digits and the card network are kept. When the payment succeeds the checkout returns a **signature** that the merchant's server checks before shipping the order, so a tampered browser cannot fake a successful payment.

### F. Authorize, capture and refund

Payments can be captured automatically (the default) or held as authorized and captured later, like a hotel deposit. Merchants can refund captured payments in full or in parts, or cancel an uncaptured authorization in full. Refunds stay `pending` while a rail is down and are retried automatically. Authorized payments that are never captured are refunded automatically after five days, so a customer's money is never held indefinitely.

### G. Reconciliation

When a bank does not give a clear answer (a timeout, a gateway error), the customer may or may not have been charged. The gateway reports the payment as failed but keeps asking the bank for up to 24 hours. If the bank later confirms the charge, the payment is turned into a "late authorization" and captured, or refunded if the order was meanwhile paid another way. The customer is never left charged for a payment the merchant thinks failed.

### H. Signed webhooks

The gateway notifies the merchant's server of events such as `payment.captured`, `order.paid` and `refund.processed`. Each notification is signed with a secret the merchant chose, is stored before it is sent so it cannot be lost, and is retried with increasing delays until the merchant's server accepts it.

### I. Merchant analytics

An analytics endpoint reports a merchant's payment counts, success rate, gross, captured and refunded volume, platform fees (including GST), net settlement and breakdowns by status, payment method and rail.

### J. Full audit trail

Every attempt on every rail is stored with its outcome, bank response code and latency, alongside the payment, order and refunds. Finance and support teams can see exactly which rails a payment tried and why.

### K. Operations dashboard and chaos testing

A web dashboard lets operators take test payments, watch analytics, see circuit breakers and webhook deliveries, refund payments, and **break things on purpose**: kill a rail, slow it down or lower its success rate, then watch failover and circuit breakers react. This is the payment equivalent of a fire drill: it proves the safety mechanisms work before a real outage.

---

## 4. What it does not do (yet)

| Not included | Status |
| :--- | :--- |
| Real banks and real money | Out of scope: the banks are simulated and only INR test payments exist. |
| Settlements and payouts to merchants | Roadmap. Net settlement is calculated by the analytics API but no money is paid out. |
| Fraud detection and velocity limits | Roadmap. The dashboard's fraud console (port 8002) is a labelled preview; no fraud service exists. |
| Event streaming (Kafka) and metrics dashboards (Prometheus/Grafana) | Roadmap. Their dashboard consoles are labelled previews. |
| Merchant self-service dashboard with login | Roadmap. The operations dashboard is a local test-mode console that acts as one sandbox merchant. |
| 3-D Secure, UPI collect requests, OTPs | Not implemented. A checkout payment is a single request; any OTP or QR step shown in a UI is a simulation. |

See the [phase breakdown](../technical/07-phase-breakdown-and-milestones.md) for the roadmap and the [glossary](03-glossary-and-concepts.md) for the terms used here.
