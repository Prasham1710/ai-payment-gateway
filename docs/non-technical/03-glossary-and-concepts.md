# Glossary and Core Concepts

Plain-English explanations, with everyday analogies, of the terms used across the gateway's documentation.

---

### 1. Idempotency (preventing double charges)

* **What it means:** doing the same thing twice has the same effect as doing it once.
* **Analogy:** an **elevator call button**. Press it once and the elevator is called. Press it five more times and you still get one elevator, not six.
* **How the gateway uses it:** a payment or refund request can carry an `Idempotency-Key` header, a label the caller chooses (for example `checkout-order-1234`). The database refuses to store two payments (or two refunds) with the same key for the same merchant. If a phone on a bad connection sends the payment three times, the first request creates the payment and the other two get the first one's result back. If the first payment is still being processed, the repeat gets a "still being processed" answer (HTTP 409) instead of a second payment.

---

### 2. Bank rails (provider-a, provider-b, provider-c)

* **What it means:** the connections through which the gateway asks banks to move money.
* **Analogy:** **railway tracks between two cities**. If one track is blocked, trains are sent down another so passengers still arrive.
* **How the gateway uses it:** there are three simulated rails with HDFC, ICICI and SBI profiles. A payment is tried on one rail; if that rail is down, it moves to the next. The difference from trains: if the customer's bank says "no" (a decline), the payment is not sent down another track, because that would charge the same customer again.

---

### 3. Order

* **What it means:** the merchant's record of what the customer has to pay, created on the merchant's server before checkout.
* **Analogy:** a **restaurant bill** printed before you pay. You can try paying several times (card declined, then UPI), but there is only one bill, and once it is paid it cannot be paid again.
* **How the gateway uses it:** an order fixes the amount. It moves from `created` to `attempted` at the first payment attempt and to `paid` when a payment is captured. Only one payment for an order can be in progress at a time.

---

### 4. Authorize and capture

* **What it means:** *authorize* reserves the money on the customer's account; *capture* actually takes it.
* **Analogy:** a **hotel deposit**. At check-in the hotel blocks an amount on your card; at check-out it charges what you owe. Until then the money is held, not taken.
* **How the gateway uses it:** by default payments are captured as soon as they are authorized. A merchant can turn that off per order and capture later. If an authorized payment is not captured within five days, or the order was paid by another payment, the gateway refunds it automatically.

---

### 5. State machine (a payment's lifecycle)

* **What it means:** a fixed set of stages a payment can be in, and fixed rules for moving between them.
* **Analogy:** a **flight**: booked, boarded, in the air, landed. A plane cannot land without taking off.
* **How the gateway uses it:** a payment is `created`, then `authorized` or `failed`, then (if authorized) `captured`, and possibly `refunded`. A partly refunded payment stays `captured` and is marked `refund_status: partial`. Orders (`created → attempted → paid`) and refunds (`pending → processed` or `failed`) have their own lifecycles. Every change is saved in the database before anything else is told about it.

---

### 6. ACID database (the ledger)

* **What it means:** a database that guarantees changes are all-or-nothing (Atomic), always follow the rules (Consistent), do not trip over each other (Isolated), and survive crashes (Durable).
* **Analogy:** a **bank teller's ledger book written in ink**. Every entry has a date and a reference and cannot be half-written.
* **How the gateway uses it:** PostgreSQL holds merchants, orders, payments, every rail attempt, refunds, webhook endpoints and queued webhook deliveries. All amounts are whole paise, so there are no rounding errors.

---

### 7. Paise

* **What it means:** the smallest unit of the Indian rupee; ₹1 = 100 paise.
* **How the gateway uses it:** every amount in the API is a whole number of paise. `50000` means ₹500.00. The minimum payment is 100 paise (₹1.00).

---

### 8. Row lock (one payment at a time per order)

* **What it means:** while one request is changing a database row, other requests that want to change the same row wait their turn.
* **Analogy:** a **single key to a shared room**. However many people arrive at once, only the one holding the key goes in; the others wait outside until it is handed back.
* **How the gateway uses it:** when a payment starts, the order's row is locked. A second request for the same order waits its turn, then sees the first payment: with the same `Idempotency-Key` it gets the first payment's result; with a different key it is told another payment for the order is still in progress (or, once the order is paid, that it is already paid). This, together with the database's unique constraint on idempotency keys, is what prevents double payments. No separate locking service is needed.

---

### 9. Circuit breaker

