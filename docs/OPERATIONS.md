# Destination Paradise — Production Operations & Runbook

This manual establishes operational protocols, disaster recovery procedures, supply-chain security analysis, and deployment runbooks for **Destination Paradise** (Phase 11).

---

## 1. System Architecture & Topology

Destination Paradise is designed as a **stateless, horizontally scalable Node.js application** utilizing a managed Cloud Firestore database:

```
[ Clients / Mobile / Browsers ]
               │
               ▼  (HTTPS / TLS Termination)
[ Upstream Reverse Proxy / Load Balancer ] (e.g. Cloudflare, AWS ALB, Nginx, GCP HTTPS LB)
  - Terminates TLS
  - Forwards X-Forwarded-For, X-Forwarded-Proto, X-Request-ID
               │
               ▼  (Internal HTTP Network)
[ Destination Paradise Containers ] (Node.js 24 Alpine, unprivileged non-root user)
  - Worker Instance 1  ──┐
  - Worker Instance 2  ──┼──> [ Firestore Database (Single Source of Truth) ]
  - Worker Instance N  ──┘     - bookings, drivers, users, availability,
                               - notifications, sessions/{sid}
```

### Key Scaling Properties
- **Web Tier Statelessness:** No in-memory session state is retained on the application server. Sessions reside in `sessions/{sid}` in Firestore via `FirestoreSessionStore`. Any container instance can handle any user request. Sticky sessions are not required.
- **Transactional Integrity:** Firestore ACID transactions (`db.runTransaction`) prevent double-booking, race conditions between tourist cancellation and driver start, and driver schedule overlap across all running instances.
- **Process Model:** Single-process execution per container running as PID 1 on **Node.js 24 Alpine LTS**, listening for `SIGTERM` and `SIGINT` signals.

---

## 2. Reverse Proxy & Trust Configuration (`TRUST_PROXY`)

### Hop Count Semantics
In `app.js`, reverse-proxy trust is configured via the `TRUST_PROXY` environment variable:

```ini
TRUST_PROXY=1
```

> [!IMPORTANT]
> `TRUST_PROXY=1` explicitly instructs Express to trust **exactly one upstream proxy hop**.
> - The application trusts `X-Forwarded-Proto` and `X-Forwarded-For` from the immediate proxy connection.
> - `req.secure` evaluates to `true` when `X-Forwarded-Proto: https` is supplied, allowing `secure: true` session cookies to be sent over HTTPS.
> - `req.ip` is extracted as the client's original IP rather than the load balancer's internal loopback address, enabling accurate IP rate limiting and security audit logs.

### Multi-Proxy Topologies
If your infrastructure routes traffic through multiple proxy layers (for example: `Cloudflare (Edge) -> AWS ALB (Load Balancer) -> Container`), setting `TRUST_PROXY=1` would trust only the ALB. To trust both hops:
- Set `TRUST_PROXY=2`, OR
- Supply an explicit comma-separated subnet or CIDR list:
  ```ini
  TRUST_PROXY=loopback, 10.0.0.0/8
  ```
Do **not** configure `TRUST_PROXY=true` indiscriminately in multi-tenant environments without upstream validation, as this could allow malicious clients to spoof client IP addresses by prepending arbitrary IP headers.

---

## 3. Containerization Architecture (`Dockerfile`)

The container image is built using a **multi-stage build on Node.js 24 Alpine LTS**:

- **Base Image:** `node:24-alpine` (official, lightweight LTS image with minimal attack surface).
- **Security User:** Runs as the built-in, unprivileged `node` user (`UID 1000:1000`). Root execution is explicitly prohibited.
- **Signal Handling:** Uses the exec form `CMD ["node", "app.js"]` so that Node.js runs as PID 1, receiving `SIGTERM` and `SIGINT` OS signals directly for graceful shutdown.
- **Zero Secret Baking:** The `.dockerignore` file strictly prevents `.env`, `key.json`, service-account credentials, `scratch/`, and local `node_modules/` from entering any image layer.

### Building and Running the Image
```bash
# 1. Build the production Docker image
docker build -t destination-paradise:latest .

# 2. Run the container with injected runtime secrets
docker run -d \
  --name destination-paradise \
  -p 3000:3000 \
  -e NODE_ENV=production \
  -e PORT=3000 \
  -e TRUST_PROXY=1 \
  -e SESSION_SECRET=your_strong_32_character_random_secret_here \
  -e FIREBASE_API_KEY=AIzaSy... \
  -e FIREBASE_SERVICE_ACCOUNT_KEY='{"type":"service_account",...}' \
  destination-paradise:latest
```

