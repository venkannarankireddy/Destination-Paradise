require("dotenv").config();
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const express = require("express");
const admin = require("firebase-admin");
const bodyParser = require("body-parser");
const session = require("express-session");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { doubleCsrf } = require("csrf-csrf");
const path = require("path");
const fs = require("fs");

// Validate critical environment variables
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
if (!FIREBASE_API_KEY) {
  console.warn("⚠️ WARNING: FIREBASE_API_KEY is not defined in .env. Authentication requests will fail.");
}

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  if (process.env.NODE_ENV === "production") {
    console.error("❌ FATAL: SESSION_SECRET is required in production environment.");
    process.exit(1);
  } else {
    console.warn("⚠️ WARNING: SESSION_SECRET is not set in .env. Using fallback development secret.");
  }
}

// Initialize Firebase Admin SDK safely
let credential;
const localKeyPath = path.join(__dirname, "key.json");

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    const parsedKey = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    credential = admin.credential.cert(parsedKey);
  } else if (fs.existsSync(localKeyPath)) {
    const serviceAccount = JSON.parse(fs.readFileSync(localKeyPath, "utf8"));
    credential = admin.credential.cert(serviceAccount);
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    credential = admin.credential.applicationDefault();
  } else {
    console.error("❌ FATAL: No Firebase Admin credentials found. Provide key.json locally or set FIREBASE_SERVICE_ACCOUNT_KEY / GOOGLE_APPLICATION_CREDENTIALS.");
    process.exit(1);
  }

  admin.initializeApp({ credential });
} catch (err) {
  console.error("❌ FATAL: Failed to initialize Firebase Admin SDK:", err.message);
  process.exit(1);
}

// Initialize Firestore
let db;
try {
  db = admin.firestore();
} catch (err) {
  console.error("❌ FATAL: Failed to initialize Firestore:", err.message);
  process.exit(1);
}

const app = express();
const isProd = process.env.NODE_ENV === "production";

// ==========================================
// SECURITY HEADERS (HELMET)
// ==========================================
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: [
          "'self'",
          "https://identitytoolkit.googleapis.com",
          "https://*.firebaseio.com",
          "https://*.googleapis.com",
        ],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

// Body and Cookie Parsers
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(cookieParser(sessionSecret || "dev-fallback-secret-destination-paradise"));

// ==========================================
// SESSION HARDENING
// ==========================================
// Note: MemoryStore is used for development/single-process deployment.
// For multi-instance production environments, replace with Redis or a persistent store.
app.use(
  session({
    secret: sessionSecret || "dev-fallback-secret-destination-paradise",
    name: "dp.sid",
    resave: false,
    saveUninitialized: true,
    cookie: {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  })
);

// EJS view engine setup
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

// ==========================================
// RATE LIMITING
// ==========================================
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.AUTH_RATE_LIMIT, 10) || 50,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn(`⚠️ Auth rate limit reached for IP: ${req.ip}`);
    if (req.headers.accept && req.headers.accept.includes("application/json")) {
      return res.status(429).json({
        error: "TOO_MANY_REQUESTS",
        message: "Too many authentication attempts. Please try again in 15 minutes.",
      });
    }
    res.status(429).send("Too many authentication attempts. Please try again in 15 minutes.");
  },
});

const actionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.ACTION_RATE_LIMIT, 10) || 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn(`⚠️ Action rate limit reached for IP: ${req.ip}`);
    if (req.headers.accept && req.headers.accept.includes("application/json")) {
      return res.status(429).json({
        error: "TOO_MANY_REQUESTS",
        message: "Action rate limit exceeded. Please wait a few moments before trying again.",
      });
    }
    res.status(429).send("Action rate limit exceeded. Please wait a few moments before trying again.");
  },
});

// ==========================================
// CSRF PROTECTION (DOUBLE SUBMIT COOKIE)
// ==========================================
const { generateCsrfToken, doubleCsrfProtection } = doubleCsrf({
  getSecret: () => process.env.CSRF_SECRET || sessionSecret || "dev-fallback-secret-destination-paradise",
  getSessionIdentifier: (req) => req.session?.id || req.sessionID || "guest-session",
  cookieName: isProd ? "__Host-dp.x-csrf-token" : "dp.x-csrf-token",
  cookieOptions: {
    sameSite: "lax",
    path: "/",
    secure: isProd,
    httpOnly: true,
  },
  size: 64,
  ignoredMethods: ["GET", "HEAD", "OPTIONS"],
  getCsrfTokenFromRequest: (req) => req.body?._csrf || req.headers["x-csrf-token"],
});

// Expose user, unread notification count, and CSRF token to all templates
app.use(async (req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.unreadNotificationCount = 0;
  try {
    res.locals.csrfToken = generateCsrfToken(req, res);
  } catch (e) {
    res.locals.csrfToken = "";
  }

  if (req.session && req.session.user && req.session.user.uid && req.method === "GET") {
    try {
      const snap = await db
        .collection("notifications")
        .where("userId", "==", req.session.user.uid)
        .where("isRead", "==", false)
        .limit(10)
        .get();
      res.locals.unreadNotificationCount = snap.size;
    } catch (e) {
      res.locals.unreadNotificationCount = 0;
    }
  }

  next();
});

// Endpoint for programmatic / test CSRF token retrieval
app.get("/csrf-token", (req, res) => {
  res.json({ csrfToken: res.locals.csrfToken });
});

// Apply CSRF protection to all state-changing requests
app.use(doubleCsrfProtection);

// ==========================================
// ROLE-BASED ACCESS CONTROL MIDDLEWARE
// ==========================================

const requireAuth = (req, res, next) => {
  if (!req.session || !req.session.user) {
    return res.redirect("/login");
  }
  next();
};

const requireTourist = (req, res, next) => {
  if (!req.session || !req.session.user) {
    return res.redirect("/login");
  }
  if (req.session.user.role !== "tourist") {
    return res.status(403).send("Access forbidden: Tourist account required.");
  }
  next();
};

const requireDriver = (req, res, next) => {
  if (!req.session || !req.session.user) {
    return res.redirect("/driver/login");
  }
  if (req.session.user.role !== "driver") {
    return res.status(403).send("Access forbidden: Van Driver account required.");
  }
  next();
};

const requireAdmin = (req, res, next) => {
  if (!req.session || !req.session.user) {
    return res.redirect("/login");
  }
  if (req.session.user.role !== "admin") {
    return res.status(403).send("Access forbidden: Administrator account required.");
  }
  next();
};

// ==========================================
// INPUT VALIDATION & SANITIZATION HELPERS
// ==========================================

const sanitizeString = (str, maxLen = 100) => {
  if (typeof str !== "string") return "";
  return str.trim().slice(0, maxLen);
};

const isValidEmail = (email) => {
  if (!email || typeof email !== "string" || email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
};

const isValidPhone = (phone) => {
  if (!phone || typeof phone !== "string") return false;
  const digits = phone.replace(/[^0-9]/g, "");
  return digits.length >= 7 && digits.length <= 15;
};

const isValidCountryCode = (code) => {
  if (!code || typeof code !== "string") return false;
  return /^\+[0-9]{1,4}$/.test(code.trim());
};

const buildNotificationRecord = (notificationId, { userId, userRole, type, title, message, link = null, relatedTripId = null }) => {
  return {
    notificationId,
    userId,
    userRole: userRole || "tourist",
    type,
    title: sanitizeString(title, 120),
    message: sanitizeString(message, 500),
    link: link ? sanitizeString(link, 200) : null,
    relatedTripId: relatedTripId ? sanitizeString(relatedTripId, 100) : null,
    isRead: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    readAt: null,
  };
};

// ==========================================
// PUBLIC & TOURIST ROUTES
// ==========================================

app.get("/", (req, res) => {
  res.render("index");
});

app.get("/register", (req, res) => {
  res.render("register");
});

app.post("/register", authLimiter, async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password || password.length < 6 || password.length > 128) {
    return res.status(400).send("Registration failed: Email and a password between 6 and 128 characters are required.");
  }

  if (!isValidEmail(email)) {
    return res.status(400).send("Registration failed: A valid email address is required.");
  }

  try {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password, returnSecureToken: true }),
      }
    );

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    const uid = data.localId;
    const now = new Date();

    // Create users/{uid} document with role "tourist"
    await db.collection("users").doc(uid).set({
      uid,
      email: data.email,
      role: "tourist",
      createdAt: now,
      updatedAt: now,
    });

    req.session.regenerate((regErr) => {
      if (regErr) console.error("Session regeneration error:", regErr);
      req.session.user = { uid, email: data.email, role: "tourist" };
      res.redirect("/");
    });
  } catch (err) {
    res.status(400).send("Registration failed: " + (err.message || "An error occurred"));
  }
});

app.get("/login", (req, res) => {
  res.render("login");
});

app.post("/login", authLimiter, async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password || !isValidEmail(email)) {
    return res.status(400).send("Login failed: A valid email and password are required.");
  }

  try {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password, returnSecureToken: true }),
      }
    );

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    const uid = data.localId;
    const userDocRef = db.collection("users").doc(uid);
    const userDoc = await userDocRef.get();

    if (userDoc.exists) {
      const userData = userDoc.data();
      if (userData.role === "driver") {
        return res.status(403).send("This account is registered as a Van Driver. Please log in via the Driver Portal at /driver/login.");
      }
      const role = userData.role === "admin" ? "admin" : "tourist";
      req.session.regenerate((regErr) => {
        if (regErr) console.error("Session regeneration error:", regErr);
        req.session.user = { uid, email: data.email, role };
        if (role === "admin") {
          res.redirect("/admin");
        } else {
          res.redirect("/");
        }
      });
    } else {
      // Compatibility check: determine if this legacy account was a driver
      const driverDoc = await db.collection("drivers").doc(uid).get();
      if (driverDoc.exists) {
        await userDocRef.set({
          uid,
          email: data.email,
          role: "driver",
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        return res.status(403).send("This account is registered as a Van Driver. Please log in via the Driver Portal at /driver/login.");
      }

      // Legacy tourist account without a users document -> Lazy migration
      await userDocRef.set({
        uid,
        email: data.email,
        role: "tourist",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      req.session.regenerate((regErr) => {
        if (regErr) console.error("Session regeneration error:", regErr);
        req.session.user = { uid, email: data.email, role: "tourist" };
        res.redirect("/");
      });
    }
  } catch (err) {
    res.status(400).send("Login failed: " + (err.message || "An error occurred"));
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error("Session destroy error:", err);
    res.clearCookie("dp.sid");
    res.redirect("/login");
  });
});

