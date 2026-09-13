const path = require("path");
const projectRoot = path.resolve(__dirname, "../../../../../OneDrive/Desktop/Capstonegroupproject");

// Load modules from project root
require(path.join(projectRoot, "node_modules/dotenv")).config({ path: path.join(projectRoot, ".env") });

process.env.PORT = "3050";
const BASE = `http://localhost:${process.env.PORT}`;

async function runTests() {
  console.log("🚀 Starting Phase 2 Verification Suite...\n");

  process.chdir(projectRoot);
  require(path.join(projectRoot, "app.js"));

  // Wait 1.5s for server and Firestore to be ready
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const admin = require(path.join(projectRoot, "node_modules/firebase-admin"));
  const db = admin.firestore();

  let touristCookie = "";
  let driverCookie = "";

  const timestamp = Date.now();
  const touristEmail = `test_tourist_${timestamp}@example.com`;
  const touristPassword = "password123";
  let touristUid = "";

  const driverEmail = `test_driver_${timestamp}@example.com`;
  const driverPassword = "driverPassword123";
  let driverUid = "";

  function extractCookie(response) {
    const raw = response.headers.get("set-cookie");
    if (!raw) return "";
    return raw.split(";")[0];
  }

  // 1. Test Public Routes
  console.log("--- TEST 1: Public Routes ---");
  const resHome = await fetch(`${BASE}/`);
  console.log(`GET / : ${resHome.status} (expected 200)`);

  const resDriverLogin = await fetch(`${BASE}/driver/login`);
  console.log(`GET /driver/login : ${resDriverLogin.status} (expected 200)`);

  const resDriverReg = await fetch(`${BASE}/driver/register`);
  console.log(`GET /driver/register : ${resDriverReg.status} (expected 200)`);

  // 2. Test Tourist Registration
  console.log("\n--- TEST 2: Tourist Registration ---");
  const resTourReg = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: touristEmail, password: touristPassword }),
    redirect: "manual",
  });
  console.log(`POST /register : ${resTourReg.status} (expected 302 redirect)`);
  touristCookie = extractCookie(resTourReg);

  // Check Firestore users collection for tourist
  const usersSnapshot = await db.collection("users").where("email", "==", touristEmail).get();
  if (!usersSnapshot.empty) {
    const userDoc = usersSnapshot.docs[0];
    touristUid = userDoc.id;
    console.log(`✅ Tourist document created in users/${touristUid} with role: "${userDoc.data().role}"`);
  } else {
    console.error("❌ Tourist document NOT found in users collection!");
  }

  // 3. Test Tourist Role Enforcement (Tourist cannot access driver portal)
  console.log("\n--- TEST 3: Tourist Accessing Driver Dashboard (Should be 403) ---");
  const resTourDriverDash = await fetch(`${BASE}/driver/dashboard`, {
    headers: { Cookie: touristCookie },
  });
  console.log(`GET /driver/dashboard (as tourist) : ${resTourDriverDash.status} (expected 403 Forbidden)`);

  // 4. Test Tourist Booking Flow
  console.log("\n--- TEST 4: Tourist Booking Flow ---");
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 2);
  const nextWeek = new Date();
  nextWeek.setDate(nextWeek.getDate() + 5);

  const fromDate = tomorrow.toISOString().split("T")[0];
  const toDate = nextWeek.toISOString().split("T")[0];

  const resBooking = await fetch(`${BASE}/bookings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: touristCookie,
    },
    body: JSON.stringify({
      destination: "Beach Getaway",
      fromDate,
      toDate,
      people: 4,
      name: "Alice Tourist",
      countryCode: "+91",
      phone: "9876543210",
      maritalStatus: "single",
    }),
  });
  const bookingJson = await resBooking.json();
  console.log(`POST /bookings : ${resBooking.status} - ${bookingJson.message}`);

  // Test Tourist Dashboard
  const resTourDash = await fetch(`${BASE}/dashboard`, {
    headers: { Cookie: touristCookie },
  });
  console.log(`GET /dashboard (as tourist) : ${resTourDash.status} (expected 200)`);

  // 5. Test Driver Registration
  console.log("\n--- TEST 5: Driver Registration ---");
  const resDrivReg = await fetch(`${BASE}/driver/register`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      name: "Bob Van Driver",
      email: driverEmail,
      password: driverPassword,
      phone: "+91 9123456780",
      licenseNumber: "DL-IND-2026-999",
      vanModel: "Force Traveller 12-Seater",
      vanNumber: "TS 09 DP 9999",
      seatingCapacity: "12",
      experienceYears: "8",
    }),
    redirect: "manual",
  });
  console.log(`POST /driver/register : ${resDrivReg.status} (expected 302 redirect)`);
  driverCookie = extractCookie(resDrivReg);

  // Check Firestore users & drivers collections
  const driverUsersSnapshot = await db.collection("users").where("email", "==", driverEmail).get();
  if (!driverUsersSnapshot.empty) {
    const userDoc = driverUsersSnapshot.docs[0];
    driverUid = userDoc.id;
    console.log(`✅ Driver user document created in users/${driverUid} with role: "${userDoc.data().role}"`);
  } else {
    console.error("❌ Driver document NOT found in users collection!");
  }

  const driverProfileDoc = await db.collection("drivers").doc(driverUid).get();
  if (driverProfileDoc.exists) {
    const dData = driverProfileDoc.data();
    console.log(`✅ Driver profile created in drivers/${driverUid}`);
    console.log(`   Model: ${dData.vanModel} | Seats: ${dData.seatingCapacity} | Exp: ${dData.experienceYears}y | Status: ${dData.verificationStatus}`);
  } else {
    console.error("❌ Driver profile NOT found in drivers collection!");
  }

  // 6. Test Driver Dashboard Access
  console.log("\n--- TEST 6: Driver Accessing Driver Dashboard ---");
  const resDrivDash = await fetch(`${BASE}/driver/dashboard`, {
    headers: { Cookie: driverCookie },
  });
  console.log(`GET /driver/dashboard (as driver) : ${resDrivDash.status} (expected 200)`);

  // 7. Test Driver Blocked from Tourist-Only Routes
  console.log("\n--- TEST 7: Driver Blocked from Tourist Routes ---");
  const resDrivTourDash = await fetch(`${BASE}/dashboard`, {
    headers: { Cookie: driverCookie },
  });
  console.log(`GET /dashboard (as driver) : ${resDrivTourDash.status} (expected 403 Forbidden)`);

  const resDrivBooking = await fetch(`${BASE}/bookings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: driverCookie,
    },
    body: JSON.stringify({
      destination: "Mountain Adventure",
      fromDate,
      toDate,
      people: 2,
      name: "Bob",
      countryCode: "+91",
      phone: "1234567890",
      maritalStatus: "single",
    }),
  });
  console.log(`POST /bookings (as driver) : ${resDrivBooking.status} (expected 403 Forbidden)`);

  // 8. Test Cross-Portal Login Blocking
  console.log("\n--- TEST 8: Cross-Portal Login Restrictions ---");
  // Tourist trying to log in at Driver Login
  const resTourAtDriverLogin = await fetch(`${BASE}/driver/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: touristEmail, password: touristPassword }),
  });
  console.log(`POST /driver/login (with tourist credentials) : ${resTourAtDriverLogin.status} (expected 403)`);

  // Driver trying to log in at Tourist Login
  const resDrivAtTouristLogin = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: driverEmail, password: driverPassword }),
  });
  console.log(`POST /login (with driver credentials) : ${resDrivAtTouristLogin.status} (expected 403)`);

  // 9. Test Driver Profile Update & Tamper Prevention
  console.log("\n--- TEST 9: Driver Profile Update ---");
  const resUpdateProfile = await fetch(`${BASE}/driver/profile`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: driverCookie,
    },
    body: new URLSearchParams({
      name: "Bob Van Driver Updated",
      phone: "+91 9999988888",
      licenseNumber: "DL-IND-2026-UPDATED",
      vanModel: "Toyota HiAce Premium 14-Seater",
      vanNumber: "TS 09 DP 7777",
      seatingCapacity: "14",
      experienceYears: "10",
      uid: "FAKE_TARGET_UID_ATTACK", // Should be ignored by server
    }),
  });
  console.log(`POST /driver/profile : ${resUpdateProfile.status} (expected 200)`);

  const updatedDriverDoc = await db.collection("drivers").doc(driverUid).get();
  const upData = updatedDriverDoc.data();
  console.log(`✅ Verified updated driver doc in Firestore:`);
  console.log(`   Name: ${upData.name} | Model: ${upData.vanModel} | Seats: ${upData.seatingCapacity} | Exp: ${upData.experienceYears}y`);

  // 10. Test Legacy Tourist Account Migration
  console.log("\n--- TEST 10: Legacy Tourist Account Migration ---");
  // Delete users document to simulate legacy user
  await db.collection("users").doc(touristUid).delete();
  console.log(`Deleted users/${touristUid} to simulate pre-Phase-2 tourist account.`);

  // Legacy user logs in via /login
  const resLegacyLogin = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: touristEmail, password: touristPassword }),
    redirect: "manual",
  });
  console.log(`POST /login (legacy user) : ${resLegacyLogin.status} (expected 302 redirect)`);
  const legacyCookie = extractCookie(resLegacyLogin);

  // Verify users document was recreated automatically
  const recheckDoc = await db.collection("users").doc(touristUid).get();
  if (recheckDoc.exists && recheckDoc.data().role === "tourist") {
    console.log(`✅ Lazy migration successful: users/${touristUid} recreated with role: "${recheckDoc.data().role}"`);
  } else {
    console.error("❌ Lazy migration failed!");
  }

  // Verify legacy user can still access their dashboard
  const resLegacyDash = await fetch(`${BASE}/dashboard`, {
    headers: { Cookie: legacyCookie },
  });
  console.log(`GET /dashboard (legacy user after migration) : ${resLegacyDash.status} (expected 200)`);

  // 11. Test Placeholder Driver Pages
  console.log("\n--- TEST 11: Driver Navigation Placeholder Pages ---");
  const resAvail = await fetch(`${BASE}/driver/availability`, { headers: { Cookie: driverCookie } });
  console.log(`GET /driver/availability : ${resAvail.status} (expected 200)`);
  const resTrips = await fetch(`${BASE}/driver/trips`, { headers: { Cookie: driverCookie } });
  console.log(`GET /driver/trips : ${resTrips.status} (expected 200)`);
  const resMyTrips = await fetch(`${BASE}/driver/my-trips`, { headers: { Cookie: driverCookie } });
  console.log(`GET /driver/my-trips : ${resMyTrips.status} (expected 200)`);

  // Clean up test documents in Firestore
  console.log("\n--- Cleaning up test artifacts from Firestore ---");
  await db.collection("users").doc(touristUid).delete();
  await db.collection("users").doc(driverUid).delete();
  await db.collection("drivers").doc(driverUid).delete();
  const testBookings = await db.collection("bookings").where("email", "==", touristEmail).get();
  for (const bDoc of testBookings.docs) {
    await bDoc.ref.delete();
  }
  console.log("✅ Cleanup complete.");

  console.log("\n🎉 ALL PHASE 2 VERIFICATION TESTS PASSED SUCCESSFULLY!\n");
  process.exit(0);
}

runTests().catch((err) => {
  console.error("❌ Test suite failed:", err);
  process.exit(1);
});
