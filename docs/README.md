# Documentation

Documentation for the **AI Payment Gateway**: a Razorpay-style, test-mode payment gateway that routes every payment across several simulated bank rails, with AI-assisted rail ordering, per-rail circuit breakers, reconciliation and signed webhooks.

The [root README](../README.md) is the quick reference (setup, integration guide, API summary). The pages below go deeper and are split into three tracks so each reader can skip what they do not need.

## What is real, what is simulated, what is planned

| Status | Components |
| :--- | :--- |
| **Implemented** | Payment orchestrator (Java, :8080) with orders, payments, refunds, webhooks, analytics, reconciliation and circuit breakers; hosted checkout and demo store; Go bank simulator (:8081); AI router (Python, :8000); operations dashboard (Next.js, :3000); PostgreSQL (:5432). |
| **Simulated** | The banks themselves: three rails in the Go simulator with configurable success rate, latency and kill switch. No real money moves. Some dashboard consoles (ports 8002, 6380, 9092, 9090) are labelled previews of planned components. |
| **Provisioned, unused** | Redis (:6380) is started by the compose file for a later phase; no service reads or writes it. |
| **Roadmap** | Fraud detection, Redis velocity limits, Kafka event streaming, Prometheus/Grafana observability, settlements and payouts. See [phase breakdown](technical/07-phase-breakdown-and-milestones.md). |

## 1. Product and business track

For product managers, founders, analysts and other non-engineering stakeholders.

1. [Product overview](non-technical/01-product-overview.md): the problem with single-bank payments, what the gateway does about it, and what it deliberately does not do yet.
2. [Business architecture and payment economics](non-technical/02-business-architecture.md): the simulated rails, fees and GST, a worked outage example, and the metrics the analytics API reports.
3. [Glossary and core concepts](non-technical/03-glossary-and-concepts.md): plain-English analogies for idempotency, bank rails, state machines, circuit breakers, reconciliation, webhooks and more.

## 2. Engineering track

For engineers, architects and technical leads.

1. [System architecture](technical/01-system-architecture.md): components, ports, inter-service contracts, sequence diagrams, background jobs and the security model.
2. [State machines and flows](technical/02-state-machine-and-flows.md): order, payment, refund and webhook lifecycles; idempotency and concurrency; failover, circuit breakers, reconciliation and AI routing rules.
3. [API reference](technical/03-api-reference.md): every endpoint of the orchestrator, bank simulator and AI router, with fields, auth and errors.
4. [Database schema](technical/04-database-schema.md): the seven tables, their columns and indexes, and useful queries.
5. [Infrastructure and DevOps](technical/05-infrastructure-and-devops.md): Docker Compose, processes and ports, database options, configuration, CI, and production hardening.
6. [Technology rationale](technical/06-technology-rationale.md): why each technology and design choice was made, and what was tried and dropped.
7. [Phase breakdown and milestones](technical/07-phase-breakdown-and-milestones.md): what each phase delivered, how it is verified, and the roadmap.

## 3. User guide track

For QA engineers, operators and developers getting started.

1. [Quickstart and setup](user-guide/01-quickstart-and-setup.md): prerequisites, the start-up sequence, database options, local credentials, troubleshooting.
2. [Merchant checkout guide](user-guide/02-merchant-checkout-guide.md): taking test payments through the API, the demo store and the dashboard; idempotency, refunds, analytics, webhooks and API keys.
3. [Chaos testing guide](user-guide/03-chaos-testing-guide.md): rail outages, failover, circuit breakers, bank timeouts and reconciliation, and the idempotency stress test.
4. [Tools and GUIs guide](user-guide/04-tools-and-guis-guide.md): the dashboard's service consoles, inspecting the database, and pointing optional external tools at the services.

See also [`flow.md`](../flow.md) for a one-page view of the payment flow and the roadmap.