app.get("/dashboard", requireTourist, async (req, res) => {
  try {
    const snapshot = await db
      .collection("bookings")
      .where("email", "==", req.session.user.email)
      .orderBy("bookedAt", "desc")
      .get();

    const bookings = [];

    snapshot.forEach((doc) => {
      const data = doc.data();

      bookings.push({
        id: doc.id,
        destination: data.destination,
        fromDate: data.fromDate
          ? new Date(data.fromDate).toLocaleDateString()
          : "N/A",
        toDate: data.toDate
          ? new Date(data.toDate).toLocaleDateString()
          : "N/A",
        people: data.people,
        name: data.name,
        email: data.email,
        countryCode: data.countryCode,
        phone: data.phone,
        status: data.status || "Requested",
        driverId: data.driverId || null,
        driverName: data.driverName || null,
        driverPhone: data.driverPhone || null,
        driverEmail: data.driverEmail || null,
        vanModel: data.vanModel || null,
        vanNumber: data.vanNumber || null,
        seatingCapacity: data.seatingCapacity || null,
        bookedAt: data.bookedAt
          ? (typeof data.bookedAt.toDate === "function" ? data.bookedAt.toDate().toLocaleString() : new Date(data.bookedAt).toLocaleString())
          : "N/A",
        acceptedAt: data.acceptedAt
          ? (typeof data.acceptedAt.toDate === "function" ? data.acceptedAt.toDate().toLocaleString() : new Date(data.acceptedAt).toLocaleString())
          : null,
        startedAt: data.startedAt
          ? (typeof data.startedAt.toDate === "function" ? data.startedAt.toDate().toLocaleString() : new Date(data.startedAt).toLocaleString())
          : null,
        completedAt: data.completedAt
          ? (typeof data.completedAt.toDate === "function" ? data.completedAt.toDate().toLocaleString() : new Date(data.completedAt).toLocaleString())
          : null,
        cancelledAt: data.cancelledAt
          ? (typeof data.cancelledAt.toDate === "function" ? data.cancelledAt.toDate().toLocaleString() : new Date(data.cancelledAt).toLocaleString())
          : null,
        cancelledBy: data.cancelledBy || null,
        cancellationReason: data.cancellationReason || null,
      });
    });

    res.render("dashboard", {
      bookings,
      successMessage: req.query.msg || null,
      errorMessage: req.query.err || null,
      user: req.session.user,
    });
  } catch (err) {
    console.error("❌ Dashboard error:", err.message);
    res.status(500).send("Unable to load bookings.");
  }
});

app.post("/bookings", actionLimiter, async (req, res) => {
  const user = req.session?.user;

  // Block unauthenticated users or non-tourists
  if (!user) {
    return res.status(401).json({ message: "You must be logged in to book." });
  }
  if (user.role !== "tourist") {
    return res.status(403).json({ message: "Only tourists can book trips." });
  }

  const {
    destination,
    fromDate,
    toDate,
    people,
    name,
    countryCode,
    phone,
    maritalStatus,
  } = req.body;

  const email = user.email;

  // Validate strings and length bounds
  const cleanDest = sanitizeString(destination, 100);
  const cleanName = sanitizeString(name, 100);
  const cleanCode = (countryCode || "").trim();
  const cleanPhone = (phone || "").trim();
  const cleanMarital = (maritalStatus || "").trim().toLowerCase();

  if (!cleanDest || cleanDest.length < 2) {
    return res.status(400).json({ message: "Destination name is required (at least 2 characters)." });
  }
  if (!cleanName || cleanName.length < 2) {
    return res.status(400).json({ message: "Tourist contact name is required (at least 2 characters)." });
  }
  if (!isValidCountryCode(cleanCode)) {
    return res.status(400).json({ message: "Invalid country code. Format e.g. +91, +1." });
  }
  if (!isValidPhone(cleanPhone)) {
    return res.status(400).json({ message: "A valid phone number with 7 to 15 digits is required." });
  }
  if (cleanMarital !== "single" && cleanMarital !== "married") {
    return res.status(400).json({ message: "Marital status must be either 'single' or 'married'." });
  }

  const passengerCount = parseInt(people, 10);
  if (isNaN(passengerCount) || passengerCount < 1 || passengerCount > 20) {
    return res.status(400).json({ message: "Passenger count must be an integer between 1 and 20." });
  }

  // Validate date strings and ranges
  if (!isValidDateString(fromDate) || !isValidDateString(toDate)) {
    return res.status(400).json({ message: "Dates must be valid in YYYY-MM-DD format." });
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const from = new Date(fromDate);
  const to = new Date(toDate);
  from.setHours(0, 0, 0, 0);
  to.setHours(0, 0, 0, 0);

  if (from <= today) {
    return res.status(400).json({ message: "'From' date must be at least tomorrow." });
  }
  if (to <= from) {
    return res.status(400).json({ message: "'To' date must be after 'From' date." });
  }

  // Maximum trip duration: 90 days
  const diffDays = Math.round((to - from) / (1000 * 60 * 60 * 24));
  if (diffDays > 90) {
    return res.status(400).json({ message: "Trip duration cannot exceed 90 days." });
  }

  try {
    // 1. Accidental rapid duplicate check (within last 60 seconds)
    const recentDuplicates = await db
      .collection("bookings")
      .where("email", "==", email)
      .where("destination", "==", cleanDest)
      .where("fromDate", "==", fromDate)
      .where("toDate", "==", toDate)
      .get();

    const nowMs = Date.now();
    const isDuplicate = recentDuplicates.docs.some((doc) => {
      const b = doc.data();
      if (b.status === "Cancelled") return false;
      const bTime = b.bookedAt?.toDate ? b.bookedAt.toDate().getTime() : new Date(b.bookedAt).getTime();
      return nowMs - bTime < 60000;
    });

    if (isDuplicate) {
      return res.status(409).json({
        message: "A duplicate trip request was already submitted recently. Please check your dashboard.",
      });
    }

    // 2. Check for conflicting active bookings for same destination
    const existingBookings = await db
      .collection("bookings")
      .where("email", "==", email)
      .where("destination", "==", cleanDest)
      .get();

    let conflict = false;
    existingBookings.forEach((doc) => {
      const data = doc.data();
      if (data.status === "Cancelled") return;

      const existingFrom = new Date(data.fromDate);
      const existingTo = new Date(data.toDate);
      if (from <= existingTo && to >= existingFrom) {
        conflict = true;
      }
    });

    if (conflict) {
      return res.status(400).json({
        message: "You already have an active booking request for this destination during the selected dates.",
      });
    }

    const bookingRef = db.collection("bookings").doc();
    const now = new Date();
    const booking = {
      bookingId: bookingRef.id,
      touristId: user.uid, // strictly server-authenticated session UID
      destination: cleanDest,
      fromDate,
      toDate,
      people: passengerCount,
      name: cleanName,
      email, // strictly from session
      countryCode: cleanCode,
      phone: cleanPhone,
      maritalStatus: cleanMarital,
      status: "Requested",
      driverId: null,
      bookedAt: now,
      updatedAt: now,
    };

    await bookingRef.set(booking);
    console.log(`✅ Validated trip request created: ID ${bookingRef.id} by ${email}`);
    return res.status(200).json({ message: "Trip request submitted! Available van drivers will review your trip." });
  } catch (error) {
    console.error("❌ Firestore error:", error.message);
    return res.status(500).json({ message: "Failed to save booking." });
  }
});

app.post("/cancel-booking/:id", requireTourist, actionLimiter, async (req, res) => {
  const tripId = sanitizeString(req.params.id, 128);
  const user = req.session.user;
  const wantsJson = !!(req.headers.accept && req.headers.accept.includes("application/json"));

  try {
    await db.runTransaction(async (transaction) => {
      const bookingRef = db.collection("bookings").doc(tripId);
      const bookingDoc = await transaction.get(bookingRef);

      if (!bookingDoc.exists) {
        const err = new Error("Booking not found.");
        err.code = "NOT_FOUND";
        throw err;
      }

      const bData = bookingDoc.data();

      // Only allow the owner to cancel (matching email or touristId)
      if (bData.email !== user.email && bData.touristId !== user.uid) {
        const err = new Error("Access forbidden: You can only cancel your own bookings.");
        err.code = "FORBIDDEN";
        throw err;
      }

      // Concurrency & lifecycle status checks
      if (bData.status === "In Progress") {
        const err = new Error("This trip is currently in progress and cannot be cancelled online.");
        err.code = "CANNOT_CANCEL_IN_PROGRESS";
        throw err;
      }

      if (bData.status === "Completed" || bData.status === "Cancelled") {
        const err = new Error(`Cannot cancel trip in '${bData.status}' status.`);
        err.code = "INVALID_STATE_TRANSITION";
        throw err;
      }

      if (!["Requested", "Accepted", "Confirmed"].includes(bData.status)) {
        const err = new Error(`Cannot cancel trip in '${bData.status}' status.`);
        err.code = "INVALID_STATE_TRANSITION";
        throw err;
      }

      const serverNow = admin.firestore.FieldValue.serverTimestamp();
      transaction.update(bookingRef, {
        status: "Cancelled",
        cancelledBy: "tourist",
        cancelledAt: serverNow,
        updatedAt: serverNow,
      });

      // If driver was assigned, atomically dispatch deterministic cancellation notification
      if (bData.driverId) {
        const notifId = `notif_${tripId}_TRIP_CANCELLED`;
        const notifRef = db.collection("notifications").doc(notifId);
        transaction.set(
          notifRef,
          buildNotificationRecord(notifId, {
            userId: bData.driverId,
            userRole: "driver",
            type: "TRIP_CANCELLED",
            title: "Trip Cancelled by Tourist",
            message: `Tourist ${bData.name || user.name || "Passenger"} has cancelled the booking for ${bData.destination || "destination"} (${bData.fromDate || "scheduled dates"}).`,
            link: "/driver/my-trips",
            relatedTripId: tripId,
          })
        );
      }
    });

    console.log(`✅ Booking ${tripId} cancelled by tourist ${user.email}`);

    if (wantsJson) {
      return res.status(200).json({ success: true, message: "Booking cancelled successfully." });
    }

    res.redirect("/dashboard?msg=" + encodeURIComponent("Booking cancelled successfully."));
  } catch (err) {
    console.error("❌ Cancel error:", err.code || err.message);

    if (err.code === "FORBIDDEN") {
      if (wantsJson) return res.status(403).json({ error: "FORBIDDEN", message: err.message });
      return res.status(403).send("Access forbidden: You can only cancel your own bookings.");
    }
    if (err.code === "NOT_FOUND") {
      if (wantsJson) return res.status(404).json({ error: "NOT_FOUND", message: err.message });
      return res.status(404).send("Booking not found.");
    }
    if (err.code === "CANNOT_CANCEL_IN_PROGRESS" || err.code === "INVALID_STATE_TRANSITION") {
      if (wantsJson) return res.status(400).json({ error: err.code, message: err.message });
      return res.redirect("/dashboard?err=" + encodeURIComponent(err.message));
    }

    if (wantsJson) return res.status(500).json({ error: "INTERNAL_ERROR", message: "Unable to cancel booking." });
    res.status(500).send("Unable to cancel booking.");
  }
});

// ==========================================
// DRIVER ROUTES
// ==========================================

app.get("/driver/register", (req, res) => {
  res.render("driver-register");
});

app.post("/driver/register", authLimiter, async (req, res) => {
  const {
    name,
    email,
    password,
    phone,
    licenseNumber,
    vanModel,
    vanNumber,
    seatingCapacity,
    experienceYears,
  } = req.body;

  const cleanName = sanitizeString(name, 100);
  const cleanEmail = (email || "").trim().toLowerCase();
  const cleanPhone = (phone || "").trim();
  const cleanLicense = sanitizeString(licenseNumber, 50);
  const cleanVanModel = sanitizeString(vanModel, 100);
  const cleanVanNumber = sanitizeString(vanNumber, 30);

  // Validation
  if (!cleanName || cleanName.length < 2) {
    return res.status(400).send("Full name is required (at least 2 characters).");
  }
  if (!isValidEmail(cleanEmail)) {
    return res.status(400).send("A valid email address is required.");
  }
  if (!password || password.length < 6 || password.length > 128) {
    return res.status(400).send("Password must be between 6 and 128 characters long.");
  }
  if (!isValidPhone(cleanPhone)) {
    return res.status(400).send("A valid phone number with 7 to 15 digits is required.");
  }
  if (!cleanLicense || cleanLicense.length < 3) {
    return res.status(400).send("A valid driver license number is required.");
  }
  if (!cleanVanModel || cleanVanModel.length < 2) {
    return res.status(400).send("Van model description is required.");
  }
  if (!cleanVanNumber || cleanVanNumber.length < 3) {
    return res.status(400).send("Vehicle plate / registration number is required.");
  }

  const capacity = parseInt(seatingCapacity, 10);
  if (isNaN(capacity) || capacity < 4 || capacity > 20) {
    return res.status(400).send("Passenger capacity must be an integer between 4 and 20.");
  }

  const experience = parseInt(experienceYears, 10);
  if (isNaN(experience) || experience < 0 || experience > 60) {
    return res.status(400).send("Driving experience must be between 0 and 60 years.");
  }

  try {
    // Create Firebase Auth user
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: cleanEmail, password, returnSecureToken: true }),
      }
    );

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    const uid = data.localId;
    const now = new Date();

    // Create users/{uid} document with role "driver"
    await db.collection("users").doc(uid).set({
      uid,
      email: data.email,
      role: "driver",
      createdAt: now,
      updatedAt: now,
    });

    // Create drivers/{uid} document
    await db.collection("drivers").doc(uid).set({
      uid,
      name: cleanName,
      email: data.email,
      phone: cleanPhone,
      licenseNumber: cleanLicense,
      vanModel: cleanVanModel,
      vanNumber: cleanVanNumber,
      seatingCapacity: capacity,
      experienceYears: experience,
      verificationStatus: "pending",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });

    req.session.regenerate((regErr) => {
      if (regErr) console.error("Session regeneration error:", regErr);
      req.session.user = { uid, email: data.email, role: "driver", name: cleanName };
      res.redirect("/driver/dashboard");
    });
  } catch (err) {
    res.status(400).send("Driver registration failed: " + (err.message || "An error occurred"));
  }
});

