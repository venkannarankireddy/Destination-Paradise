# Destination Paradise — Production Deployment Guide

This guide details the operational architecture, deployment requirements, and production hardening procedures for **Destination Paradise** (Phases 10 & 11).

For disaster recovery runbooks, secret rotation protocols, and detailed operational troubleshooting, consult [`docs/OPERATIONS.md`](OPERATIONS.md).

---

## 1. Runtime & System Requirements

- **Runtime:** Node.js 24 Alpine LTS (`node:24-alpine` for container deployments).
- **Process Manager:** Container orchestrators (Docker, Kubernetes, Google Cloud Run) or `pm2` / `systemd`.
- **Database:** Google Cloud Firestore (in Datastore Native or Firestore Native mode).
- **Reverse Proxy / Load Balancer:** Nginx, AWS ALB, or Google Cloud HTTPS Load Balancer with SSL/TLS termination.

---

## 2. Environment Configuration

Copy `.env.example` to your production environment configuration and supply required production values:

```bash
cp .env.example .env
```

### Production Environment Variables Reference

| Variable | Required in Prod? | Default / Format | Description |
|---|---|---|---|
| `NODE_ENV` | **YES** | `production` | Enables secure cookies, strict configuration validation, and single-line JSON logging. |
| `PORT` | No | `3000` | HTTP port the Express server binds to (1–65535). |
| `TRUST_PROXY` | Recommended | `1` | Number of upstream proxy hops (e.g. `1` for single ALB/Nginx proxy), boolean, or CIDR list. |
| `SESSION_SECRET` | **YES** | None | **Must be at least 32 characters long.** Used to sign session cookies and derive CSRF secrets. Generate via `openssl rand -hex 32`. |
| `FIREBASE_API_KEY` | **YES** | None | Web API Key from Firebase Console used for Google Identity Toolkit sign-up and sign-in operations. |
| `FIREBASE_SERVICE_ACCOUNT_KEY` | Conditional | JSON string | JSON contents of your Firebase Service Account Private Key. (Alternative: `GOOGLE_APPLICATION_CREDENTIALS` path). |
| `GOOGLE_APPLICATION_CREDENTIALS` | Conditional | `./key.json` | Absolute or relative path to your service account key file. |
| `APP_TIMEZONE` | No | `Asia/Colombo` | Standard IANA timezone used for trip scheduling, start-trip date validation, and driver availability matching. |
| `SHUTDOWN_TIMEOUT_MS` | No | `10000` | Graceful shutdown timeout in milliseconds before forcing process exit. |
| `READINESS_CACHE_TTL_MS` | No | `5000` | Cache duration in milliseconds for the `/ready` dependency check to prevent excessive Firestore reads from load balancers. |
| `AUTH_RATE_LIMIT` | No | `50` | Maximum login/register requests per 15-minute window per IP. |
| `ACTION_RATE_LIMIT` | No | `120` | Maximum state-changing POST requests per 15-minute window per IP. |
| `LOG_LEVEL` | No | `info` | Minimum log level (`info`, `warn`, `error`, `debug`). |

> [!IMPORTANT]
> In production mode (`NODE_ENV=production`), the application **fails fast at startup** if `SESSION_SECRET` is missing, shorter than 32 characters, or contains default placeholder values.

---

## 3. Persistent Session Storage (Firestore)

Destination Paradise utilizes a custom, production-grade `FirestoreSessionStore` conforming to the `express-session.Store` specification:

- **Collection:** `sessions/{sid}` in Firestore.
- **Persistence:** Sessions survive server restarts, crashes, and rolling redeployments.
- **Multi-Instance Ready:** Because session state is stored in Firestore, multiple application instances can run behind a load balancer without requiring sticky sessions.
- **Expiration:** Stored with `expires` (Date) and `expiresMs` (Unix timestamp). Expired sessions are purged on access and rejected by the authentication middleware.
- **Cookie Security:**
  - `httpOnly: true` (prevents XSS access to cookies)
  - `sameSite: "lax"` (mitigates cross-site request forgery)
  - `secure: true` (enforced automatically in production; requires HTTPS)
  - `maxAge: 86400000` (24 hours)

---

## 4. Firestore Composite Indexes

To ensure high performance and prevent query throttling, composite indexes must be deployed to your Firebase project.

### Index Definitions (`firestore.indexes.json`)
The application defines indexes for:
1. `bookings`: Filter by `email` and order by `bookedAt desc`.
2. `bookings`: Filter by `driverId` and `status`, order by `bookedAt desc`.
3. `bookings`: Filter by `status`, order by `bookedAt desc`.
4. `bookings`: Duplicate detection filter by `touristId`, `destination`, `fromDate`, `toDate`.
5. `availability`: Date-window matching by `fromDate asc`.
6. `notifications`: Filter by `userId` and order by `createdAt desc`.
7. `notifications`: Filter by `userId` and `isRead`, order by `createdAt desc`.

### Deploy Indexes CLI Command
```bash
firebase deploy --only firestore:indexes
```

