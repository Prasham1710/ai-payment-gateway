# Business Architecture and Payment Economics

## 1. Who is involved

| Party | Role in this system |
| :--- | :--- |
| **Merchant** | Sells something online. Creates orders, opens the checkout, verifies the result, captures and refunds payments, and receives webhooks. Has an account with a `key_id` / `key_secret` pair. |
| **Customer** | Pays through the checkout with UPI, a card or netbanking. Only ever sees the merchant's public `key_id`, never a secret. |
| **Gateway (this system)** | Takes the payment, picks the bank rail, fails over when safe, records everything, charges the platform fee, notifies the merchant, and follows up on unclear bank answers. |
| **Bank rails** | The connections to banks that actually authorize and refund money. Simulated here by three rails with HDFC, ICICI and SBI profiles. |
| **Operator** | Runs the gateway. Watches circuit breakers and webhook deliveries, and in test mode can inject failures with the chaos controls. |

---

## 2. Routing economics

Routing decides both how many payments succeed (revenue) and what each payment costs (margin).

### The simulated rails

The bank simulator starts each rail with these values; all of them can be changed at runtime through its chaos API.

| Rail | Bank profile | Success rate | Latency | Cost attribute |
| :--- | :--- | :--- | :--- | :--- |
| `provider-a` | HDFC Direct Rail | 96% | 120 ms | ₹2.00 per transaction |
| `provider-b` | ICICI Payment Rail | 92% | 180 ms | ₹1.50 per transaction |
| `provider-c` | SBI Gateway Rail | 88% | 250 ms | ₹1.00 per transaction |

These are simulator defaults chosen to make the trade-off visible: the fastest, most reliable rail is also the most expensive. The cost attribute is reported by the simulator's status endpoint but is **not used** by today's routing or fee calculation. The AI router currently optimizes for the chance of success only; weighing rail cost against success is a possible future extension.

Without the AI router, the gateway tries the rails in the order a → b → c. With it, the order is chosen per payment from live results (see [AI routing](../technical/02-state-machine-and-flows.md#8-ai-routing)).

---

## 3. Worked example: a one-hour bank outage

This is an illustrative calculation, not a measurement. It uses round numbers and the simulator's default success rates.

**Assumptions:** a merchant processes 100,000 payments a day, spread evenly (about **4,167 per hour**), with an average value of **₹1,500**. The primary bank is completely down for one hour (every request is refused).

| | Single bank connection | This gateway |
| :--- | :--- | :--- |
| What happens to each payment | Fails: the only bank is down. | `provider-a` refuses the charge (HTTP 503), so the gateway fails over to `provider-b`. Once `provider-a`'s circuit breaker opens, payments skip it without waiting for it. |
| Payments that succeed in that hour | 0 | About 92% (the default success rate of `provider-b`): roughly 3,834 |
| Checkout value affected | 4,167 × ₹1,500 ≈ **₹62.5 lakh** fails | Roughly ₹57.5 lakh still goes through; the shortfall against a normal hour (96% on `provider-a`) is about 4 percentage points |

Some customers would retry later anyway, so the failed value is revenue *at risk*, not necessarily revenue lost. The point of the example is the shape of the difference: an outage of one bank becomes a small dip instead of a full stop.

Two limits to keep in mind:

* Declined payments are **not** retried on another rail, because the customer's bank has already said no. Failover protects against rail outages, not against declines.
* If every rail is down, payments fail with `all_providers_unavailable`.

---

## 4. Fees and settlement

The gateway charges a platform fee on every **captured** payment, the way Razorpay reports it:

* **Fee:** 2% of the payment amount.
* **GST:** 18% of the fee.
* The payment's `fee` field includes the GST; its `tax` field is the GST part.

Example, a ₹500.00 payment (50,000 paise):

| Item | Calculation | Amount |
| :--- | :--- | :--- |
| Platform fee before GST | 2% of ₹500.00 | ₹10.00 |
| GST | 18% of ₹10.00 | ₹1.80 |
| `fee` (incl. GST) | | ₹11.80 |
| Net to the merchant | ₹500.00 − ₹11.80 | ₹488.20 |

If the merchant later refunds ₹200 of it, the fee is not returned: net settlement becomes ₹500.00 − ₹200.00 − ₹11.80 = ₹288.20. An authorized payment that is never captured carries no fee; cancelling it (a full reversal) costs the merchant nothing.

Both percentages are configuration (`gateway.pricing.fee-percent` and `gateway.pricing.gst-percent`). Settlement is only calculated: no payouts are made in this test-mode system.

---

## 5. Metrics the gateway reports

`GET /v1/analytics` (shown on the dashboard's Analytics tab) reports, per merchant:

| Metric | Meaning |
| :--- | :--- |
| `payments` | Every payment, including failed and in-progress ones. |
| `successful_payments` / `failed_payments` | Payments the bank approved (authorized, captured, or refunded since) / payments that failed. |
| `success_rate` | Successful payments as a percentage of finished ones (in-progress payments are left out). |
| `gross_volume` | Total amount of successful payments. |
| `captured_volume` / `refunded_volume` | Amount captured / amount refunded or being refunded. |
| `fees` / `taxes` | Platform fees including GST / the GST part. |
| `net_settlement` | `captured_volume − refunded_volume − fees`: what the merchant would be settled. |
| `average_payment_value` | `gross_volume / successful_payments`. |
| `count_by_status`, `count_by_method`, `successful_by_provider` | Breakdowns by payment status, payment method and rail. |

All amounts are in paise.

### Metrics worth adding later

These are useful for a business case but are **not** measured today: mean time to fail over, the number of duplicate requests absorbed by idempotency, the blended rail cost per payment, and conversion from order created to order paid. The data for most of them exists in the `transactions`, `payments` and `orders` tables (see [database schema](../technical/04-database-schema.md)).
