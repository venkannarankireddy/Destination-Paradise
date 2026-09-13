# Destination Paradise 🌴

A production-grade, two-sided travel marketplace connecting travelers with verified van drivers for regional and long-distance tourist journeys. Destination Paradise operates on a direct communication model (zero commission, no in-app payment handling) with administrative governance, role-based authorization, date-based availability scheduling, transactional concurrency protection, a deterministic **Trip Lifecycle State Machine**, and an **In-App Notification Engine**.

---

## 🌟 Key Platform Features

### 👤 Tourist Experience
- **Authentication:** Secure traveler registration and login with session fixation protection.
- **Trip Requests:** Submit structured trip requests with destination, date range, party size (1–20), and contact details.
- **Tourist Dashboard & Progress Stepper:** Track real-time trip progress through the complete lifecycle stepper (`Requested` $\to$ `Driver Accepted` $\to$ `In Progress` $\to$ `Completed`).
- **Direct Driver Access:** View assigned driver's verified profile, vehicle specifications, license plate, phone number, and direct call (`tel:`) or WhatsApp launchers.
- **Controlled Cancellation:** Cancel open requests or pre-trip accepted assignments with automatic driver schedule unblocking and notification.
- **In-App Notifications:** Real-time updates with navbar bell badge alert for driver assignment, trip start, and completion.

### 🚐 Van Driver Experience
- **Driver Portal:** Dedicated driver registration capturing driving experience, license number, vehicle model, plate number, and seating capacity (4–20).
- **Driver Availability Management:** Schedule, update, toggle, and delete date-based availability windows with automated overlap prevention.
- **Trip Marketplace:** Discover tourist trip requests matching vehicle capacity and scheduled availability windows.
- **Verification Requirement:** Production marketplace matching and trip acceptance strictly require `verificationStatus === "verified"` and `isActive === true`.
- **Direct Tourist Communication:** Call or message travelers directly to coordinate trip logistics and agree on pricing before accepting.
- **Transactional Acceptance:** Atomically accept trip requests with concurrency locking, availability coverage checks, and overlapping active trip prevention.
- **Trip Lifecycle Operations:**
  - **Start Trip (`/start`):** Validates scheduled travel date window (`fromDate <= today <= toDate` in `APP_TIMEZONE`) and launches trip to `"In Progress"`.
  - **Complete Trip (`/complete`):** Marks journey as `"Completed"`, logs completion timestamp, and releases driver calendar for future bookings.
  - **Emergency Cancellation (`/cancel`):** Enables withdrawal during emergencies with mandatory explanation ($\ge 5$ chars) while preserving historical vehicle and driver snapshot details.
- **Segmented My-Trips Schedule:** Distinct operational sections for active in-progress trips, upcoming accepted journeys, completed archives, and cancelled assignments.

### 🔔 In-App Notification System (Phase 9)
- **Zero Third-Party Dependency:** Operates securely within Firestore without external SMS, email, or WhatsApp dependencies.
- **Deterministic Document IDs:** Prevents duplicate notifications on transaction retries or duplicate user clicks.
- **Universal Navbar Bell:** Dynamic unread badge counter in header navigation.
- **Notification Feed (`/notifications`):** Interactive feed with unread filtering, individual mark-read, and secure bulk "Mark All as Read" strictly scoped to the authenticated session UID.

### 🛡️ Administrative Governance (Phase 8)
- **Role-Based Admin Access:** Server-enforced authorization (`requireAdmin`) on all `/admin*` routes. Tourists and drivers receive 403 Forbidden.
- **Secure CLI Admin Provisioning:** Zero public `/admin/register` routes. Administrators are provisioned exclusively via the server-side CLI operator tool:
  ```bash
  node scripts/make-admin.js <email>
  ```
- **Driver Verification Workflow:** Admin review page (`/admin/drivers/:id`) for reviewing personal information, driver license, driving experience, and vehicle capacity:
  - **Approve Driver:** Updates `verificationStatus: "verified"` and atomically dispatches in-app notification.
  - **Reject Driver:** Updates `verificationStatus: "rejected"` and atomically dispatches in-app notification.
- **Active Status Governance:** Admin can pause or reactivate drivers via modal confirmation while preserving verification status.
- **Platform Monitoring:** Read-only tracking of all platform trips (`/admin/trips`) with milestone timestamps, and registered users (`/admin/users`).
- **Audit Trails:** Automatic tracking of verification and active status update timestamps and admin UIDs.

