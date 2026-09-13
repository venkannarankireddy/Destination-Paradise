# Destination Paradise 🌴

A production-grade, two-sided travel marketplace connecting travelers with verified van drivers for regional and long-distance tourist journeys. Destination Paradise operates on a direct communication model (zero commission, no in-app payment handling) with administrative governance, role-based authorization, date-based availability scheduling, and transactional concurrency protection.

---

## 🌟 Key Platform Features

### 👤 Tourist Experience
- **Authentication:** Secure traveler registration and login with session fixation protection.
- **Trip Requests:** Submit structured trip requests with destination, date range, party size (1–20), and contact details.
- **Tourist Dashboard:** Track real-time trip request statuses (`Looking for Driver`, `Driver Assigned`, `Cancelled`, `Confirmed`).
- **Direct Driver Access:** View assigned driver's verified profile, vehicle specifications, license plate, phone number, and direct call (`tel:`) or WhatsApp launchers.
- **Self-Service Cancellation:** Cancel pending or accepted trip requests directly from the dashboard.

### 🚐 Van Driver Experience
- **Driver Portal:** Dedicated driver registration capturing driving experience, license number, vehicle model, plate number, and seating capacity (4–20).
- **Driver Availability Management:** Schedule, update, toggle, and delete date-based availability windows with automated overlap prevention.
- **Trip Marketplace:** Discover tourist trip requests matching vehicle capacity and scheduled availability windows.
- **Verification Requirement:** Production marketplace matching and trip acceptance strictly require `verificationStatus === "verified"` and `isActive === true`.
- **Direct Tourist Communication:** Call or message travelers directly to discuss itinerary, baggage space, and mutually agreed compensation before accepting.
- **Transactional Acceptance:** Atomically accept trip requests with concurrency locking, availability coverage checks, and overlapping accepted trip prevention.
- **Trip Schedule:** Segmented view of upcoming active trips and historical journeys.

### 🛡️ Administrative Governance (Phase 8)
- **Role-Based Admin Access:** Server-enforced authorization (`requireAdmin`) on all `/admin*` routes. Tourists and drivers receive 403 Forbidden.
- **Secure CLI Admin Provisioning:** Zero public `/admin/register` routes. Administrators are provisioned exclusively via the server-side CLI operator tool:
  ```bash
  node scripts/make-admin.js <email>
  ```
- **Driver Verification Workflow:** Admin review page (`/admin/drivers/:id`) for reviewing personal information, driver license, driving experience, and vehicle capacity:
  - **Approve Driver:** Updates `verificationStatus: "verified"` and records admin UID audit metadata.
  - **Reject Driver:** Updates `verificationStatus: "rejected"` with confirmation modal without destroying account records.
- **Active Status Governance:** Admin can pause or reactivate drivers via modal confirmation while preserving verification status.
- **Platform Monitoring:** Read-only tracking of all platform trips (`/admin/trips`) and registered users (`/admin/users`).
- **Audit Trails:** Automatic tracking of `verificationUpdatedAt`, `verificationUpdatedBy`, `activeStatusUpdatedAt`, and `activeStatusUpdatedBy`.

---

## 🔒 Security & Hardening Architecture

- **CSRF Defense:** Double-Submit Cookie HMAC protection on all state-changing `POST` routes via `csrf-csrf`. Dual support for forms (`_csrf`) and AJAX (`X-CSRF-Token`).
- **Rate Limiting:** Multi-tiered IP rate limiting via `express-rate-limit` (auth endpoints: 50 req/15m; action endpoints: 120 req/15m).
- **HTTP Security Headers:** Strict Content-Security-Policy (whitelisting Google Identity Toolkit), HSTS, `X-Content-Type-Options: nosniff`, and `X-Frame-Options: SAMEORIGIN` via `helmet`.
- **Session Security:** Session ID regeneration (`req.session.regenerate()`) on authentication, `httpOnly`, `sameSite: lax`, 24h expiration, and cookie obfuscation (`dp.sid`).
- **Input Validation & Sanitization:** Strict payload sanitization, phone validation (7–15 digits), ISO date checks, and boundary enforcement.
- **Duplicate & Abuse Prevention:** Client-side button disabling and server-side 60-second duplicate trip window query.
- **Strict Whitelist Updates:** Explicit field assignment on all Firestore updates, preventing arbitrary field injection or privilege escalation.

---

## 🛠️ Tech Stack

- **Runtime & Language:** Node.js (>= 18.x, v24 tested)
- **Backend Framework:** Express.js (v5.1.x)
- **Templating Engine:** EJS with component partials (`head`, `navbar`, `flash`, `footer`)
- **Database & Transactions:** Google Cloud Firestore (Firebase Admin SDK v13.x)
- **Authentication:** Firebase Authentication (Google Identity Toolkit REST API v1)
- **Security Middleware:** `helmet`, `csrf-csrf`, `express-rate-limit`, `cookie-parser`, `express-session`

---

## 📁 Directory Structure

```
Destination-Paradise/
├── docs/
│   └── ARCHITECTURE.md          # Complete architecture, schemas, and permission matrix
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
│   │   ├── navbar.ejs           # Role-aware responsive navigation bar
│   │   ├── flash.ejs            # Auto-dismissing success/error alert banners
│   │   └── footer.ejs           # Platform model disclosure & legal links
│   ├── index.ejs                # Landing page & trip request submission
│   ├── login.ejs                # Tourist authentication
│   ├── register.ejs             # Tourist registration
│   ├── dashboard.ejs            # Tourist trip history & driver details
│   ├── driver-login.ejs         # Driver portal login
│   ├── driver-register.ejs      # Driver registration & onboarding
│   ├── driver-dashboard.ejs     # Driver summary & active status toggle
│   ├── driver-profile.ejs       # Driver profile & vehicle specifications
│   ├── driver-availability.ejs  # Driver calendar availability manager & edit modal
│   ├── driver-trips.ejs         # Trip requests marketplace
│   ├── driver-my-trips.ejs      # Driver accepted trips schedule (upcoming vs past)
│   ├── admin-dashboard.ejs      # Admin overview metrics & pending review queue
│   ├── admin-drivers.ejs        # Driver directory, search, and status filters
│   ├── admin-driver-detail.ejs  # Driver review detail, verify/reject/toggle modals
│   ├── admin-trips.ejs          # Platform trip requests monitoring table
│   └── admin-users.ejs          # Platform user registry & role directory
├── scripts/
│   └── make-admin.js            # CLI tool to promote users to administrator
├── scratch/                     # Automated test suites (Phase 5, 6, 8)
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
SESSION_SECRET=your_long_random_session_secret
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
# Phase 6 Security & Hardening Suite (48 tests)
node scratch/test-phase6.js

# Phase 5 Marketplace & Overlap Regression Suite (29 tests)
node scratch/test-phase5-regression.js

# Phase 8 Admin Portal & Driver Verification Suite (39 tests)
node scratch/test-phase8.js
```
*Total automated tests passing: 116 / 116 (100% success rate).*

---

## 📄 License & Credits
Developed by **Rankireddy Venkanna Babu** for Destination Paradise.