---

## 4. Supply-Chain Security & Dependency Audit

### Dependency Installation Model
In production builds, dependencies are installed using:
```bash
npm ci --omit=dev --ignore-scripts
```
> [!NOTE]
> `npm ci --omit=dev` ensures **reproducible production dependency installation based on package-lock.json**. It guarantees that only locked, production-tier dependencies are retrieved and suppresses arbitrary build scripts.

### Dependency Audit Findings (`npm audit`)
An automated audit of direct and transitive dependencies identified the following profile:
- **Direct Dependencies:** `body-parser`, `cookie-parser`, `csrf-csrf`, `dotenv`, `ejs`, `express`, `express-rate-limit`, `express-session`, `firebase-admin`, `helmet`.
- **Direct Vulnerabilities:** `0`. All direct dependencies are maintained and free of direct known CVEs.
- **Transitive Vulnerabilities:** Several low-to-moderate transitive advisories exist within the dependency tree of `firebase-admin` v13 (specifically `protobufjs`, `teeny-request`, `uuid`, and `qs`).
- **Exploitability Analysis:**
  - `protobufjs`: Relates to unbounded Any expansion in custom proto schemas. Destination Paradise does not accept or compile untrusted `.proto` schemas from clients.
  - `qs`: Relates to bracket/comma parsing memory limits. Express and Body-Parser configurations in Destination Paradise restrict URL-encoded bodies and disable extended comma array exploits.
- **Remediation Strategy:** Upgrading to `firebase-admin` v14 involves major semver breaking changes that could destabilize Firestore transactions and auth APIs. The recommended approach is to preserve the tested `firebase-admin` v13 baseline, enforce input length limits and rate limits, and plan a dedicated major SDK migration window when upstream packages publish patch releases.

---

## 5. Secret Management & Zero-Downtime Rotation

### Secret Injection
Secrets must **never** be checked into Git or baked into container images.
- **Environment Variables:**
  - `SESSION_SECRET`: Generated via `openssl rand -hex 32`. Injected at runtime.
  - `FIREBASE_API_KEY`: Injected from your cloud secrets manager.
- **Service Account Credentials:**
  - Option A (Cloud / Kubernetes Secret): Set `FIREBASE_SERVICE_ACCOUNT_KEY` to the JSON string.
  - Option B (Mounted Volume): Mount the service account file as read-only (e.g. `/secrets/key.json`) and set `GOOGLE_APPLICATION_CREDENTIALS=/secrets/key.json`.
  - Option C (GCP Native): In Google Cloud Run or GKE, omit the key file and utilize **Application Default Credentials (ADC)** linked to the service's IAM Service Account.

### Zero-Downtime Secret Rotation Protocol
1. **Rotating `SESSION_SECRET`:**
   - Express-session supports an array of secrets: `secret: [newSecret, oldSecret]`.
   - Update `SESSION_SECRET` in secret manager to include both secrets (comma-separated).
   - Deploy new instances: New sessions are signed with `newSecret`, while existing sessions signed with `oldSecret` remain valid.
   - After the 24-hour cookie expiration window, remove `oldSecret`.
2. **Rotating Firebase Service Account Keys:**
   - In Google Cloud Console IAM, create a second private key for the service account.
   - Update your secret manager with the new key JSON.
   - Perform a rolling restart of the application containers.
   - Once all containers run on the new key, delete the old key in Google Cloud Console.

---

## 6. Rolling Updates & Zero-Downtime Deployments

### Probe Configuration for Orchestrators
- **Liveness Probe (`/health`):**
  - Path: `/health`
  - Port: `3000`
  - Initial delay: `5s`
  - Period: `10s`
  - Timeout: `2s`
  - Success threshold: `1`
  - Failure threshold: `3`
- **Readiness Probe (`/ready`):**
  - Path: `/ready`
  - Port: `3000`
  - Initial delay: `5s`
  - Period: `5s`
  - Timeout: `3s`
  - Success threshold: `1`
  - Failure threshold: `2`

### Termination Sequence
When an orchestrator terminates a pod:
1. Orchestrator issues `SIGTERM` to the container.
2. `shutdownCoordinator` catches `SIGTERM` and immediately sets `isShuttingDown = true`.
3. The next `/ready` check by the load balancer immediately returns HTTP `503 Service Unavailable`, dropping the container from the active routing pool.
4. `server.close()` stops accepting new TCP connections.
5. In-flight requests are granted up to `10000ms` (`SHUTDOWN_TIMEOUT_MS`) to complete cleanly.
6. The process exits cleanly with code `0`.