* **What it means:** an automatic switch that stops sending work to a service that keeps failing, and tries it again after a pause.
* **Analogy:** the **circuit breaker in your home's fuse box**. When one appliance short-circuits, its breaker trips so the rest of the house keeps working. Later you flip it back on to see if the fault is gone.
* **How the gateway uses it:** each rail has its own breaker. If at least half of a rail's last 10 calls failed (once it has had at least 5), the breaker opens and the rail is skipped without being sent the charge. After 5 seconds a few trial payments are allowed through; if they work the breaker closes. A decline from the customer's bank counts as the rail working, so declines never trip it. A skipped rail shows up in the payment's attempt list with the code `CB_OPEN`.

---

### 10. Chaos engineering

* **What it means:** deliberately causing failures to prove a system survives them.
* **Analogy:** a **fire drill**. You do not wait for a real fire to find out whether everyone knows the way out.
* **How the gateway uses it:** the bank simulator has switches to kill a rail, slow it down or lower its success rate. The dashboard's **Chaos Matrix** puts those switches on screen, so you can kill the HDFC-profile rail and watch payments move to the next rail and its circuit breaker open.

---

### 11. Reconciliation and late authorization

* **What it means:** checking your records against the bank's after the fact, and fixing any difference.
* **Analogy:** **comparing your expense notes with the bank statement** at the end of the month. If the statement shows a payment you had marked "didn't go through", you update your notes.
* **How the gateway uses it:** if a bank times out, the gateway cannot know whether the customer was charged, so it reports the payment as failed but keeps asking the bank for up to 24 hours. If the bank confirms the charge, the payment becomes a *late authorization* and is captured, or refunded if the order was meanwhile paid another way.

---

### 12. Refunds (full and partial)

* **What it means:** returning all or part of a captured payment to the customer.
* **Analogy:** a **shop's returns counter**. You return one shirt from a ₹1,500 purchase; the cashier refunds ₹500 and your receipt now shows ₹1,000 kept.
* **How the gateway uses it:** a refund starts `pending`, and its amount is reserved on the payment straight away so two refunds can never exceed the payment. It becomes `processed` when the bank confirms it, or `failed` if the bank rejects it (the reservation is then released). If the rail is down the refund stays `pending` and is retried. The payment shows `refund_status: partial` or `full`, and becomes `refunded` once fully refunded.

---

### 13. Payment signature

* **What it means:** a code computed from the order id, the payment id and the merchant's secret key, which only the gateway and the merchant can produce.
* **Analogy:** a **tamper-evident seal on a parcel**. If the seal is intact, nobody changed the contents on the way.
* **How the gateway uses it:** after a successful checkout the browser receives the payment id and this signature. The merchant's server recomputes it with its key secret; only if it matches does it ship the order. A customer who edits the browser's response cannot fake a valid signature.

---

### 14. Webhooks (signed notifications)

* **What it means:** messages the gateway sends to the merchant's server when something happens, such as a payment being captured.
* **Analogy:** a **royal letter sealed with the king's wax seal**. The recipient checks the seal to know who sent it and that it was not altered.
* **How the gateway uses it:** each webhook is signed with a webhook secret the merchant chose when registering the endpoint (`X-Gateway-Signature`). Each event has an id (`X-Gateway-Event-Id`) that stays the same across retries, so the merchant can ignore duplicates.

---

### 15. Outbox

* **What it means:** writing an outgoing message into the database in the same step as the change it describes, and sending it afterwards.
* **Analogy:** an **office out-tray**. You put the letter in the tray at the same moment you file the record; the post room collects the tray later. If the post room is closed, the letter waits in the tray instead of being lost.
* **How the gateway uses it:** every webhook event is stored in the `webhook_deliveries` table in the same database transaction as the payment or refund change. A background dispatcher sends it and retries with increasing delays until the merchant's server accepts it.

---

### 16. Multi-armed bandit (AI routing)

* **What it means:** a method for repeatedly choosing between options with uncertain payoffs, balancing using the best-known option with trying the others.
* **Analogy:** choosing between **three restaurants** on your street. You mostly go to your favourite, but now and then you try another in case it has improved, and you trust recent meals more than ones from last year.
* **How the gateway uses it:** the AI router keeps a running estimate of each rail's success rate per payment method, gives most first attempts to the rail that is currently best, and keeps exploring the others. Old results fade, so a rail that recovers wins its traffic back. An optional trained model adds what is usually true (for example by time of day).

---

### 17. Test mode and sandbox

* **What it means:** an environment where everything works like the real thing except that no real money moves.
* **How the gateway uses it:** all keys are test keys (`key_test_…`), the banks are simulated, and special test instruments always succeed (`success@gateway`, card `4111 1111 1111 1111`) or always fail (`failure@gateway`, card `4000 0000 0000 0002`). The operations dashboard acts as one **sandbox merchant** that it creates on first use.
