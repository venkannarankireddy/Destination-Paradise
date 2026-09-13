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

// Make user available in all views
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

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

// ==========================================
// PUBLIC & TOURIST ROUTES
// ==========================================

app.get("/", (req, res) => {
  res.render("index");
});

app.get("/register", (req, res) => {
  res.render("register");
});

app.post("/register", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password || password.length < 6) {
    return res.status(400).send("Registration failed: Email and a password with at least 6 characters are required.");
  }

  try {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password, returnSecureToken: true }),
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

    req.session.user = { uid, email: data.email, role: "tourist" };
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
        body: JSON.stringify({ email: email.trim(), password, returnSecureToken: true }),
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
      req.session.user = { uid, email: data.email, role: "tourist" };
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
      req.session.user = { uid, email: data.email, role: "tourist" };
    }

    res.redirect("/");
  } catch (err) {
    res.status(400).send("Login failed: " + (err.message || "An error occurred"));
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login");
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
    // Check for conflicting active bookings (Requested or Confirmed)
    const existingBookings = await db
      .collection("bookings")
      .where("email", "==", email)
      .where("destination", "==", destination)
      .get();

    let conflict = false;

    existingBookings.forEach((doc) => {
      const data = doc.data();
      if (data.status === "Cancelled") return; // Cancelled does not conflict

      const existingFrom = new Date(data.fromDate);
      const existingTo = new Date(data.toDate);

      // Check if date ranges overlap
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
      destination: destination.trim(),
      fromDate,
      toDate,
      people,
      name: name.trim(),
      email, // strictly from session
      countryCode: countryCode.trim(),
      phone: phone.trim(),
      maritalStatus: maritalStatus.trim(),
      status: "Requested", // Core Phase 4 business model: Requested
      driverId: null,
      bookedAt: now,
      updatedAt: now,
    };

    await bookingRef.set(booking);
    console.log("✅ Trip request saved with ID:", bookingRef.id);
    return res.status(200).json({ message: "Trip request submitted! Available van drivers will review your trip." });
  } catch (error) {
    console.error("❌ Firestore error:", error.message);
    return res.status(500).json({ message: "Failed to save booking." });
  }
});

app.post("/cancel-booking/:id", requireTourist, async (req, res) => {
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

// ==========================================
// DRIVER ROUTES
// ==========================================

app.get("/driver/register", (req, res) => {
  res.render("driver-register");
});

app.post("/driver/register", async (req, res) => {
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

  // Validation
  if (!name?.trim()) return res.status(400).send("Full name is required.");
  if (!email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).send("A valid email address is required.");
  }
  if (!password || password.length < 6) {
    return res.status(400).send("Password must be at least 6 characters long.");
  }
  if (!phone?.trim()) return res.status(400).send("Phone number is required.");
  if (!licenseNumber?.trim()) return res.status(400).send("Driver license number is required.");
  if (!vanModel?.trim()) return res.status(400).send("Van model is required.");
  if (!vanNumber?.trim()) return res.status(400).send("Vehicle plate/registration number is required.");

  const capacity = parseInt(seatingCapacity, 10);
  if (isNaN(capacity) || capacity < 4 || capacity > 20) {
    return res.status(400).send("Passenger capacity must be an integer between 4 and 20.");
  }

  const experience = parseInt(experienceYears, 10);
  if (isNaN(experience) || experience < 0) {
    return res.status(400).send("Driving experience must be a non-negative number.");
  }

  try {
    // Create Firebase Auth user
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password, returnSecureToken: true }),
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
      name: name.trim(),
      email: data.email,
      phone: phone.trim(),
      licenseNumber: licenseNumber.trim(),
      vanModel: vanModel.trim(),
      vanNumber: vanNumber.trim(),
      seatingCapacity: capacity,
      experienceYears: experience,
      verificationStatus: "pending",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });

    req.session.user = { uid, email: data.email, role: "driver", name: name.trim() };
    res.redirect("/driver/dashboard");
  } catch (err) {
    res.status(400).send("Driver registration failed: " + (err.message || "An error occurred"));
  }
});