app.get("/driver/login", (req, res) => {
  res.render("driver-login");
});

app.post("/driver/login", authLimiter, async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password || !isValidEmail(email)) {
    return res.status(400).send("Driver login failed: A valid email and password are required.");
  }

  try {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password, returnSecureToken: true }),
      }
    );

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    const uid = data.localId;
    const userDocRef = db.collection("users").doc(uid);
    const userDoc = await userDocRef.get();

    if (userDoc.exists) {
      const userData = userDoc.data();
      if (userData.role !== "driver") {
        return res.status(403).send("Access denied. This login is for van drivers only. Please use the tourist login.");
      }
    } else {
      // Check drivers collection
      const driverDoc = await db.collection("drivers").doc(uid).get();
      if (!driverDoc.exists) {
        return res.status(403).send("Access denied. No driver profile found for this account. Please register as a driver.");
      }
      await userDocRef.set({
        uid,
        email: data.email,
        role: "driver",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    // Fetch driver profile
    const driverDoc = await db.collection("drivers").doc(uid).get();
    const driverData = driverDoc.exists ? driverDoc.data() : {};

    req.session.regenerate((regErr) => {
      if (regErr) console.error("Session regeneration error:", regErr);
      req.session.user = {
        uid,
        email: data.email,
        role: "driver",
        name: driverData.name || data.email,
      };
      res.redirect("/driver/dashboard");
    });
  } catch (err) {
    res.status(400).send("Driver login failed: " + (err.message || "An error occurred"));
  }
});

// ==========================================
// DATE & AVAILABILITY HELPERS
// ==========================================

const APP_TIMEZONE = process.env.APP_TIMEZONE || "Asia/Colombo";

const getApplicationTodayDateString = () => {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
};

const getTodayDateString = () => {
  return getApplicationTodayDateString();
};

const isValidDateString = (str) => {
  if (!str || typeof str !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return false;
  }
  const [y, m, d] = str.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
};

const checkAvailabilityOverlap = async (dbInstance, driverUid, newFrom, newTo, excludeId = null) => {
  const snapshot = await dbInstance
    .collection("drivers")
    .doc(driverUid)
    .collection("availability")
    .get();

  for (const doc of snapshot.docs) {
    if (excludeId && doc.id === excludeId) continue;
    const data = doc.data();
    const existingFrom = data.fromDate;
    const existingTo = data.toDate;

    // Overlap condition: (newFrom <= existingTo) && (newTo >= existingFrom)
    if (newFrom <= existingTo && newTo >= existingFrom) {
      return {
        overlap: true,
        conflictingPeriod: {
          id: doc.id,
          fromDate: existingFrom,
          toDate: existingTo,
          status: data.status,
        },
      };
    }
  }

  return { overlap: false };
};

// Driver matching logic for Marketplace:
// 1. Trip status == "Requested"
// 2. Driver isActive == true
// 3. Driver verificationStatus == "verified"
// 4. Driver van seatingCapacity >= trip.people
// 5. Driver has an availability period with period.status == "available" AND
//    trip.fromDate >= period.fromDate AND trip.toDate <= period.toDate
const isTripMatchForDriver = (trip, driver, driverAvailability) => {
  if (trip.status !== "Requested") return false;
  if (!driver.isActive) return false;
  if (driver.verificationStatus !== "verified") return false;
  if (Number(driver.seatingCapacity) < Number(trip.people)) return false;

  const covered = driverAvailability.some((period) => {
    if (period.status !== "available") return false;
    return trip.fromDate >= period.fromDate && trip.toDate <= period.toDate;
  });

  return covered;
};

app.get("/driver/dashboard", requireDriver, async (req, res) => {
  try {
    const driverDoc = await db.collection("drivers").doc(req.session.user.uid).get();

    if (!driverDoc.exists) {
      return res.status(404).send("Driver profile not found.");
    }

    const availSnapshot = await db
      .collection("drivers")
      .doc(req.session.user.uid)
      .collection("availability")
      .orderBy("fromDate", "asc")
      .get();

    const todayStr = getTodayDateString();
    const availabilities = [];
    availSnapshot.forEach((doc) => {
      const data = doc.data();
      availabilities.push({
        availabilityId: doc.id,
        ...data,
      });
    });

    const upcomingAvailabilities = availabilities.filter((p) => p.toDate >= todayStr);

    // Count matching trip requests for this driver
    const requestedTripsSnap = await db
      .collection("bookings")
      .where("status", "==", "Requested")
      .get();

    let matchingTripsCount = 0;
    requestedTripsSnap.forEach((doc) => {
      const trip = doc.data();
      if (isTripMatchForDriver(trip, driverDoc.data(), availabilities)) {
        matchingTripsCount++;
      }
    });

    // Count accepted trips for this driver
    const acceptedTripsSnap = await db
      .collection("bookings")
      .where("driverId", "==", req.session.user.uid)
      .where("status", "==", "Accepted")
      .get();
    const acceptedTripsCount = acceptedTripsSnap.size;

    res.render("driver-dashboard", {
      driver: driverDoc.data(),
      availabilities: upcomingAvailabilities,
      totalAvailabilities: availabilities.length,
      matchingTripsCount,
      acceptedTripsCount,
      user: req.session.user,
    });
  } catch (err) {
    console.error("❌ Driver dashboard error:", err.message);
    res.status(500).send("Unable to load driver dashboard.");
  }
});

app.post("/driver/toggle-active", requireDriver, actionLimiter, async (req, res) => {
  try {
    const driverRef = db.collection("drivers").doc(req.session.user.uid);
    const driverDoc = await driverRef.get();

    if (!driverDoc.exists) {
      return res.status(404).send("Driver profile not found.");
    }

    const currentStatus = !!driverDoc.data().isActive;
    await driverRef.update({
      isActive: !currentStatus,
      updatedAt: new Date(),
    });

    res.redirect("/driver/dashboard");
  } catch (err) {
    console.error("❌ Driver active toggle error:", err.message);
    res.status(500).send("Unable to update active status.");
  }
});

app.get("/driver/profile", requireDriver, async (req, res) => {
  try {
    const driverDoc = await db.collection("drivers").doc(req.session.user.uid).get();
    if (!driverDoc.exists) {
      return res.status(404).send("Driver profile not found.");
    }

    res.render("driver-profile", {
      driver: driverDoc.data(),
      user: req.session.user,
      successMessage: null,
      errorMessage: null,
    });
  } catch (err) {
    console.error("❌ Driver profile error:", err.message);
    res.status(500).send("Unable to load profile.");
  }
});