### ⚙️ Production Infrastructure & Reliability (Phase 10)
- **Persistent Firestore Session Store:** Zero memory leaks, multi-instance cluster support, and process restart survivability via `FirestoreSessionStore` backed by `sessions/{sid}` in Firestore.
- **Request Correlation IDs:** Automatic propagation and validation of `X-Request-ID` across reverse proxies, application middlewares, structured logs, and client error responses.
- **Structured Logging:** Production single-line JSON logging with automatic deep redaction of sensitive credentials, secrets, and tokens, paired with HTTP request duration tracking.
- **Operational Health Endpoints:**
  - `GET /health`: Ultra-fast process liveness probe for container orchestrators.
  - `GET /ready`: Application readiness probe verifying Firestore connectivity with bounded timeout, short caching (preventing probe storms), and immediate 503 response during graceful shutdown.
- **Graceful Shutdown:** Controlled shutdown sequence handling `SIGTERM` and `SIGINT` with connection draining, timeout fallback, and idempotency guarantees.
- **Startup Configuration Validation:** Fast fail-safe startup checks detecting missing production credentials and enforcing 32+ char session secrets.
- **Production Deployment Guide:** Complete operational and reverse proxy configuration manual documented in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

### 🐳 Production Deployment & Operations (Phase 11)
- **Containerization on Node.js 24 Alpine LTS:** Production multi-stage `Dockerfile` running as unprivileged non-root `USER node` (`UID 1000:1000`) with zero development secrets baked into image layers.
- **Reverse Proxy Trust (`TRUST_PROXY`):** Hardened reverse proxy configuration (`TRUST_PROXY=1`) enabling secure cookies and client IP rate limiting behind ALBs and HTTPS proxies while preventing IP spoofing.
- **Reproducible Production Builds:** Supply-chain security enforced via `npm ci --omit=dev --ignore-scripts` based on `package-lock.json`.
- **Operational Runbook & Disaster Recovery:** Comprehensive operations manual, secret rotation protocols, and disaster recovery procedures in [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

---

## 🔒 Security & Hardening Architecture

- **CSRF Defense:** Double-Submit Cookie HMAC protection on all state-changing `POST` routes via `csrf-csrf`. Dual support for forms (`_csrf`) and AJAX (`X-CSRF-Token`).
- **Rate Limiting:** Multi-tiered IP rate limiting via `express-rate-limit` (auth endpoints: 50 req/15m; action endpoints: 120 req/15m).
- **HTTP Security Headers:** Strict Content-Security-Policy (whitelisting Google Identity Toolkit), HSTS, `X-Content-Type-Options: nosniff`, and `X-Frame-Options: SAMEORIGIN` via `helmet`.
- **Session Security:** Session ID regeneration (`req.session.regenerate()`) on authentication, `httpOnly`, `sameSite: lax`, 24h expiration, and cookie obfuscation (`dp.sid`).
- **Input Validation & Sanitization:** Strict payload sanitization, phone validation (7–15 digits), ISO date checks, and boundary enforcement.
- **Duplicate & Concurrency Defense:** Atomic Firestore transactions prevent conflicting concurrent operations (e.g. tourist cancel vs. driver start).
- **Strict Whitelist Updates:** Explicit field assignment on all Firestore updates, preventing arbitrary field injection or privilege escalation.

---

## 🛠️ Tech Stack

- **Runtime & Language:** Node.js (>= 18.x, v24 tested)
- **Backend Framework:** Express.js (v5.1.x)
- **Templating Engine:** EJS with component partials (`head`, `navbar`, `flash`, `footer`)
- **Database & Transactions:** Google Cloud Firestore (Firebase Admin SDK v13.x)
- **Session Storage:** Custom FirestoreSessionStore (`sessions/{sid}`)
- **Authentication:** Firebase Authentication (Google Identity Toolkit REST API v1)
- **Security Middleware:** `helmet`, `csrf-csrf`, `express-rate-limit`, `cookie-parser`, `express-session`

---

## 📁 Directory Structure

```
Destination-Paradise/
├── docs/
│   ├── ARCHITECTURE.md          # Complete architecture, schemas, and permission matrix
│   └── DEPLOYMENT.md            # Production deployment, Nginx proxy, and ops runbook
├── lib/
│   ├── config.js                # Startup environment & production configuration validator
│   ├── logger.js                # Structured JSON logger with sensitive data redaction
│   ├── request-id.js            # X-Request-ID correlation middleware
│   ├── session-store.js         # Persistent Firestore-backed express-session store
│   ├── health.js                # Liveness (/health) and cached readiness (/ready) router
│   └── shutdown.js              # Graceful shutdown coordinator for SIGTERM / SIGINT
├── public/
│   ├── css/
│   │   └── style.css            # Complete design system & responsive layout tokens
│   ├── js/
│   │   ├── main.js              # Mobile navigation drawer, flash dismissal, double-submit lock
│   │   └── booking.js           # Tourist booking form AJAX & validation handler
│   └── images/                  # Static assets
├── views/
│   ├── partials/
│   │   ├── head.ejs             # Universal head, meta tags, CSRF config, stylesheet
│   │   ├── navbar.ejs           # Role-aware responsive navigation bar with notification bell
│   │   ├── flash.ejs            # Auto-dismissing success/error alert banners
│   │   └── footer.ejs           # Platform model disclosure & legal links
│   ├── index.ejs                # Landing page & trip request submission
│   ├── login.ejs                # Tourist authentication
│   ├── register.ejs             # Tourist registration
│   ├── dashboard.ejs            # Tourist trip history & lifecycle progress stepper
│   ├── notifications.ejs        # In-app notifications feed with mark-as-read controls
│   ├── driver-login.ejs         # Driver portal login
│   ├── driver-register.ejs      # Driver registration & onboarding
│   ├── driver-dashboard.ejs     # Driver summary & active status toggle
│   ├── driver-profile.ejs       # Driver profile & vehicle specifications
│   ├── driver-availability.ejs  # Driver calendar availability manager & edit modal
│   ├── driver-trips.ejs         # Trip requests marketplace
│   ├── driver-my-trips.ejs      # Driver schedule (In Progress, Upcoming, Completed, Cancelled)
│   ├── admin-dashboard.ejs      # Admin overview metrics & pending review queue
│   ├── admin-drivers.ejs        # Driver directory, search, and status filters
│   ├── admin-driver-detail.ejs  # Driver review detail, verify/reject/toggle modals
│   ├── admin-trips.ejs          # Platform trip requests monitoring table
│   └── admin-users.ejs          # Platform user registry & role directory
├── scripts/
│   └── make-admin.js            # CLI tool to promote users to administrator
├── scratch/                     # Automated test suites (Phases 5, 6, 8, 9, 10)
├── firestore.indexes.json       # Firestore composite index definitions
├── app.js                       # Express application server
├── package.json                 # Node.js dependencies & scripts
└── README.md                    # Project documentation
```

---

## 🚀 Getting Started

### 1. Prerequisites
- Node.js (>= 18.0.0)
- npm (>= 8.0.0)
- Firebase Project with Firestore and Authentication enabled

### 2. Installation
```bash
git clone https://github.com/your-username/Destination-Paradise.git
cd Destination-Paradise
npm install
```

### 3. Environment Configuration
Create a `.env` file in the project root based on `.env.example`:
```ini
PORT=3000
NODE_ENV=development
FIREBASE_API_KEY=your_firebase_web_api_key
SESSION_SECRET=your_long_random_session_secret_at_least_32_chars
APP_TIMEZONE=Asia/Colombo
```
Ensure your Firebase Admin service account JSON key is placed at `./key.json` or configured via `GOOGLE_APPLICATION_CREDENTIALS`.

### 4. Provisioning an Administrator Account
1. Register a standard user account at `http://localhost:3000/register`.
2. Run the secure server-side provisioning command in your terminal:
   ```bash
   node scripts/make-admin.js admin@example.com
   ```
3. Log in at `http://localhost:3000/login`. You will be redirected to `/admin`.

### 5. Running the Application
```bash
npm start
```
Access the application at `http://localhost:3000`.

---

## 🧪 Test Suites & Verification

Execute the automated test suites against the running Express application and Firestore:

```bash
# Phase 11 Production Smoke Test Suite
node scratch/test-phase11-smoke.js

# Phase 11 Failure & Recovery Test Suite
node scratch/test-phase11-failure.js

# Phase 10 Production Infrastructure & Reliability Suite (52 tests)
node scratch/test-phase10.js

# Phase 9 Trip Lifecycle & Notification Suite (51 tests)
node scratch/test-phase9.js

# Phase 8 Admin Portal & Driver Verification Suite (39 tests)
node scratch/test-phase8.js

# Phase 6 Security & Hardening Suite (48 tests)
node scratch/test-phase6.js

# Phase 5 Marketplace & Overlap Regression Suite (29 tests)
node scratch/test-phase5-regression.js
```

---

## 📄 License & Credits
Developed by **Rankireddy Venkanna Babu** for Destination Paradise.
