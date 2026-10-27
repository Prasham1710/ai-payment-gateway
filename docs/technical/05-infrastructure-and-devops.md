# Infrastructure and DevOps

## 1. What runs where

For local development, the two data stores run in Docker and the four application services run as ordinary processes on your machine.

| Component | How it runs | Address | State |
| :--- | :--- | :--- | :--- |
| PostgreSQL 16 | Docker container `payment_postgres` | `localhost:5432` | Docker volume `postgres_data` |
| Redis 7 (reserved) | Docker container `payment_redis` | `localhost:6380` (container port 6379) | Docker volume `redis_data`; unused |
| Bank simulator | `go run .` in `services/bank-simulator` | `localhost:8081` (fixed) | In memory |
| AI router | `uvicorn app.main:app --port 8000` in `services/ai-router` | `localhost:8000` | In memory, plus an optional model file |
| Payment orchestrator | `./mvnw spring-boot:run` in `services/payment-orchestrator` | `localhost:8080` | PostgreSQL |
| Operations dashboard | `npm run dev` in `services/frontend` | `localhost:3000` | Browser `localStorage` (sandbox keys) |

Start order: databases, bank simulator, AI router (optional), orchestrator, dashboard (optional). The orchestrator starts without the simulator or router, but payments fail with `all_providers_unavailable` until the simulator is up, and use the static rail order while the router is down.

---

## 2. Docker Compose

`docker/docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: payment_postgres
    restart: always
    environment:
      POSTGRES_DB: payment_db
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgrespassword
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    container_name: payment_redis
    restart: always
    ports:
      - "6380:6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
  redis_data:
```

| Command | Effect |
| :--- | :--- |
| `docker compose -f docker/docker-compose.yml up -d` | Start both containers in the background. |
| `docker compose -f docker/docker-compose.yml ps` | Both should show `Up (healthy)`. |
| `docker compose -f docker/docker-compose.yml down` | Stop and remove the containers; **data is kept** in the volumes. |
| `docker compose -f docker/docker-compose.yml down -v` | Stop and **delete the volumes**: every database (including any extra one you created) and Redis data is lost. |

Compose names the project after the directory holding the file (`docker`), so the network is `docker_default` and the volumes are `docker_postgres_data` and `docker_redis_data`, unless you override the project name.

The credentials (`postgres` / `postgrespassword`) and the open Redis are for local development only.

---

## 3. Networking

* All services listen on `localhost` ports and call each other through `localhost` URLs: the orchestrator uses `jdbc:postgresql://localhost:5432/payment_db`, `http://localhost:8081` (`simulator.base-url`) and `http://localhost:8000` (`GATEWAY_AI_ROUTER_URL`).
* The dashboard's code runs in the **browser**, so its URLs (`NEXT_PUBLIC_*`) must be reachable from the browser, and the orchestrator and AI router must allow its origin via CORS (`GATEWAY_CORS_ALLOWED_ORIGINS`, `AI_ROUTER_CORS_ORIGINS`). The bank simulator allows any origin.
* Redis is published on host port **6380** (container port 6379) so it does not clash with a Redis you may already run on 6379.
* **Tools running inside other containers** (for example a pgAdmin container) cannot use `localhost` to reach these services: inside a container, `localhost` is the container itself. Either run the tool on the host, or attach its container to the compose network (`docker_default`) and use the service names with the container ports: `postgres:5432` and `redis:6379`. See the [tools guide](../user-guide/04-tools-and-guis-guide.md).

---

## 4. Database options

The orchestrator manages its own schema (Hibernate `ddl-auto: update`). On a fresh volume nothing needs to be done: the compose file creates `payment_db` and the orchestrator creates its tables.

If the volume still holds the Phase 1 prototype's tables, which Hibernate will not convert, either:

```bash
# A. Use a separate database and keep the old one
docker exec payment_postgres psql -U postgres -c "CREATE DATABASE payment_gateway;"
export SPRING_DATASOURCE_URL=jdbc:postgresql://localhost:5432/payment_gateway
cd services/payment-orchestrator && ./mvnw spring-boot:run

# B. Reset the volume (deletes ALL data, including any other databases in it)
docker compose -f docker/docker-compose.yml down -v && docker compose -f docker/docker-compose.yml up -d
```