app.post("/driver/profile", requireDriver, actionLimiter, async (req, res) => {
  const {
    name,
    phone,
    licenseNumber,
    vanModel,
    vanNumber,
    seatingCapacity,
    experienceYears,
  } = req.body;

  const cleanName = sanitizeString(name, 100);
  const cleanPhone = (phone || "").trim();
  const cleanLicense = sanitizeString(licenseNumber, 50);
  const cleanVanModel = sanitizeString(vanModel, 100);
  const cleanVanNumber = sanitizeString(vanNumber, 30);

  if (!cleanName || cleanName.length < 2) {
    return res.status(400).send("Full name is required (at least 2 characters).");
  }
  if (!isValidPhone(cleanPhone)) {
    return res.status(400).send("A valid phone number with 7 to 15 digits is required.");
  }
  if (!cleanLicense || cleanLicense.length < 3) {
    return res.status(400).send("A valid driver license number is required.");
  }
  if (!cleanVanModel || cleanVanModel.length < 2) {
    return res.status(400).send("Van model is required.");
  }
  if (!cleanVanNumber || cleanVanNumber.length < 3) {
    return res.status(400).send("Vehicle registration number is required.");
  }

  const capacity = parseInt(seatingCapacity, 10);
  if (isNaN(capacity) || capacity < 4 || capacity > 20) {
    return res.status(400).send("Passenger capacity must be an integer between 4 and 20.");
  }

  const experience = parseInt(experienceYears, 10);
  if (isNaN(experience) || experience < 0 || experience > 60) {
    return res.status(400).send("Driving experience must be between 0 and 60 years.");
  }

  try {
    const driverRef = db.collection("drivers").doc(req.session.user.uid);
    const updatedData = {
      name: cleanName,
      phone: cleanPhone,
      licenseNumber: cleanLicense,
      vanModel: cleanVanModel,
      vanNumber: cleanVanNumber,
      seatingCapacity: capacity,
      experienceYears: experience,
      updatedAt: new Date(),
    };

    await driverRef.update(updatedData);

    req.session.user.name = cleanName;

    const freshDoc = await driverRef.get();
    res.render("driver-profile", {
      driver: freshDoc.data(),
      user: req.session.user,
      successMessage: "✅ Profile updated successfully!",
      errorMessage: null,
    });
  } catch (err) {
    console.error("❌ Driver profile update error:", err.message);
    res.status(500).send("Unable to update profile.");
  }
});

// ==========================================
// DRIVER AVAILABILITY ROUTES
// ==========================================

app.get("/driver/availability", requireDriver, async (req, res) => {
  try {
    const availSnapshot = await db
      .collection("drivers")
      .doc(req.session.user.uid)
      .collection("availability")
      .orderBy("fromDate", "asc")
      .get();

    const availabilities = [];
    availSnapshot.forEach((doc) => {
      const data = doc.data();
      availabilities.push({
        availabilityId: doc.id,
        ...data,
      });
    });

    res.render("driver-availability", {
      availabilities,
      user: req.session.user,
      todayStr: getTodayDateString(),
      successMessage: req.query.msg || null,
      errorMessage: req.query.err || null,
    });
  } catch (err) {
    console.error("❌ Driver availability fetch error:", err.message);
    res.status(500).send("Unable to load availability.");
  }
});

app.post("/driver/availability", requireDriver, actionLimiter, async (req, res) => {
  const { fromDate, toDate, status } = req.body;
  const todayStr = getTodayDateString();

  if (!fromDate || !toDate) {
    return res.redirect("/driver/availability?err=Both+from+and+to+dates+are+required.");
  }

  if (!isValidDateString(fromDate) || !isValidDateString(toDate)) {
    return res.redirect("/driver/availability?err=Invalid+date+format.+Use+YYYY-MM-DD.");
  }

  if (fromDate < todayStr) {
    return res.redirect("/driver/availability?err=Availability+cannot+start+in+the+past.");
  }

  if (toDate < fromDate) {
    return res.redirect("/driver/availability?err=From+date+cannot+be+after+to+date.");
  }

  try {
    const overlapResult = await checkAvailabilityOverlap(db, req.session.user.uid, fromDate, toDate);
    if (overlapResult.overlap) {
      const conf = overlapResult.conflictingPeriod;
      return res.redirect(
        `/driver/availability?err=Overlapping+period+detected.+You+already+have+availability+from+${conf.fromDate}+to+${conf.toDate}.`
      );
    }

    const availRef = db
      .collection("drivers")
      .doc(req.session.user.uid)
      .collection("availability")
      .doc();

    const now = new Date();
    await availRef.set({
      availabilityId: availRef.id,
      driverId: req.session.user.uid,
      fromDate,
      toDate,
      status: status === "unavailable" ? "unavailable" : "available",
      createdAt: now,
      updatedAt: now,
    });

    res.redirect("/driver/availability?msg=Availability+window+added+successfully!");
  } catch (err) {
    console.error("❌ Add availability error:", err.message);
    res.redirect("/driver/availability?err=Failed+to+save+availability.");
  }
});

app.post("/driver/availability/:id/update", requireDriver, actionLimiter, async (req, res) => {
  const { fromDate, toDate, status } = req.body;
  const { id } = req.params;
  const todayStr = getTodayDateString();

  if (!fromDate || !toDate) {
    return res.redirect("/driver/availability?err=Both+from+and+to+dates+are+required.");
  }

  if (!isValidDateString(fromDate) || !isValidDateString(toDate)) {
    return res.redirect("/driver/availability?err=Invalid+date+format.+Use+YYYY-MM-DD.");
  }

  if (fromDate < todayStr) {
    return res.redirect("/driver/availability?err=Availability+cannot+start+in+the+past.");
  }

  if (toDate < fromDate) {
    return res.redirect("/driver/availability?err=From+date+cannot+be+after+to+date.");
  }

  try {
    const availDocRef = db
      .collection("drivers")
      .doc(req.session.user.uid)
      .collection("availability")
      .doc(id);

    const docSnap = await availDocRef.get();
    if (!docSnap.exists) {
      return res.redirect("/driver/availability?err=Availability+record+not+found.");
    }

    // Overlap check excluding current record
    const overlapResult = await checkAvailabilityOverlap(db, req.session.user.uid, fromDate, toDate, id);
    if (overlapResult.overlap) {
      const conf = overlapResult.conflictingPeriod;
      return res.redirect(
        `/driver/availability?err=Cannot+update:+overlaps+with+existing+period+${conf.fromDate}+to+${conf.toDate}.`
      );
    }

    await availDocRef.update({
      fromDate,
      toDate,
      status: status === "unavailable" ? "unavailable" : "available",
      updatedAt: new Date(),
    });

    res.redirect("/driver/availability?msg=Availability+period+updated+successfully!");
  } catch (err) {
    console.error("❌ Update availability error:", err.message);
    res.redirect("/driver/availability?err=Failed+to+update+availability.");
  }
});

app.post("/driver/availability/:id/delete", requireDriver, actionLimiter, async (req, res) => {
  const { id } = req.params;

  try {
    const availDocRef = db
      .collection("drivers")
      .doc(req.session.user.uid)
      .collection("availability")
      .doc(id);

    const docSnap = await availDocRef.get();
    if (!docSnap.exists) {
      return res.redirect("/driver/availability?err=Availability+record+not+found.");
    }

    await availDocRef.delete();
    res.redirect("/driver/availability?msg=Availability+window+deleted+successfully.");
  } catch (err) {
    console.error("❌ Delete availability error:", err.message);
    res.redirect("/driver/availability?err=Failed+to+delete+availability.");
  }
});

app.post("/driver/availability/:id/toggle", requireDriver, actionLimiter, async (req, res) => {
  const { id } = req.params;

  try {
    const availDocRef = db
      .collection("drivers")
      .doc(req.session.user.uid)
      .collection("availability")
      .doc(id);

    const docSnap = await availDocRef.get();
    if (!docSnap.exists) {
      return res.redirect("/driver/availability?err=Availability+record+not+found.");
    }

    const currentStatus = docSnap.data().status;
    const newStatus = currentStatus === "available" ? "unavailable" : "available";

    await availDocRef.update({
      status: newStatus,
      updatedAt: new Date(),
    });

    res.redirect(`/driver/availability?msg=Status+updated+to+${newStatus}.`);
  } catch (err) {
    console.error("❌ Toggle availability error:", err.message);
    res.redirect("/driver/availability?err=Failed+to+toggle+status.");
  }
});

// ==========================================
// DRIVER TRIP REQUESTS MARKETPLACE
// ==========================================

