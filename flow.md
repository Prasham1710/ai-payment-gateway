# System Architecture & Execution Flow (`flow.md`)

## 1. Project Overview & Technology Stack

The **AI-Powered Payment Orchestration & Smart Routing Platform** is a distributed, multi-language payment infrastructure designed to dynamically route merchant payments across multiple bank rails and providers based on real-time success probability, latency, transaction cost, and provider health.

### Technology Stack & Component Roles

| Component / Layer | Technology | Port | Purpose & Role |
| :--- | :--- | :--- | :--- |
| **Payment Orchestrator** | **Java 17 + Spring Boot 3.2** | `8080` | Core transaction orchestrator, state machine transitions, JPA persistence, idempotency, fallback routing. |
| **Bank & Provider Simulator** | **Go 1.22** | `8081` | Ultra-fast high-concurrency bank rail simulator (HDFC, ICICI, SBI) with goroutine chaos injection & ledger. |
| **Relational Database** | **PostgreSQL 16** | `5432` | ACID-compliant persistent ledger storing `payments` and `transactions`. |
| **In-Memory Cache & Locks** | **Redis 7** | `6380` | Distributed lock engine (`SETNX`), idempotency TTL cache, provider health state, velocity counters. |
| **Messaging & Events** | **Apache Kafka** | `9092` | Event-driven streaming backbone (`payment-events`, `routing-metrics`, `reconciliation-dlq`). |
| **AI Routing & Fraud Engine** | **Python 3.12 + FastAPI** | `8000` | ML routing classifier (XGBoost/Scikit-Learn), real-time feature extraction, and fraud risk scorer. |
| **Containerization** | **Docker & Docker Compose** | — | Single-command local infrastructure provisioning (`docker-compose.yml`). |

---

## 2. End-to-End Payment Execution Flow

```
                           MERCHANT / CLIENT
                                   │
                                   │  POST /api/v1/payments
                                   ▼
                   ┌───────────────────────────────┐
                   │  Java Spring Boot Orchestrator│
                   │         (Port 8080)           │
                   └───────────────┬───────────────┘
                                   │
                      1. Check Idempotency Key
                      ┌────────────┴────────────┐
                      ▼                         ▼
             [Key Exists in DB/Redis]    [New Unique Key]
                      │                         │
             Return Saved Payment        Create Payment Entity
              (Zero Duplicate Tx)        (Status: INITIATED)
                                                │
                                                ▼
                                         Transition Status:
                                            (ROUTING)
                                                │
                                                ▼
                                   Route Selection & Fallback:
                              Provider A ──> Provider B ──> Provider C
                                                │
                                                │ POST /api/v1/bank/charge
                                                ▼
                                   ┌─────────────────────────┐
                                   │   Go Bank Simulator     │
                                   │       (Port 8081)       │
                                   └────────────┬────────────┘
                                                │
                                    Chaos Check & Latency
                                ┌───────────────┴───────────────┐
                                ▼                               ▼
                         [Provider Alive]               [Provider Killed]
                                │                               │
                     Simulate Latency (120ms)           Return HTTP 503
                     Evaluate Success Rate              (Failover Triggered)
                                │                               │
                                ▼                               ▼
                         Return Status                    Try Next Route
                      (SUCCESS / FAILED)                 in Fallback Chain
                                │
                                ▼
                   ┌─────────────────────────┐
                   │ Update Payment Status   │
                   │ (SUCCESS or FAILED)     │
                   │ Save Transaction Record │
                   └─────────────────────────┘
```

---

## 3. What Has Been Completed (Phase 1 Milestone)

- [x] **Docker Infrastructure:** PostgreSQL 16 (`payment_postgres:5432`) and Redis 7 (`payment_redis:6380`) running via `docker-compose.yml`.
- [x] **Go Bank Simulator (`services/bank-simulator`):**
  - High-concurrency HTTP mock engine on port `8081`.
  - Rails: `provider-a` (HDFC Direct), `provider-b` (ICICI Payment), `provider-c` (SBI Gateway).
  - Chaos API: Live toggles for `/api/v1/chaos/kill`, `/api/v1/chaos/restore`, `/api/v1/chaos/latency`, and `/api/v1/chaos/status`.
- [x] **Java Spring Boot Payment Orchestrator (`services/payment-orchestrator`):**
  - Application running on port `8080`.
  - Database Entities: `Payment` and `Transaction` with PostgreSQL indexes.
  - Payment State Machine: `INITIATED` $\rightarrow$ `ROUTING` $\rightarrow$ `PENDING` $\rightarrow$ `SUCCESS` / `FAILED`.
  - Service Layer: `PaymentOrchestratorService.java` handling idempotency check, fallback routing, transaction logging.
  - REST Endpoints: `POST /api/v1/payments`, `GET /api/v1/payments/{id}`, `GET /api/v1/payments/merchant/{merchantId}`.
- [x] **Verified Scenarios & Automated Tests:**
  1. Successful payment initiation & bank reference generation.
  2. Idempotency protection preventing duplicate charges on duplicate keys.
  3. Chaos kill injection on `provider-a` $\rightarrow$ Automatic failover to `provider-b` succeeded seamlessly.

---

## 4. Upcoming Project Phases & Roadmap

```text
  Phase 1 (DONE)            Phase 2                  Phase 3                  Phase 4                  Phase 5                  Phase 6
┌────────────────┐     ┌────────────────┐     ┌────────────────┐     ┌────────────────┐     ┌────────────────┐     ┌────────────────┐
│ Core Engine &  │ ──> │ Idempotency &  │ ──> │ Kafka Scaling  │ ──> │ AI/ML Smart    │ ──> │ Real-Time      │ ──> │ Reconciliation │
│ Go Simulator   │     │ CircuitBreaker │     │ & Outbox       │     │ Routing Engine │     │ Fraud Detector │     │ & Observability│
└────────────────┘     └────────────────┘     └────────────────┘     └────────────────┘     └────────────────┘     └────────────────┘
```

1. **Phase 2 — Distributed Reliability:** Redis distributed locking (`SETNX`), Resilience4j provider circuit breakers, and timeout management.
2. **Phase 3 — Scale & Kafka Outbox:** Asynchronous Kafka event processing, Transactional Outbox pattern, and high-TPS load testing (10,000+ payments/min).
3. **Phase 4 — AI Smart Routing:** Python FastAPI ML model predicting $P(\text{success} \mid \text{provider, bank, amount, hour})$ + Multi-Armed Bandit ($\epsilon$-greedy).
4. **Phase 5 — Fraud Detection:** Velocity tracking in Redis + XGBoost anomaly risk scoring model.
5. **Phase 6 — Reconciliation & Observability:** Automated status mismatch reconciliation worker + Prometheus metrics & Grafana dashboards.