---

## 7. Backup & Disaster Recovery Runbook

> [!NOTE]
> **Documented Recommendation vs. Implemented Infrastructure:**
> Destination Paradise does not bundle an embedded database backup engine; it relies on Google Cloud's managed Firestore backup capabilities.

### Recommended Scheduled Automated Backups
To protect against accidental data corruption or administrator errors, enable managed Firestore daily backups:

```bash
# Set retention schedule (e.g. 7-day retention window)
gcloud firestore backups schedules create \
  --database='(default)' \
  --recurrence=daily \
  --retention=7d
```

### Manual Export / Backup Procedure
Before performing major schema migrations or maintenance:

```bash
# Export all collections to Google Cloud Storage bucket
gcloud firestore export gs://YOUR_BACKUP_BUCKET_NAME/backups/$(date +%Y%m%d_%H%M%S)
```

### Disaster Recovery Restoration Procedure
In the event of catastrophic data loss:

```bash
# 1. Stop all application containers or point /ready to fail
# 2. Import the desired backup prefix into Firestore
gcloud firestore import gs://YOUR_BACKUP_BUCKET_NAME/backups/TARGET_BACKUP_FOLDER/

# 3. Verify collections restored: users, drivers, bookings, availability, notifications, sessions
# 4. Deploy composite indexes
firebase deploy --only firestore:indexes

# 5. Start application containers and verify /ready returns 200 OK
```

---

## 8. Incident Response & Troubleshooting

| Symptom | Probable Cause | Diagnostic Command / Log Query | Remediation |
|---|---|---|---|
| `/ready` returns HTTP 503 | Firestore connectivity failure, bad credentials, or shutdown active | Search logs for `firestore: "disconnected"` or `server: "shutting_down"` | Check GCP Firestore status; verify service account key permissions and quota. |
| Users logged out immediately | `SESSION_SECRET` changed abruptly without dual-secret transition, or Firestore `sessions` collection truncated | Check `sessions/{sid}` in Firestore; search logs for `Session destroy error` | Verify `SESSION_SECRET` consistency; restore sessions collection if wiped. |
| HTTP 403 `EBADCSRFTOKEN` spikes | Reverse proxy stripping cookies, or client cookie domain mismatch | Search logs for `CSRF token validation failed` with `requestId` | Ensure reverse proxy forwards `Cookie` header; verify `TRUST_PROXY=1` is set. |
| Driver cannot accept trip (`DRIVER_NOT_VERIFIED`) | Driver's `verificationStatus` is `pending` or `rejected` | Run `node scratch/test-phase8.js` or inspect `drivers/{uid}` | Administrator must approve driver via `/admin/drivers/:id`. |
| Driver cannot start trip (`TRIP_DATE_OUT_OF_RANGE`) | Current date in `APP_TIMEZONE` is outside `fromDate` and `toDate` | Check `APP_TIMEZONE` setting and scheduled trip date range | Trip can only start when `fromDate <= today <= toDate`. |

---

## 9. Operational Checklists

### Pre-Deployment Checklist
- [ ] Automated test suites pass: `Phase 5`, `Phase 6`, `Phase 8`, `Phase 9`, `Phase 10`, `Phase 11`.
- [ ] Node.js version verified: Node.js 24 Alpine LTS.
- [ ] Docker image built with non-root `USER node` and zero secrets baked in.
- [ ] `NODE_ENV=production` is set in the runtime environment.
- [ ] `SESSION_SECRET` is generated with 32+ characters and non-default value.
- [ ] `TRUST_PROXY=1` (or topology-appropriate count) is configured.
- [ ] Firebase credentials provided via environment variable or secret volume.
- [ ] Composite indexes deployed: `firebase deploy --only firestore:indexes`.

### Post-Deployment Checklist
- [ ] `GET /health` returns HTTP 200 OK.
- [ ] `GET /ready` returns HTTP 200 OK with `firestore: connected`.
- [ ] Browser session cookie has `secure: true; HttpOnly; SameSite=Lax`.
- [ ] Registration, login, and dashboard access succeed.
- [ ] In-app notification bell counter works as expected.
- [ ] Structured JSON logs are arriving in log aggregator with `requestId`.