---

## 5. Configuration reference

### Payment orchestrator (`services/payment-orchestrator/src/main/resources/application.yml`)

Variables wired explicitly:

| Environment variable | Property | Default |
| :--- | :--- | :--- |
| `GATEWAY_MASTER_KEY` | `gateway.security.master-key` | Built-in development key (a warning is logged). Must decode to 32 bytes. |
| `GATEWAY_AI_ROUTING_ENABLED` | `gateway.routing.ai.enabled` | `true` |
| `GATEWAY_AI_ROUTER_URL` | `gateway.routing.ai.base-url` | `http://localhost:8000` |
| `GATEWAY_CIRCUIT_BREAKER_ENABLED` | `gateway.routing.circuit-breaker-enabled` | `true` |
| `GATEWAY_WEBHOOKS_ALLOW_PRIVATE_NETWORK` | `gateway.webhooks.allow-private-network` | `false` |
| `GATEWAY_CORS_ALLOWED_ORIGINS` | `gateway.cors.allowed-origins` | `http://localhost:3000,http://127.0.0.1:3000` |

Every other property can be overridden the usual Spring Boot way (an environment variable in relaxed form such as `SPRING_DATASOURCE_URL`, or `--property=value` on the command line). The main ones:

| Property | Default | Meaning |
| :--- | :--- | :--- |
| `spring.datasource.url` / `username` / `password` | `jdbc:postgresql://localhost:5432/payment_db`, `postgres`, `postgrespassword` | Database. |
| `simulator.base-url` | `http://localhost:8081` | Bank simulator. |
| `gateway.routing.providers` | `provider-a,provider-b,provider-c` | Rails and their static order. Each needs a matching `resilience4j.circuitbreaker.instances` entry to get the tuned breaker settings. |
| `gateway.routing.connect-timeout` / `read-timeout` | `2s` / `8s` | Bank call timeouts. |
| `gateway.routing.ai.timeout` | `150ms` | Deadline for routing advice. |
| `gateway.pricing.fee-percent` / `gst-percent` | `2.00` / `18.00` | Platform fee and GST on the fee. |
| `gateway.payments.capture-window` | `5d` | Uncaptured authorizations are refunded after this. |
| `gateway.reconciliation.window` | `24h` | How long unknown outcomes are followed up. |
| `gateway.webhooks.*` | 10 endpoints per merchant; 2 in flight per endpoint, 4 per merchant, 16 total; 8 attempts; backoff 5 s to 1 h; 5 s timeout | Webhook delivery. |
| `gateway.refunds.*` | 10 attempts, 30 s backoff, then hourly while unconfirmed | Refund retries. |
| `resilience4j.circuitbreaker.instances.<rail>.*` | window 10, minimum 5 calls, 50%, 5 s open | Circuit breakers. |

### AI router

`AI_ROUTER_MODEL_PATH` (`models/routing-model.joblib`), `AI_ROUTER_MODEL_WEIGHT` (`0.3`), `AI_ROUTER_DISCOUNT` (`0.98`), `AI_ROUTER_HALF_LIFE_SECONDS` (`120`), `AI_ROUTER_TIMEZONE` (`Asia/Kolkata`), `AI_ROUTER_CORS_ORIGINS` (`http://localhost:3000,http://127.0.0.1:3000`). The port is whatever you pass to `uvicorn`.

### Operations dashboard

Copy `services/frontend/.env.example` to `services/frontend/.env.local`:

| Variable | Default |
| :--- | :--- |
| `NEXT_PUBLIC_ORCHESTRATOR_URL` | `http://localhost:8080` |
| `NEXT_PUBLIC_BANK_SIMULATOR_URL` | `http://localhost:8081` |
| `NEXT_PUBLIC_AI_ROUTER_URL` | `http://localhost:8000` |

