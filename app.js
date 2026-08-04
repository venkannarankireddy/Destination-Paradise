const express = require("express");
const admin = require("firebase-admin");
const bodyParser = require("body-parser");
const session = require("express-session");
const path = require("path");
let fetch;
(async () => {
  fetch = (await import("node-fetch")).default;
})();

const serviceAccount = require("./key.json");
require("dotenv").config(); // For API key

const app = express();

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// Session setup
app.use(
  session({
    secret: "secret-key", // Change this to a secure secret in production
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
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=AIzaSyB_fkGbun1XPlOAWTAbr8K0xkFt9a6HLAA`,
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
    res.send("Registration failed: " + err.message);
  }
});


app.get("/login", (req, res) => {
  res.render("login");
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=AIzaSyB_fkGbun1XPlOAWTAbr8K0xkFt9a6HLAA`,
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
    res.send("Login failed: " + err.message);
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
      console.log("Firestore Document ID:", doc.id);

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

    status: data.status || "Confirmed",   // NEW

    bookedAt: data.bookedAt
      ? data.bookedAt.toDate().toLocaleString()
      : "N/A",
});
    });

    console.log(bookings);

    res.render("dashboard", {
      bookings,
      user: req.session.user,
    });

  } catch (err) {
    console.error(err);
    res.send(err.message);
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
    message:
      "You already have a confirmed booking for this destination during the selected dates.",
  });
}

  const booking = {
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

  try {
    const ref = await db.collection("bookings").add(booking);

await ref.update({
    bookingId: ref.id
});
    console.log("✅ Booking saved with ID:", ref.id);
    return res.status(200).json({ message: "Booking successful!" });
  } catch (error) {
    console.error("❌ Firestore error:", error);
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
      return res.send("Booking not found.");
    }

    // Only allow the owner to cancel
    if (booking.data().email !== req.session.user.email) {
      return res.status(403).send("Unauthorized.");
    }

    await bookingRef.update({
    status: "Cancelled"
});

    res.redirect("/dashboard");

  } catch (err) {
    console.error(err);
    res.status(500).send("Unable to cancel booking.");
  }
});
// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
