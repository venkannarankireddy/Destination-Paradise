# Destination Paradise 🌴

A full-stack tourist and van-driver trip matching marketplace platform that connects travelers with verified van drivers for long-distance and regional tourist trips.

## 🌟 Key Features

### Tourist Experience
- **Authentication:** Secure tourist registration and login powered by Firebase Authentication.
- **Trip Requests:** Submit trip requests with destination, date range, party size, and contact details.
- **Trip Dashboard:** Track trip request status (`Looking for Driver`, `Driver Assigned`, `Cancelled`).
- **Direct Driver Access:** View assigned driver's verified profile, vehicle details, phone number, and direct communication links.
- **Self-Service Cancellation:** Cancel pending or accepted trip requests directly from the dashboard.

### Van Driver Experience
- **Driver Portal:** Dedicated driver registration and login with vehicle and license verification.
- **Availability Management:** Schedule, toggle, update, and delete calendar availability windows with automatic date overlap prevention.
- **Trip Marketplace:** Real-time marketplace of open trip requests automatically matched against the driver's vehicle seating capacity and scheduled availability.
- **Direct Contact Workflow:** Call tourist directly or launch WhatsApp with pre-filled trip inquiries to agree on pricing and terms.
- **Transactional Acceptance:** Atomically accept trip requests with concurrency locking and overlapping trip conflict checks.
- **Trip Schedule:** View upcoming and past accepted trips with complete tourist contact details.

### Security & Hardening (Phase 6)
- **CSRF Protection:** Double-Submit Cookie HMAC CSRF protection on all state-changing `POST` routes via `csrf-csrf`.
- **Rate Limiting:** Multi-tiered IP rate limiting via `express-rate-limit` (auth endpoints: 50 req/15m; action endpoints: 120 req/15m).
- **Security Headers:** HTTP security headers via `helmet` including custom Content-Security-Policy, HSTS, and X-Frame-Options.
- **Session Hardening:** Session fixation defense using `req.session.regenerate()`, `httpOnly`, `sameSite: lax`, and obfuscated session cookie `dp.sid`.
- **Input Validation & Sanitization:** Strict payload sanitization, phone validation, ISO date checks, and boundary enforcement.
- **Duplicate Protection:** Accidental double-submit client locking and server-side 60-second duplicate trip prevention.
- **Strict Whitelist Writes:** Server-controlled Firestore payloads preventing arbitrary field injection.

---

## 🛠️ Tech Stack

- **Runtime:** Node.js (>= 18.x)
- **Framework:** Express.js (v5.x)
- **Templates:** EJS (Server-Side Rendered)
- **Database:** Google Cloud Firestore (Firebase Admin SDK)
- **Authentication:** Firebase Authentication (Google Identity Toolkit REST API)
- **Security:** `helmet`, `csrf-csrf`, `express-rate-limit`, `cookie-parser`

---

## 📁 Project Structure

```
Destination-Paradise/
├── docs/
│   └── ARCHITECTURE.md          # Full system architecture, schemas, and security matrix
├── public/
│   ├── css/                     # Stylesheets
│   ├── js/                      # Client-side scripts (booking.js, etc.)
│   └── images/                  # Static assets
├── views/
│   ├── index.ejs                # Homepage & tourist booking form
│   ├── login.ejs                # Tourist login
│   ├── register.ejs             # Tourist registration
│   ├── dashboard.ejs            # Tourist trip history & driver details
│   ├── driver-login.ejs         # Driver portal login
│   ├── driver-register.ejs      # Driver registration & onboarding
│   ├── driver-dashboard.ejs     # Driver summary & active toggle
│   ├── driver-profile.ejs       # Driver profile & vehicle management
│   ├── driver-availability.ejs  # Driver calendar availability manager
│   ├── driver-trips.ejs         # Trip requests marketplace
│   └── driver-my-trips.ejs      # Driver accepted trips schedule
├── scratch/                     # Automated test suites & verification scripts
├── firestore.indexes.json       # Firestore composite index definitions
├── app.js                       # Express application server
├── package.json                 # Node.js dependencies
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

### 3. Configuration
Copy `.env.example` to `.env` and fill in your credentials:
```bash
cp .env.example .env
```
Ensure your Firebase service account JSON key is placed at `./key.json` or set via `GOOGLE_APPLICATION_CREDENTIALS`.

### 4. Running the Application
```bash
npm start
```
The application will be accessible at: `http://localhost:3000`

---

<<<<<<< HEAD
```
http://localhost:3000
```

## Future Enhancements

- Payment gateway integration
- Hotel and flight booking
- Reviews and ratings
- Admin analytics dashboard
- Email notifications


=======
## 📄 License & Credits
Developed by **Rankireddy Venkanna Babu** for Destination Paradise.
>>>>>>> a8856da (feat: harden application for production)