app.get("/driver/trips", requireDriver, async (req, res) => {
  try {
    const driverDoc = await db.collection("drivers").doc(req.session.user.uid).get();
    if (!driverDoc.exists) {
      return res.status(404).send("Driver profile not found.");
    }
    const driver = driverDoc.data();

    // Fetch driver availability windows
    const availSnapshot = await db
      .collection("drivers")
      .doc(req.session.user.uid)
      .collection("availability")
      .get();

    const availability = availSnapshot.docs.map((doc) => doc.data());

    // Fetch all Requested bookings
    const tripsSnapshot = await db
      .collection("bookings")
      .where("status", "==", "Requested")
      .get();

    const allRequested = [];
    tripsSnapshot.forEach((doc) => {
      allRequested.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    // Sort by bookedAt desc
    allRequested.sort((a, b) => {
      const timeA = a.bookedAt ? (typeof a.bookedAt.toDate === "function" ? a.bookedAt.toDate().getTime() : new Date(a.bookedAt).getTime()) : 0;
      const timeB = b.bookedAt ? (typeof b.bookedAt.toDate === "function" ? b.bookedAt.toDate().getTime() : new Date(b.bookedAt).getTime()) : 0;
      return timeB - timeA;
    });

    // Match trips against driver constraints
    const matchingTrips = [];
    const destFilter = (req.query.destination || "").trim().toLowerCase();
    const fromFilter = (req.query.fromDate || "").trim();
    const toFilter = (req.query.toDate || "").trim();
    const peopleFilter = parseInt(req.query.people, 10);

    allRequested.forEach((trip) => {
      if (isTripMatchForDriver(trip, driver, availability)) {
        // Query filters
        if (destFilter && !trip.destination.toLowerCase().includes(destFilter)) return;
        if (fromFilter && trip.fromDate < fromFilter) return;
        if (toFilter && trip.toDate > toFilter) return;
        if (!isNaN(peopleFilter) && peopleFilter > 0 && trip.people > peopleFilter) return;

        matchingTrips.push(trip);
      }
    });

    res.render("driver-trips", {
      driver,
      trips: matchingTrips,
      filters: req.query,
      successMessage: req.query.msg || null,
      errorMessage: req.query.err || null,
      user: req.session.user,
    });
  } catch (err) {
    console.error("❌ Driver trips marketplace error:", err.message);
    res.status(500).send("Unable to load trip requests marketplace.");
  }
});

// ==========================================
// DRIVER ACCEPT TRIP ENDPOINT (TRANSACTIONAL)
// ==========================================

app.post("/driver/trips/:id/accept", requireDriver, actionLimiter, async (req, res) => {
  const tripId = req.params.id;
  const driverUid = req.session.user.uid;
  const wantsJson = !!(req.headers.accept && req.headers.accept.includes("application/json"));

  try {
    await db.runTransaction(async (transaction) => {
      // 1. Read target trip
      const tripRef = db.collection("bookings").doc(tripId);
      const tripDoc = await transaction.get(tripRef);

      if (!tripDoc.exists) {
        const err = new Error("Trip not found.");
        err.code = "TRIP_NOT_FOUND";
        throw err;
      }

      const trip = tripDoc.data();

      // 2. Verify trip status is exactly "Requested"
      if (trip.status !== "Requested") {
        const err = new Error("This trip has already been accepted by another driver.");
        err.code = "TRIP_ALREADY_ACCEPTED";
        throw err;
      }

      // 3. Read authenticated driver profile
      const driverRef = db.collection("drivers").doc(driverUid);
      const driverDoc = await transaction.get(driverRef);

      if (!driverDoc.exists) {
        const err = new Error("Driver profile not found.");
        err.code = "DRIVER_NOT_FOUND";
        throw err;
      }

      const driver = driverDoc.data();

      // 4. Verify driver isActive == true
      if (!driver.isActive) {
        const err = new Error("Your driver account is currently inactive. Activate your profile before accepting trips.");
        err.code = "DRIVER_INACTIVE";
        throw err;
      }

      // 4b. Verify driver verificationStatus == "verified"
      if (driver.verificationStatus !== "verified") {
        const err = new Error(
          driver.verificationStatus === "rejected"
            ? "Your driver account has been rejected by administration."
            : "Your driver account is pending verification. Only verified drivers can accept trips."
        );
        err.code = driver.verificationStatus === "rejected" ? "DRIVER_REJECTED" : "DRIVER_NOT_VERIFIED";
        throw err;
      }

      // 5. Verify driver seating capacity >= trip.people
      const vanCapacity = Number(driver.seatingCapacity);
      const tripPeople = Number(trip.people);
      if (isNaN(vanCapacity) || isNaN(tripPeople) || vanCapacity < tripPeople) {
        const err = new Error("Your van does not have enough seats for this trip.");
        err.code = "INSUFFICIENT_CAPACITY";
        throw err;
      }

      // 6. Verify driver has an availability window covering the entire trip
      const availQuery = db
        .collection("drivers")
        .doc(driverUid)
        .collection("availability");
      const availSnapshot = await transaction.get(availQuery);

      const hasCoverage = availSnapshot.docs.some((doc) => {
        const period = doc.data();
        if (period.status !== "available") return false;
        return trip.fromDate >= period.fromDate && trip.toDate <= period.toDate;
      });

      if (!hasCoverage) {
        const err = new Error("You are no longer available for the complete requested date range.");
        err.code = "AVAILABILITY_CHANGED";
        throw err;
      }

      // 7. Verify driver has no overlapping Accepted or In Progress trip
      const activeTripsQuery = db
        .collection("bookings")
        .where("driverId", "==", driverUid);
      const activeSnapshot = await transaction.get(activeTripsQuery);

      for (const doc of activeSnapshot.docs) {
        const existingTrip = doc.data();
        if (existingTrip.status !== "Accepted" && existingTrip.status !== "In Progress") {
          continue;
        }
        // Overlap condition: (newFrom <= existingTo) && (newTo >= existingFrom)
        if (trip.fromDate <= existingTrip.toDate && trip.toDate >= existingTrip.fromDate) {
          const err = new Error("You already have an active trip during these dates.");
          err.code = "OVERLAPPING_TRIP";
          throw err;
        }
      }

      // 8. Atomic update: Assign authenticated driver and set status to "Accepted"
      const serverNow = admin.firestore.FieldValue.serverTimestamp();
      transaction.update(tripRef, {
        status: "Accepted",
        driverId: driverUid,
        driverName: driver.name || "",
        driverPhone: driver.phone || "",
        driverEmail: driver.email || "",
        vanModel: driver.vanModel || "",
        vanNumber: driver.vanNumber || "",
        seatingCapacity: vanCapacity,
        acceptedAt: serverNow,
        updatedAt: serverNow,
      });

      // 8b. Atomic deterministic notification for tourist
      const touristRecipientId = trip.touristId || trip.email;
      if (touristRecipientId) {
        const notifId = `notif_${tripId}_TRIP_ACCEPTED`;
        const notifRef = db.collection("notifications").doc(notifId);
        transaction.set(
          notifRef,
          buildNotificationRecord(notifId, {
            userId: touristRecipientId,
            userRole: "tourist",
            type: "TRIP_ACCEPTED",
            title: "Driver Assigned!",
            message: `Driver ${driver.name || "Driver"} has accepted your trip to ${trip.destination}. Contact details are now available on your dashboard.`,
            link: "/dashboard",
            relatedTripId: tripId,
          })
        );
      }
    });

    console.log(`✅ Trip ${tripId} successfully accepted by driver ${driverUid}`);

    if (wantsJson) {
      return res.status(200).json({
        success: true,
        message: "Trip accepted successfully!",
        tripId,
      });
    }

    res.redirect("/driver/my-trips?msg=" + encodeURIComponent("Trip accepted successfully! You can now contact your passenger."));
  } catch (err) {
    console.error("❌ Trip acceptance error:", err.code || err.message);

    let userMessage = "Unable to accept the trip right now. Please try again.";

    if (err.code === "TRIP_ALREADY_ACCEPTED") {
      userMessage = "Sorry, this trip has already been accepted by another driver.";
    } else if (err.code === "OVERLAPPING_TRIP") {
      userMessage = "You already have an active trip during these dates.";
    } else if (err.code === "DRIVER_INACTIVE") {
      userMessage = "Your driver account is currently inactive. Activate your profile before accepting trips.";
    } else if (err.code === "DRIVER_REJECTED") {
      userMessage = "Your driver account has been rejected by administration.";
    } else if (err.code === "DRIVER_NOT_VERIFIED") {
      userMessage = "Your driver account is pending verification. Only verified drivers can accept trips.";
    } else if (err.code === "INSUFFICIENT_CAPACITY") {
      userMessage = "Your van does not have enough seats for this trip.";
    } else if (err.code === "AVAILABILITY_CHANGED") {
      userMessage = "You are no longer available for the complete requested date range.";
    } else if (err.code === "TRIP_NOT_FOUND") {
      userMessage = "This trip request does not exist.";
    }

    if (wantsJson) {
      const statusCode = err.code === "TRIP_NOT_FOUND" ? 404 : 400;
      return res.status(statusCode).json({
        error: err.code || "SERVER_ERROR",
        message: userMessage,
      });
    }

    res.redirect("/driver/trips?err=" + encodeURIComponent(userMessage));
  }
});

// ==========================================
// DRIVER START TRIP ENDPOINT
// ==========================================

app.post("/driver/trips/:id/start", requireDriver, actionLimiter, async (req, res) => {
  const tripId = sanitizeString(req.params.id, 128);
  const driverUid = req.session.user.uid;
  const wantsJson = !!(req.headers.accept && req.headers.accept.includes("application/json"));

  try {
    await db.runTransaction(async (transaction) => {
      // 1. Read trip
      const tripRef = db.collection("bookings").doc(tripId);
      const tripDoc = await transaction.get(tripRef);

      if (!tripDoc.exists) {
        const err = new Error("Trip not found.");
        err.code = "TRIP_NOT_FOUND";
        throw err;
      }

      const trip = tripDoc.data();

      // 2. Ownership check: must be assigned to caller
      if (trip.driverId !== driverUid) {
        const err = new Error("Access forbidden: You are not the assigned driver for this trip.");
        err.code = "FORBIDDEN";
        throw err;
      }

      // 3. Status guard: must be Accepted
      if (trip.status !== "Accepted") {
        const err = new Error(`Cannot start trip in status '${trip.status}'. Trip must be 'Accepted'.`);
        err.code = "INVALID_STATE_TRANSITION";
        throw err;
      }

      // 4. Production verification and active check
      const driverRef = db.collection("drivers").doc(driverUid);
      const driverDoc = await transaction.get(driverRef);

      if (!driverDoc.exists) {
        const err = new Error("Driver profile not found.");
        err.code = "DRIVER_NOT_FOUND";
        throw err;
      }

      const driver = driverDoc.data();
      if (!driver.isActive) {
        const err = new Error("Your driver account is inactive. Activate your profile before starting trips.");
        err.code = "DRIVER_INACTIVE";
        throw err;
      }
      if (driver.verificationStatus !== "verified") {
        const err = new Error("Your driver account is pending or not verified. Only verified drivers can start trips.");
        err.code = "DRIVER_NOT_VERIFIED";
        throw err;
      }

      // 5. Date validation in application timezone
      const todayStr = getApplicationTodayDateString();
      if (todayStr < trip.fromDate) {
        const err = new Error(`Cannot start trip before the scheduled start date (${trip.fromDate}).`);
        err.code = "TRIP_TOO_EARLY";
        throw err;
      }
      if (todayStr > trip.toDate) {
        const err = new Error(`Cannot start trip after the scheduled end date (${trip.toDate}).`);
        err.code = "TRIP_PAST_WINDOW";
        throw err;
      }

      // 6. Atomic state transition
      const serverNow = admin.firestore.FieldValue.serverTimestamp();
      transaction.update(tripRef, {
        status: "In Progress",
        startedAt: serverNow,
        updatedAt: serverNow,
      });

      // 7. Atomic deterministic notification for tourist
      const touristRecipientId = trip.touristId || trip.email;
      if (touristRecipientId) {
        const notifId = `notif_${tripId}_TRIP_STARTED`;
        const notifRef = db.collection("notifications").doc(notifId);
        transaction.set(
          notifRef,
          buildNotificationRecord(notifId, {
            userId: touristRecipientId,
            userRole: "tourist",
            type: "TRIP_STARTED",
            title: "Trip In Progress! 🚀",
            message: `Driver ${driver.name || trip.driverName || "Driver"} has started your trip to ${trip.destination}. Safe travels!`,
            link: "/dashboard",
            relatedTripId: tripId,
          })
        );
      }
    });

    console.log(`✅ Trip ${tripId} started by driver ${driverUid}`);

    if (wantsJson) {
      return res.status(200).json({ success: true, message: "Trip started successfully!" });
    }

    res.redirect("/driver/my-trips?msg=" + encodeURIComponent("Trip started successfully! Have a safe journey."));
  } catch (err) {
    console.error("❌ Start trip error:", err.code || err.message);

    if (err.code === "FORBIDDEN" || err.code === "DRIVER_INACTIVE" || err.code === "DRIVER_NOT_VERIFIED") {
      if (wantsJson) return res.status(403).json({ error: err.code, message: err.message });
      return res.status(403).send(err.message);
    }
    if (err.code === "TRIP_NOT_FOUND" || err.code === "DRIVER_NOT_FOUND") {
      if (wantsJson) return res.status(404).json({ error: err.code, message: err.message });
      return res.status(404).send(err.message);
    }
    if (err.code === "TRIP_TOO_EARLY" || err.code === "TRIP_PAST_WINDOW" || err.code === "INVALID_STATE_TRANSITION") {
      if (wantsJson) return res.status(400).json({ error: err.code, message: err.message });
      return res.redirect("/driver/my-trips?err=" + encodeURIComponent(err.message));
    }

    if (wantsJson) return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to start trip." });
    res.redirect("/driver/my-trips?err=" + encodeURIComponent("Failed to start trip."));
  }
});

// ==========================================
// DRIVER COMPLETE TRIP ENDPOINT
// ==========================================

app.post("/driver/trips/:id/complete", requireDriver, actionLimiter, async (req, res) => {
  const tripId = sanitizeString(req.params.id, 128);
  const driverUid = req.session.user.uid;
  const wantsJson = !!(req.headers.accept && req.headers.accept.includes("application/json"));

  try {
    await db.runTransaction(async (transaction) => {
      // 1. Read trip
      const tripRef = db.collection("bookings").doc(tripId);
      const tripDoc = await transaction.get(tripRef);

      if (!tripDoc.exists) {
        const err = new Error("Trip not found.");
        err.code = "TRIP_NOT_FOUND";
        throw err;
      }

      const trip = tripDoc.data();

      // 2. Ownership check
      if (trip.driverId !== driverUid) {
        const err = new Error("Access forbidden: You are not the assigned driver for this trip.");
        err.code = "FORBIDDEN";
        throw err;
      }

      // 3. Status guard: must be In Progress
      if (trip.status !== "In Progress") {
        const err = new Error(`Cannot complete trip in status '${trip.status}'. Trip must be 'In Progress'.`);
        err.code = "INVALID_STATE_TRANSITION";
        throw err;
      }

      // 4. Authorization check
      const driverRef = db.collection("drivers").doc(driverUid);
      const driverDoc = await transaction.get(driverRef);

      if (!driverDoc.exists) {
        const err = new Error("Driver profile not found.");
        err.code = "DRIVER_NOT_FOUND";
        throw err;
      }

      const driver = driverDoc.data();
      if (!driver.isActive) {
        const err = new Error("Your driver account is inactive.");
        err.code = "DRIVER_INACTIVE";
        throw err;
      }
      if (driver.verificationStatus !== "verified") {
        const err = new Error("Your driver account is not verified.");
        err.code = "DRIVER_NOT_VERIFIED";
        throw err;
      }

      // 5. Atomic state transition to Completed
      const serverNow = admin.firestore.FieldValue.serverTimestamp();
      transaction.update(tripRef, {
        status: "Completed",
        completedAt: serverNow,
        updatedAt: serverNow,
      });

      // 6. Atomic deterministic notification for tourist
      const touristRecipientId = trip.touristId || trip.email;
      if (touristRecipientId) {
        const notifId = `notif_${tripId}_TRIP_COMPLETED`;
        const notifRef = db.collection("notifications").doc(notifId);
        transaction.set(
          notifRef,
          buildNotificationRecord(notifId, {
            userId: touristRecipientId,
            userRole: "tourist",
            type: "TRIP_COMPLETED",
            title: "Trip Completed! 🏁",
            message: `Your trip to ${trip.destination} has concluded. Thank you for traveling with Destination Paradise!`,
            link: "/dashboard",
            relatedTripId: tripId,
          })
        );
      }
    });

    console.log(`✅ Trip ${tripId} completed by driver ${driverUid}`);

    if (wantsJson) {
      return res.status(200).json({ success: true, message: "Trip completed successfully!" });
    }

    res.redirect("/driver/my-trips?msg=" + encodeURIComponent("Trip marked as completed. Great job!"));
  } catch (err) {
    console.error("❌ Complete trip error:", err.code || err.message);

    if (err.code === "FORBIDDEN" || err.code === "DRIVER_INACTIVE" || err.code === "DRIVER_NOT_VERIFIED") {
      if (wantsJson) return res.status(403).json({ error: err.code, message: err.message });
      return res.status(403).send(err.message);
    }
    if (err.code === "TRIP_NOT_FOUND" || err.code === "DRIVER_NOT_FOUND") {
      if (wantsJson) return res.status(404).json({ error: err.code, message: err.message });
      return res.status(404).send(err.message);
    }
    if (err.code === "INVALID_STATE_TRANSITION") {
      if (wantsJson) return res.status(400).json({ error: err.code, message: err.message });
      return res.redirect("/driver/my-trips?err=" + encodeURIComponent(err.message));
    }

    if (wantsJson) return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to complete trip." });
    res.redirect("/driver/my-trips?err=" + encodeURIComponent("Failed to complete trip."));
  }
});

// ==========================================
// DRIVER EMERGENCY CANCEL TRIP ENDPOINT
// ==========================================

app.post("/driver/trips/:id/cancel", requireDriver, actionLimiter, async (req, res) => {
  const tripId = sanitizeString(req.params.id, 128);
  const driverUid = req.session.user.uid;
  const reason = sanitizeString(req.body.reason || "", 500).trim();
  const wantsJson = !!(req.headers.accept && req.headers.accept.includes("application/json"));

  if (!reason || reason.length < 5) {
    if (wantsJson) {
      return res.status(400).json({ error: "VALIDATION_ERROR", message: "A valid cancellation reason (minimum 5 characters) is required." });
    }
    return res.redirect("/driver/my-trips?err=" + encodeURIComponent("A valid cancellation reason (minimum 5 characters) is required."));
  }

  try {
    await db.runTransaction(async (transaction) => {
      // 1. Read trip
      const tripRef = db.collection("bookings").doc(tripId);
      const tripDoc = await transaction.get(tripRef);

      if (!tripDoc.exists) {
        const err = new Error("Trip not found.");
        err.code = "TRIP_NOT_FOUND";
        throw err;
      }

      const trip = tripDoc.data();

      // 2. Ownership check
      if (trip.driverId !== driverUid) {
        const err = new Error("Access forbidden: You are not the assigned driver for this trip.");
        err.code = "FORBIDDEN";
        throw err;
      }

      // 3. Status guard: must be Accepted or In Progress
      if (!["Accepted", "In Progress"].includes(trip.status)) {
        const err = new Error(`Cannot cancel trip in '${trip.status}' status.`);
        err.code = "INVALID_STATE_TRANSITION";
        throw err;
      }

      // If client explicitly specified expected status, guard against concurrent mutations
      const fromStatus = sanitizeString(req.body.fromStatus || req.body.currentStatus || "", 30);
      if (fromStatus && trip.status !== fromStatus) {
        const err = new Error(`Cannot cancel trip: Expected status '${fromStatus}' but trip is currently '${trip.status}'.`);
        err.code = "INVALID_STATE_TRANSITION";
        throw err;
      }

      // 4. Authorization check
      const driverRef = db.collection("drivers").doc(driverUid);
      const driverDoc = await transaction.get(driverRef);

      if (!driverDoc.exists) {
        const err = new Error("Driver profile not found.");
        err.code = "DRIVER_NOT_FOUND";
        throw err;
      }

      const driver = driverDoc.data();
      if (!driver.isActive) {
        const err = new Error("Your driver account is inactive.");
        err.code = "DRIVER_INACTIVE";
        throw err;
      }
      if (driver.verificationStatus !== "verified") {
        const err = new Error("Your driver account is not verified.");
        err.code = "DRIVER_NOT_VERIFIED";
        throw err;
      }

      // 5. Atomic state transition: PRESERVE ALL DRIVER SNAPSHOT FIELDS
      const serverNow = admin.firestore.FieldValue.serverTimestamp();
      transaction.update(tripRef, {
        status: "Cancelled",
        cancelledBy: "driver",
        cancellationReason: reason,
        cancelledAt: serverNow,
        updatedAt: serverNow,
        // driverId, driverName, driverPhone, driverEmail, vanModel, vanNumber, seatingCapacity are strictly preserved
      });

      // 6. Atomic deterministic notification for tourist
      const touristRecipientId = trip.touristId || trip.email;
      if (touristRecipientId) {
        const notifId = `notif_${tripId}_TRIP_CANCELLED`;
        const notifRef = db.collection("notifications").doc(notifId);
        transaction.set(
          notifRef,
          buildNotificationRecord(notifId, {
            userId: touristRecipientId,
            userRole: "tourist",
            type: "TRIP_CANCELLED",
            title: "Trip Cancelled by Driver",
            message: `Driver ${driver.name || trip.driverName || "Driver"} had to cancel your trip to ${trip.destination}. Reason: ${reason}`,
            link: "/dashboard",
            relatedTripId: tripId,
          })
        );
      }
    });

    console.log(`⚠️ Trip ${tripId} cancelled by driver ${driverUid} with reason: ${reason}`);

    if (wantsJson) {
      return res.status(200).json({ success: true, message: "Trip cancelled successfully." });
    }

    res.redirect("/driver/my-trips?msg=" + encodeURIComponent("Trip has been cancelled."));
  } catch (err) {
    console.error("❌ Driver cancel trip error:", err.code || err.message);

    if (err.code === "FORBIDDEN" || err.code === "DRIVER_INACTIVE" || err.code === "DRIVER_NOT_VERIFIED") {
      if (wantsJson) return res.status(403).json({ error: err.code, message: err.message });
      return res.status(403).send(err.message);
    }
    if (err.code === "TRIP_NOT_FOUND" || err.code === "DRIVER_NOT_FOUND") {
      if (wantsJson) return res.status(404).json({ error: err.code, message: err.message });
      return res.status(404).send(err.message);
    }
    if (err.code === "INVALID_STATE_TRANSITION") {
      if (wantsJson) return res.status(400).json({ error: err.code, message: err.message });
      return res.redirect("/driver/my-trips?err=" + encodeURIComponent(err.message));
    }

    if (wantsJson) return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to cancel trip." });
    res.redirect("/driver/my-trips?err=" + encodeURIComponent("Failed to cancel trip."));
  }
});

// ==========================================
// DRIVER MY ACCEPTED & ACTIVE TRIPS
// ==========================================

app.get("/driver/my-trips", requireDriver, async (req, res) => {
  try {
    const todayStr = getApplicationTodayDateString();

    const tripsSnapshot = await db
      .collection("bookings")
      .where("driverId", "==", req.session.user.uid)
      .get();

    const myTrips = [];
    tripsSnapshot.forEach((doc) => {
      myTrips.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    // In Progress: status === "In Progress"
    const inProgressTrips = myTrips.filter((t) => t.status === "In Progress");

    // Upcoming: status === "Accepted" (sorted by fromDate asc)
    const upcomingTrips = myTrips
      .filter((t) => t.status === "Accepted")
      .sort((a, b) => (a.fromDate || "").localeCompare(b.fromDate || ""));

    // Completed: status === "Completed" (sorted by toDate desc)
    const completedTrips = myTrips
      .filter((t) => t.status === "Completed")
      .sort((a, b) => (b.toDate || "").localeCompare(a.toDate || ""));

    // Cancelled: status === "Cancelled" (sorted by toDate desc)
    const cancelledTrips = myTrips
      .filter((t) => t.status === "Cancelled")
      .sort((a, b) => (b.toDate || "").localeCompare(a.toDate || ""));

    res.render("driver-my-trips", {
      inProgressTrips,
      upcomingTrips,
      completedTrips,
      cancelledTrips,
      todayStr,
      successMessage: req.query.msg || null,
      errorMessage: req.query.err || null,
      user: req.session.user,
    });
  } catch (err) {
    console.error("❌ Driver my-trips error:", err.message);
    res.status(500).send("Unable to load your accepted trips.");
  }
});

// ==========================================
// ADMIN PORTAL ROUTES
// ==========================================

app.get("/admin", requireAdmin, async (req, res) => {
  try {
    const [usersSnap, driversSnap, tripsSnap] = await Promise.all([
      db.collection("users").get(),
      db.collection("drivers").get(),
      db.collection("bookings").get(),
    ]);

    const totalUsers = usersSnap.size;
    const totalDrivers = driversSnap.size;
    const totalTrips = tripsSnap.size;

    let pendingDriversCount = 0;
    let activeDriversCount = 0;
    const allDrivers = [];

    driversSnap.forEach((doc) => {
      const data = doc.data();
      if (data.verificationStatus === "pending") pendingDriversCount++;
      if (data.isActive) activeDriversCount++;
      allDrivers.push({ id: doc.id, ...data });
    });

    let requestedTripsCount = 0;
    let acceptedTripsCount = 0;
    let cancelledTripsCount = 0;
    const allTrips = [];

    tripsSnap.forEach((doc) => {
      const data = doc.data();
      if (data.status === "Requested") requestedTripsCount++;
      else if (data.status === "Accepted") acceptedTripsCount++;
      else if (data.status === "Cancelled") cancelledTripsCount++;
      allTrips.push({ id: doc.id, ...data });
    });

    // Pending drivers for quick review (up to 5)
    const pendingDrivers = allDrivers
      .filter((d) => d.verificationStatus === "pending")
      .sort((a, b) => {
        const tA = a.createdAt?.toDate ? a.createdAt.toDate().getTime() : new Date(a.createdAt || 0).getTime();
        const tB = b.createdAt?.toDate ? b.createdAt.toDate().getTime() : new Date(b.createdAt || 0).getTime();
        return tB - tA;
      })
      .slice(0, 5);

    // Recent trips (up to 5)
    const recentTrips = allTrips
      .sort((a, b) => {
        const tA = a.bookedAt?.toDate ? a.bookedAt.toDate().getTime() : new Date(a.bookedAt || 0).getTime();
        const tB = b.bookedAt?.toDate ? b.bookedAt.toDate().getTime() : new Date(b.bookedAt || 0).getTime();
        return tB - tA;
      })
      .slice(0, 5);

    // Recent drivers (up to 5)
    const recentDrivers = allDrivers
      .sort((a, b) => {
        const tA = a.createdAt?.toDate ? a.createdAt.toDate().getTime() : new Date(a.createdAt || 0).getTime();
        const tB = b.createdAt?.toDate ? b.createdAt.toDate().getTime() : new Date(b.createdAt || 0).getTime();
        return tB - tA;
      })
      .slice(0, 5);

    res.render("admin-dashboard", {
      stats: {
        totalUsers,
        totalDrivers,
        pendingDriversCount,
        activeDriversCount,
        totalTrips,
        requestedTripsCount,
        acceptedTripsCount,
        cancelledTripsCount,
      },
      pendingDrivers,
      recentTrips,
      recentDrivers,
      successMessage: req.query.msg || null,
      errorMessage: req.query.err || null,
      user: req.session.user,
    });
  } catch (err) {
    console.error("❌ Admin dashboard error:", err.message);
    res.status(500).send("Unable to load admin dashboard.");
  }
});

app.get("/admin/drivers", requireAdmin, async (req, res) => {
  try {
    const driversSnap = await db.collection("drivers").get();
    let drivers = [];

    driversSnap.forEach((doc) => {
      drivers.push({ id: doc.id, ...doc.data() });
    });

    // Filter by status tab
    const statusFilter = (req.query.status || "all").trim().toLowerCase();
    if (statusFilter === "pending") {
      drivers = drivers.filter((d) => d.verificationStatus === "pending");
    } else if (statusFilter === "verified") {
      drivers = drivers.filter((d) => d.verificationStatus === "verified");
    } else if (statusFilter === "rejected") {
      drivers = drivers.filter((d) => d.verificationStatus === "rejected");
    } else if (statusFilter === "active") {
      drivers = drivers.filter((d) => d.isActive === true);
    } else if (statusFilter === "inactive") {
      drivers = drivers.filter((d) => d.isActive === false);
    }

    // Search filter
    const q = (req.query.q || "").trim().toLowerCase();
    if (q) {
      drivers = drivers.filter((d) => {
        const nameMatch = (d.name || "").toLowerCase().includes(q);
        const emailMatch = (d.email || "").toLowerCase().includes(q);
        const vanMatch = (d.vanNumber || "").toLowerCase().includes(q);
        const modelMatch = (d.vanModel || "").toLowerCase().includes(q);
        return nameMatch || emailMatch || vanMatch || modelMatch;
      });
    }

    // Sort by createdAt desc
    drivers.sort((a, b) => {
      const tA = a.createdAt?.toDate ? a.createdAt.toDate().getTime() : new Date(a.createdAt || 0).getTime();
      const tB = b.createdAt?.toDate ? b.createdAt.toDate().getTime() : new Date(b.createdAt || 0).getTime();
      return tB - tA;
    });

    res.render("admin-drivers", {
      drivers,
      currentFilter: statusFilter,
      searchQuery: q,
      successMessage: req.query.msg || null,
      errorMessage: req.query.err || null,
      user: req.session.user,
    });
  } catch (err) {
    console.error("❌ Admin drivers list error:", err.message);
    res.status(500).send("Unable to load drivers directory.");
  }
});

app.get("/admin/drivers/:id", requireAdmin, async (req, res) => {
  const driverId = sanitizeString(req.params.id, 128);
  if (!driverId) {
    return res.status(404).send("Driver profile not found.");
  }

  try {
    const driverDoc = await db.collection("drivers").doc(driverId).get();
    if (!driverDoc.exists) {
      return res.status(404).send("Driver profile not found.");
    }

    const driver = { id: driverDoc.id, ...driverDoc.data() };

    const [availSnap, tripsSnap] = await Promise.all([
      db.collection("drivers").doc(driverId).collection("availability").get(),
      db.collection("bookings").where("driverId", "==", driverId).get(),
    ]);

    const availabilityCount = availSnap.size;
    const acceptedTripsCount = tripsSnap.size;

    res.render("admin-driver-detail", {
      driver,
      availabilityCount,
      acceptedTripsCount,
      successMessage: req.query.msg || null,
      errorMessage: req.query.err || null,
      user: req.session.user,
    });
  } catch (err) {
    console.error("❌ Admin driver detail error:", err.message);
    res.status(500).send("Unable to load driver details.");
  }
});

app.post("/admin/drivers/:id/verify", requireAdmin, actionLimiter, async (req, res) => {
  const driverId = sanitizeString(req.params.id, 128);
  const adminUid = req.session.user.uid;

  try {
    const driverRef = db.collection("drivers").doc(driverId);
    const driverDoc = await driverRef.get();

    if (!driverDoc.exists) {
      return res.status(404).send("Driver profile not found.");
    }

    const serverNow = admin.firestore.FieldValue.serverTimestamp();
    const batch = db.batch();

    batch.update(driverRef, {
      verificationStatus: "verified",
      verificationUpdatedAt: serverNow,
      verificationUpdatedBy: adminUid,
      updatedAt: serverNow,
    });

    const notifId = `notif_${driverId}_DRIVER_VERIFIED`;
    const notifRef = db.collection("notifications").doc(notifId);
    batch.set(
      notifRef,
      buildNotificationRecord(notifId, {
        userId: driverId,
        userRole: "driver",
        type: "DRIVER_VERIFIED",
        title: "Account Verified! 🎉",
        message: "Congratulations! Your driver account has been reviewed and verified by administration. You can now receive and accept trip requests in the marketplace.",
        link: "/driver/trips",
      })
    );

    await batch.commit();

    console.log(`✅ Admin ${adminUid} verified driver ${driverId}`);
    res.redirect(`/admin/drivers/${driverId}?msg=` + encodeURIComponent("Driver has been approved and verified successfully."));
  } catch (err) {
    console.error("❌ Admin verify driver error:", err.message);
    res.redirect(`/admin/drivers/${driverId}?err=` + encodeURIComponent("Failed to verify driver."));
  }
});

app.post("/admin/drivers/:id/reject", requireAdmin, actionLimiter, async (req, res) => {
  const driverId = sanitizeString(req.params.id, 128);
  const adminUid = req.session.user.uid;

  try {
    const driverRef = db.collection("drivers").doc(driverId);
    const driverDoc = await driverRef.get();

    if (!driverDoc.exists) {
      return res.status(404).send("Driver profile not found.");
    }

    const serverNow = admin.firestore.FieldValue.serverTimestamp();
    const batch = db.batch();

    batch.update(driverRef, {
      verificationStatus: "rejected",
      verificationUpdatedAt: serverNow,
      verificationUpdatedBy: adminUid,
      updatedAt: serverNow,
    });

    const notifId = `notif_${driverId}_DRIVER_REJECTED`;
    const notifRef = db.collection("notifications").doc(notifId);
    batch.set(
      notifRef,
      buildNotificationRecord(notifId, {
        userId: driverId,
        userRole: "driver",
        type: "DRIVER_REJECTED",
        title: "Verification Update",
        message: "Your driver registration application has been reviewed and was not approved by platform administration.",
        link: "/driver/dashboard",
      })
    );

    await batch.commit();

    console.log(`⚠️ Admin ${adminUid} rejected driver ${driverId}`);
    res.redirect(`/admin/drivers/${driverId}?msg=` + encodeURIComponent("Driver verification has been rejected."));
  } catch (err) {
    console.error("❌ Admin reject driver error:", err.message);
    res.redirect(`/admin/drivers/${driverId}?err=` + encodeURIComponent("Failed to reject driver."));
  }
});

app.post("/admin/drivers/:id/toggle-active", requireAdmin, actionLimiter, async (req, res) => {
  const driverId = sanitizeString(req.params.id, 128);
  const adminUid = req.session.user.uid;

  try {
    const driverRef = db.collection("drivers").doc(driverId);
    const driverDoc = await driverRef.get();

    if (!driverDoc.exists) {
      return res.status(404).send("Driver profile not found.");
    }

    const currentActive = !!driverDoc.data().isActive;
    const newActive = !currentActive;
    const serverNow = admin.firestore.FieldValue.serverTimestamp();

    await driverRef.update({
      isActive: newActive,
      activeStatusUpdatedAt: serverNow,
      activeStatusUpdatedBy: adminUid,
      updatedAt: serverNow,
    });

    console.log(`✅ Admin ${adminUid} changed active status of driver ${driverId} to ${newActive}`);
    res.redirect(`/admin/drivers/${driverId}?msg=` + encodeURIComponent(`Driver status changed to ${newActive ? "Active" : "Paused"}.`));
  } catch (err) {
    console.error("❌ Admin toggle driver active error:", err.message);
    res.redirect(`/admin/drivers/${driverId}?err=` + encodeURIComponent("Failed to update driver active status."));
  }
});

app.get("/admin/trips", requireAdmin, async (req, res) => {
  try {
    const tripsSnap = await db.collection("bookings").get();
    let trips = [];

    tripsSnap.forEach((doc) => {
      trips.push({ id: doc.id, ...doc.data() });
    });

    const statusFilter = (req.query.status || "all").trim();
    if (statusFilter && statusFilter !== "all") {
      trips = trips.filter((t) => (t.status || "").toLowerCase() === statusFilter.toLowerCase());
    }

    // Sort by bookedAt desc
    trips.sort((a, b) => {
      const tA = a.bookedAt?.toDate ? a.bookedAt.toDate().getTime() : new Date(a.bookedAt || 0).getTime();
      const tB = b.bookedAt?.toDate ? b.bookedAt.toDate().getTime() : new Date(b.bookedAt || 0).getTime();
      return tB - tA;
    });

    res.render("admin-trips", {
      trips,
      currentFilter: statusFilter,
      successMessage: req.query.msg || null,
      errorMessage: req.query.err || null,
      user: req.session.user,
    });
  } catch (err) {
    console.error("❌ Admin trips monitor error:", err.message);
    res.status(500).send("Unable to load platform trips.");
  }
});

app.get("/admin/users", requireAdmin, async (req, res) => {
  try {
    const usersSnap = await db.collection("users").get();
    let usersList = [];

    usersSnap.forEach((doc) => {
      usersList.push({ id: doc.id, ...doc.data() });
    });

    const roleFilter = (req.query.role || "all").trim().toLowerCase();
    if (roleFilter && roleFilter !== "all") {
      usersList = usersList.filter((u) => (u.role || "").toLowerCase() === roleFilter);
    }

    // Sort by createdAt desc
    usersList.sort((a, b) => {
      const tA = a.createdAt?.toDate ? a.createdAt.toDate().getTime() : new Date(a.createdAt || 0).getTime();
      const tB = b.createdAt?.toDate ? b.createdAt.toDate().getTime() : new Date(b.createdAt || 0).getTime();
      return tB - tA;
    });

    res.render("admin-users", {
      usersList,
      currentFilter: roleFilter,
      successMessage: req.query.msg || null,
      errorMessage: req.query.err || null,
      user: req.session.user,
    });
  } catch (err) {
    console.error("❌ Admin users directory error:", err.message);
    res.status(500).send("Unable to load user accounts.");
  }
});

// ==========================================
// IN-APP NOTIFICATIONS ROUTES
// ==========================================

app.get("/notifications", requireAuth, async (req, res) => {
  const userUid = req.session.user.uid;
  const wantsJson = !!(req.headers.accept && req.headers.accept.includes("application/json"));

  try {
    const snap = await db
      .collection("notifications")
      .where("userId", "==", userUid)
      .get();

    const notifications = [];
    let unreadCount = 0;

    snap.forEach((doc) => {
      const data = doc.data();
      if (!data.isRead) unreadCount++;
      notifications.push({
        id: doc.id,
        ...data,
      });
    });

    // In-memory sort by createdAt desc (avoids compound index requirement)
    notifications.sort((a, b) => {
      const tA = a.createdAt?.toDate ? a.createdAt.toDate().getTime() : new Date(a.createdAt || 0).getTime();
      const tB = b.createdAt?.toDate ? b.createdAt.toDate().getTime() : new Date(b.createdAt || 0).getTime();
      return tB - tA;
    });

    // Format timestamps for display
    notifications.forEach((n) => {
      n.createdAtFormatted = n.createdAt?.toDate
        ? n.createdAt.toDate().toLocaleString()
        : (n.createdAt ? new Date(n.createdAt).toLocaleString() : "Recently");
    });

    if (wantsJson) {
      return res.status(200).json({ notifications, unreadCount });
    }

    res.render("notifications", {
      notifications,
      unreadCount,
      successMessage: req.query.msg || null,
      errorMessage: req.query.err || null,
      user: req.session.user,
    });
  } catch (err) {
    console.error("❌ Notifications load error:", err.message);
    if (wantsJson) {
      return res.status(500).json({ error: "LOAD_FAILED", message: "Failed to load notifications." });
    }
    res.status(500).send("Unable to load notifications.");
  }
});

app.post("/notifications/:id/read", requireAuth, actionLimiter, async (req, res) => {
  const notifId = sanitizeString(req.params.id, 128);
  const userUid = req.session.user.uid;
  const wantsJson = !!(req.headers.accept && req.headers.accept.includes("application/json"));

  try {
    const notifRef = db.collection("notifications").doc(notifId);
    const notifDoc = await notifRef.get();

    if (!notifDoc.exists) {
      if (wantsJson) return res.status(404).json({ error: "NOT_FOUND", message: "Notification not found." });
      return res.status(404).send("Notification not found.");
    }

    const notifData = notifDoc.data();

    // Security: Only the recipient can mark as read
    if (notifData.userId !== userUid) {
      if (wantsJson) return res.status(403).json({ error: "FORBIDDEN", message: "Unauthorized." });
      return res.status(403).send("Unauthorized.");
    }

    await notifRef.update({
      isRead: true,
      readAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (wantsJson) {
      return res.status(200).json({ success: true, notificationId: notifId });
    }

    res.redirect("/notifications");
  } catch (err) {
    console.error("❌ Notification mark read error:", err.message);
    if (wantsJson) {
      return res.status(500).json({ error: "UPDATE_FAILED", message: "Failed to mark notification as read." });
    }
    res.redirect("/notifications");
  }
});

app.post("/notifications/mark-all-read", requireAuth, actionLimiter, async (req, res) => {
  // SECURITY: Exclusively derive userId from session. Never accept from req.body or query!
  const userUid = req.session.user.uid;
  const wantsJson = !!(req.headers.accept && req.headers.accept.includes("application/json"));

  try {
    const unreadSnap = await db
      .collection("notifications")
      .where("userId", "==", userUid)
      .where("isRead", "==", false)
      .get();

    if (!unreadSnap.empty) {
      const batch = db.batch();
      const serverNow = admin.firestore.FieldValue.serverTimestamp();
      unreadSnap.forEach((doc) => {
        batch.update(doc.ref, {
          isRead: true,
          readAt: serverNow,
        });
      });
      await batch.commit();
    }

    if (wantsJson) {
      return res.status(200).json({ success: true, count: unreadSnap.size });
    }

    res.redirect("/notifications?msg=" + encodeURIComponent("All notifications marked as read."));
  } catch (err) {
    console.error("❌ Mark all read error:", err.message);
    if (wantsJson) {
      return res.status(500).json({ error: "UPDATE_FAILED", message: "Failed to mark all as read." });
    }
    res.redirect("/notifications?err=" + encodeURIComponent("Failed to mark all as read."));
  }
});

// ==========================================
// CENTRALIZED ERROR HANDLER
// ==========================================

app.use((err, req, res, next) => {
  if (err.code === "EBADCSRFTOKEN") {
    console.warn(`⚠️ CSRF token validation failed: [${req.method}] ${req.originalUrl} from ${req.ip}`);
    if (req.headers.accept && req.headers.accept.includes("application/json")) {
      return res.status(403).json({
        error: "EBADCSRFTOKEN",
        message: "Invalid or missing CSRF token. Please refresh the page and try again.",
      });
    }
    return res.status(403).send("Forbidden: Invalid or expired CSRF token. Please reload the page and try again.");
  }

  console.error("❌ Unhandled server error:", err);
  if (res.headersSent) {
    return next(err);
  }
  if (req.headers.accept && req.headers.accept.includes("application/json")) {
    return res.status(500).json({ error: "INTERNAL_ERROR", message: "An unexpected server error occurred." });
  }
  res.status(500).send("Something went wrong on our end. Please try again later.");
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