`NEXT_PUBLIC_*` values are compiled into the browser bundle; restart `npm run dev` (or rebuild) after changing them.

### Bank simulator

No configuration: it always listens on port 8081 and starts with the default rail profiles. Change rails at runtime through the chaos API.

---

## 6. Building and running

| Service | Development | Build / production-style run |
| :--- | :--- | :--- |
| Orchestrator | `./mvnw spring-boot:run` | `./mvnw package` then `java -jar target/payment-orchestrator-1.0.0-SNAPSHOT.jar` |
| Bank simulator | `go run .` | `go build` then `./bank-simulator` |
| AI router | `.venv/bin/uvicorn app.main:app --port 8000` | Same, without `--reload`, behind a process manager |
| Dashboard | `npm run dev` | `npm run build` then `npm start` (port 3000) |

The orchestrator uses the official Maven Wrapper (`mvnw`, `mvnw.cmd`, `.mvn/wrapper/maven-wrapper.properties`, wrapper 3.3.4) pinned to Maven 3.9.16 with a SHA-256 checksum, so only a JDK 17+ is needed. The first run downloads Maven into `~/.m2/wrapper`.

Toolchain versions: Java 17 (Spring Boot 3.5, Hibernate 6.6, Resilience4j 2.3), Go 1.22 (`go.mod`), Python 3.11+ (CI uses 3.12), Node.js 20.9+ (Next.js 16 requirement; CI uses 24).

---

## 7. Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and on every pull request, with one job per service:

| Job | Steps |
| :--- | :--- |
| Payment orchestrator (Java) | JDK 17 (Temurin), `./mvnw -B -ntp verify` (compiles and runs the 65 tests against H2 and an in-process fake bank). |
| Bank simulator (Go) | Go version from `go.mod`; `gofmt -l` must report nothing; `go vet ./...`; `go test -race -count=1 ./...` (9 tests). |
| AI router (Python) | Python 3.12; `pip install -r requirements.txt`; `python -m pytest -q` (11 tests). |
| Operations dashboard (Next.js) | Node 24; `npm ci`; `npm run typecheck`; `npm run build`. |

No job needs Docker, PostgreSQL or a running service.

---

## 8. Observability today

There is no metrics endpoint yet (no Spring Boot Actuator, no `/metrics` on the simulator or router), so Prometheus has nothing to scrape. What exists:

| Need | Where |
| :--- | :--- |
| What happened to a payment | `GET /v1/payments/{id}` and `/attempts`; orchestrator logs (routing order and strategy, each attempt, failovers, breaker skips). |
| Rail health | `GET /ops/circuit-breakers`; `GET :8081/api/v1/chaos/status`. |
| What the AI router believes | `GET :8000/v1/stats`. |
| Webhook health | `GET /v1/webhooks/{id}/deliveries`; SQL on `webhook_deliveries`. |
| Business totals | `GET /v1/analytics`. |
| Items needing attention | Log lines at `ERROR`: "manual reconciliation required", "still unconfirmed after N attempts; needs attention". |

Prometheus metrics and Grafana dashboards are on the [roadmap](07-phase-breakdown-and-milestones.md).

---

## 9. Before running anywhere shared

This is a test-mode system. Before exposing it beyond your machine:

* Set `GATEWAY_MASTER_KEY` (`openssl rand -base64 32`) and keep it stable: secrets encrypted with one key cannot be read with another.
* Change the database password; do not publish PostgreSQL or Redis ports.
* Keep `/ops`, the bank simulator and the AI router on a private network; none of them has authentication.
* Restrict `GATEWAY_CORS_ALLOWED_ORIGINS` and `AI_ROUTER_CORS_ORIGINS` to the dashboard's real origin.
* Leave `GATEWAY_WEBHOOKS_ALLOW_PRIVATE_NETWORK` off and send webhooks through an egress proxy (the SSRF check cannot fully prevent DNS rebinding).
* Run a single orchestrator instance (the background jobs and circuit breakers are per instance).
* Add signup verification and rate limiting in front of the API.
* Replace `ddl-auto: update` with versioned migrations.
