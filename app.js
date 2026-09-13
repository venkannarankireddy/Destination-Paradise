require("dotenv").config();
const express = require("express");
const admin = require("firebase-admin");
const bodyParser = require("body-parser");
const session = require("express-session");
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

// Session setup
app.use(
  session({
    secret: sessionSecret || "dev-fallback-secret-destination-paradise",
    resave: false,
    saveUninitialized: true,
  })
);

// EJS view engine setup
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// Make user available in views
app.use((req, res, next) => {
  res.locals.user = req.session.user;
  next();
});

// Routes

app.get("/", (req, res) => {
  res.render("index");
});

app.get("/register", (req, res) => {
  res.render("register");
});

app.post("/register", async (req, res) => {
  const { email, password } = req.body;

  try {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      }
    );

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    req.session.user = { email: data.email, uid: data.localId };
    res.redirect("/");
  } catch (err) {
    res.status(400).send("Registration failed: " + (err.message || "An error occurred"));
  }
});

app.get("/login", (req, res) => {
  res.render("login");
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      }
    );

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    req.session.user = { email: data.email, uid: data.localId };
    res.redirect("/");
  } catch (err) {
    res.status(400).send("Login failed: " + (err.message || "An error occurred"));
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login");
});

app.get("/dashboard", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");

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
        status: data.status || "Confirmed",
        bookedAt: data.bookedAt
          ? (typeof data.bookedAt.toDate === "function" ? data.bookedAt.toDate().toLocaleString() : new Date(data.bookedAt).toLocaleString())
          : "N/A",
      });
    });

    res.render("dashboard", {
      bookings,
      user: req.session.user,
    });
  } catch (err) {
    console.error("❌ Dashboard error:", err.message);
    res.status(500).send("Unable to load bookings.");
  }
});

app.post("/bookings", async (req, res) => {
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

  const email = req.session?.user?.email;

  // Block unauthenticated users
  if (!email) {
    return res.status(401).json({ message: "You must be logged in to book." });
  }

  // Validate date range
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const from = new Date(fromDate);
  const to = new Date(toDate);
  from.setHours(0, 0, 0, 0);
  to.setHours(0, 0, 0, 0);

  if (isNaN(from) || isNaN(to) || from <= today || to <= from) {
    return res.status(400).json({
      message: "Dates must be valid. 'From' must be after today and 'To' must be after 'From'.",
    });
  }

  if (
    !destination?.trim() ||
    !Number.isInteger(people) || people <= 0 ||
    !name?.trim() ||
    !countryCode?.trim() ||
    !phone?.trim() ||
    !maritalStatus?.trim()
  ) {
    return res.status(400).json({ message: "All fields are required and must be valid." });
  }

  try {
    // Check for conflicting bookings
    const existingBookings = await db
      .collection("bookings")
      .where("email", "==", email)
      .where("destination", "==", destination)
      .where("status", "==", "Confirmed")
      .get();

    let conflict = false;

    existingBookings.forEach((doc) => {
      const data = doc.data();
      const existingFrom = new Date(data.fromDate);
      const existingTo = new Date(data.toDate);

      // Check if date ranges overlap
      if (from <= existingTo && to >= existingFrom) {
        conflict = true;
      }
    });

    if (conflict) {
      return res.status(400).json({
        message: "You already have a confirmed booking for this destination during the selected dates.",
      });
    }

    const bookingRef = db.collection("bookings").doc();
    const booking = {
      bookingId: bookingRef.id,
      destination,
      fromDate,
      toDate,
      people,
      name,
      email, // from session
      countryCode,
      phone,
      maritalStatus,
      status: "Confirmed",
      bookedAt: new Date(),
    };

    await bookingRef.set(booking);
    console.log("✅ Booking saved with ID:", bookingRef.id);
    return res.status(200).json({ message: "Booking successful!" });
  } catch (error) {
    console.error("❌ Firestore error:", error.message);
    return res.status(500).json({ message: "Failed to save booking." });
  }
});

app.post("/cancel-booking/:id", async (req, res) => {
  if (!req.session.user) {
    return res.redirect("/login");
  }

  try {
    const bookingRef = db.collection("bookings").doc(req.params.id);
    const booking = await bookingRef.get();

    if (!booking.exists) {
      return res.status(404).send("Booking not found.");
    }

    // Only allow the owner to cancel
    if (booking.data().email !== req.session.user.email) {
      return res.status(403).send("Unauthorized.");
    }

    await bookingRef.update({
      status: "Cancelled",
    });

    res.redirect("/dashboard");
  } catch (err) {
    console.error("❌ Cancel error:", err.message);
    res.status(500).send("Unable to cancel booking.");
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