---

## 5. Operational Probes & Health Checks

The application exposes two operational endpoints that do **not** require authentication or CSRF tokens:

### 1. Process Liveness: `GET /health`
- **Purpose:** Verifies that the Node.js event loop and Express process are alive and responding.
- **Behavior:** Returns HTTP `200 OK` immediately without any database or network dependencies.
- **Recommended probe frequency:** Every 5–10 seconds.
```json
{
  "status": "ok",
  "service": "destination-paradise",
  "uptime": 1420.52,
  "timestamp": "2026-09-13T10:45:00.000Z"
}
```

### 2. Service Readiness: `GET /ready`
- **Purpose:** Verifies that the application is ready to accept user traffic and its critical dependencies (Firestore) are reachable.
- **Behavior:**
  - If server is currently executing graceful shutdown, **immediately returns HTTP 503**.
  - Performs a lightweight, bounded read (`limit(1)`) against Firestore with a 3-second timeout.
  - Caches readiness results for 5 seconds (`READINESS_CACHE_TTL_MS`) to prevent hammering Firestore from high-frequency health probes.
- **Response when Ready (HTTP 200):**
```json
{
  "status": "ready",
  "service": "destination-paradise",
  "checks": {
    "firestore": "connected"
  },
  "timestamp": "2026-09-13T10:45:00.000Z"
}
```
- **Response when Not Ready / Shutting Down (HTTP 503):**
```json
{
  "status": "not_ready",
  "service": "destination-paradise",
  "checks": {
    "firestore": "disconnected"
  },
  "timestamp": "2026-09-13T10:45:00.000Z"
}
```

---

## 6. Request Correlation & Structured Logging

### Request Correlation (`X-Request-ID`)
- Every incoming HTTP request receives an `X-Request-ID` header.
- If upstream reverse proxies (e.g. Cloudflare, AWS ALB) pass a valid `X-Request-ID` header (`/^[a-zA-Z0-9_-]{1,128}$/`), the application adopts it.
- If missing or malformed, the application generates a cryptographically random UUID v4.
- The ID is returned on all response headers and embedded in all error payloads and structured logs.

### Structured Logging
- In production (`NODE_ENV=production`), all logs are emitted as single-line JSON to `stdout` (`info`, `warn`, `debug`) or `stderr` (`error`).
- **Sanitization Guarantee:** Passwords, API keys, session secrets, CSRF tokens, and private keys are automatically redacted (`[REDACTED]`).
- Request duration (`durationMs`), HTTP method, URL path, status code, and `requestId` are logged for every transaction.

---

## 7. Graceful Shutdown

Destination Paradise implements graceful shutdown handling for `SIGTERM` and `SIGINT`:

1. **Traffic Cut-Off:** `shutdownCoordinator` marks the process as shutting down. The `/ready` endpoint immediately starts returning HTTP `503 Service Unavailable`, prompting load balancers to redirect traffic.
2. **In-Flight Completion:** `server.close()` stops accepting new HTTP connections while allowing existing requests to finish processing.
3. **Timeout Safeguard:** A 10-second timer (`SHUTDOWN_TIMEOUT_MS`) ensures the process terminates cleanly even if a connection is stalled.
4. **Idempotency:** Repeated signals are safely ignored.

---

## 8. Reverse Proxy Configuration (Nginx Example)

When deploying behind an Nginx reverse proxy, configure SSL termination and header forwarding:

```nginx
server {
    listen 443 ssl http2;
    server_name paradise.example.com;

    ssl_certificate /etc/letsencrypt/live/paradise.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/paradise.example.com/privkey.pem;

    # Enable trust proxy headers
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Pass or generate request ID
    proxy_set_header X-Request-ID $request_id;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
    }

    # Health check routes
    location /health {
        proxy_pass http://127.0.0.1:3000/health;
        access_log off;
    }

    location /ready {
        proxy_pass http://127.0.0.1:3000/ready;
        access_log off;
    }
}
```

---

## 9. Production Pre-Flight Checklist

Before launching into production, verify:

- [ ] Node.js v18+ is installed.
- [ ] `npm install --omit=dev` executed.
- [ ] `NODE_ENV=production` is set in the environment.
- [ ] `SESSION_SECRET` is generated with 32+ cryptographically random characters.
- [ ] `FIREBASE_API_KEY` is configured and valid.
- [ ] Firebase service account credentials (`FIREBASE_SERVICE_ACCOUNT_KEY` or file) are supplied.
- [ ] `.env` and `key.json` are excluded from version control (verified via `.gitignore`).
- [ ] Firestore indexes deployed via `firebase deploy --only firestore:indexes`.
- [ ] Load balancer health checks configured to `/health` (liveness) and `/ready` (readiness).
- [ ] Automated regression tests passed:
  ```bash
  node scratch/test-phase10.js
  node scratch/test-phase9.js
  node scratch/test-phase8.js
  node scratch/test-phase6.js
  node scratch/test-phase5-regression.js
  ```