app.get("/driver/login", (req, res) => {
  res.render("driver-login");
});

app.post("/driver/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password, returnSecureToken: true }),
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

    req.session.user = {
      uid,
      email: data.email,
      role: "driver",
      name: driverData.name || data.email,
    };

    res.redirect("/driver/dashboard");
  } catch (err) {
    res.status(400).send("Driver login failed: " + (err.message || "An error occurred"));
  }
});

// ==========================================
// DATE & AVAILABILITY HELPERS
// ==========================================

const getTodayDateString = () => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
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

// Driver matching logic for Phase 4 Marketplace:
// 1. Trip status == "Requested"
// 2. Driver isActive == true
// 3. Driver van seatingCapacity >= trip.people
// 4. Driver has an availability period with period.status == "available" AND
//    trip.fromDate >= period.fromDate AND trip.toDate <= period.toDate
const isTripMatchForDriver = (trip, driver, driverAvailability) => {
  if (trip.status !== "Requested") return false;
  if (!driver.isActive) return false;
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

    res.render("driver-dashboard", {
      driver: driverDoc.data(),
      availabilities: upcomingAvailabilities,
      totalAvailabilities: availabilities.length,
      matchingTripsCount,
      user: req.session.user,
    });
  } catch (err) {
    console.error("❌ Driver dashboard error:", err.message);
    res.status(500).send("Unable to load driver dashboard.");
  }
});

app.post("/driver/toggle-active", requireDriver, async (req, res) => {
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

app.post("/driver/profile", requireDriver, async (req, res) => {
  const {
    name,
    phone,
    licenseNumber,
    vanModel,
    vanNumber,
    seatingCapacity,
    experienceYears,
  } = req.body;

  if (!name?.trim()) return res.status(400).send("Full name is required.");
  if (!phone?.trim()) return res.status(400).send("Phone number is required.");
  if (!licenseNumber?.trim()) return res.status(400).send("Driver license number is required.");
  if (!vanModel?.trim()) return res.status(400).send("Van model is required.");
  if (!vanNumber?.trim()) return res.status(400).send("Vehicle registration number is required.");

  const capacity = parseInt(seatingCapacity, 10);
  if (isNaN(capacity) || capacity < 4 || capacity > 20) {
    return res.status(400).send("Passenger capacity must be an integer between 4 and 20.");
  }

  const experience = parseInt(experienceYears, 10);
  if (isNaN(experience) || experience < 0) {
    return res.status(400).send("Driving experience must be a non-negative number.");
  }

  try {
    const driverRef = db.collection("drivers").doc(req.session.user.uid);
    const updatedData = {
      name: name.trim(),
      phone: phone.trim(),
      licenseNumber: licenseNumber.trim(),
      vanModel: vanModel.trim(),
      vanNumber: vanNumber.trim(),
      seatingCapacity: capacity,
      experienceYears: experience,
      updatedAt: new Date(),
    };

    await driverRef.update(updatedData);

    req.session.user.name = name.trim();

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

app.post("/driver/availability", requireDriver, async (req, res) => {
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

app.post("/driver/availability/:id/update", requireDriver, async (req, res) => {
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

app.post("/driver/availability/:id/delete", requireDriver, async (req, res) => {
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

app.post("/driver/availability/:id/toggle", requireDriver, async (req, res) => {
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
      user: req.session.user,
    });
  } catch (err) {
    console.error("❌ Driver trips marketplace error:", err.message);
    res.status(500).send("Unable to load trip requests marketplace.");
  }
});

app.get("/driver/my-trips", requireDriver, (req, res) => {
  res.render("driver-placeholder", {
    title: "My Accepted Trips",
    phase: "Phase 4: Trip Management",
    icon: "🗓️",
    description: "View and manage your upcoming and completed accepted tourist trips. This module will be activated in Phase 4.",
    activeTab: "my-trips",
    user: req.session.user,
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
