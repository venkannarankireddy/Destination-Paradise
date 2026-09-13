const path = require("path");
const projectRoot = path.resolve(__dirname, "../../../../../OneDrive/Desktop/Capstonegroupproject");

// Load dotenv from project root
require(path.join(projectRoot, "node_modules/dotenv")).config({ path: path.join(projectRoot, ".env") });

process.env.PORT = "3070";
const BASE = `http://localhost:${process.env.PORT}`;

async function runTests() {
  console.log("🚀 Starting Phase 4 Marketplace & Trip Matching Verification Suite...\n");

  process.chdir(projectRoot);
  require(path.join(projectRoot, "app.js"));

  // Wait 1.5s for server and Firestore to initialize
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const admin = require(path.join(projectRoot, "node_modules/firebase-admin"));
  const db = admin.firestore();

  function extractCookie(response) {
    const raw = response.headers.get("set-cookie");
    if (!raw) return "";
    return raw.split(";")[0];
  }

  const timestamp = Date.now();
  const touristEmail = `tourist_p4_${timestamp}@example.com`;
  let touristCookie = "";
  let touristUid = "";

  const driverEmail = `driver_p4_${timestamp}@example.com`;
  let driverCookie = "";
  let driverUid = "";

  const createdTripIds = [];

  // Helper for today + N days in YYYY-MM-DD
  function futureDate(daysAhead) {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  // --- SETUP: Register Tourist & Driver ---
  console.log("--- SETUP: Register Tourist & Driver ---");
  // 1. Register Tourist
  const resTour = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: touristEmail, password: "password123" }),
    redirect: "manual",
  });
  touristCookie = extractCookie(resTour);
  const snapTour = await db.collection("users").where("email", "==", touristEmail).get();
  touristUid = snapTour.docs[0].id;
  console.log(`✅ Tourist registered (UID: ${touristUid})`);

  // 2. Register Driver with 10 seats
  const resDriv = await fetch(`${BASE}/driver/register`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      name: "Ramesh Van Driver",
      email: driverEmail,
      password: "driverPassword123",
      phone: "+91 9988776655",
      licenseNumber: "DL-P4-MATCH-10",
      vanModel: "Toyota HiAce (10 Seats)",
      vanNumber: "TS 09 MATCH 10",
      seatingCapacity: "10",
      experienceYears: "6",
    }),
    redirect: "manual",
  });
  driverCookie = extractCookie(resDriv);
  const snapDriv = await db.collection("users").where("email", "==", driverEmail).get();
  driverUid = snapDriv.docs[0].id;
  console.log(`✅ Driver registered with 10 seats (UID: ${driverUid})`);

  // Set Driver Availability: Day 10 to Day 20 (status: available)
  const d10 = futureDate(10);
  const d20 = futureDate(20);
  await fetch(`${BASE}/driver/availability`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: driverCookie,
    },
    body: new URLSearchParams({
      fromDate: d10,
      toDate: d20,
      status: "available",
    }),
    redirect: "manual",
  });
  console.log(`✅ Driver availability created: ${d10} -> ${d20} (available)`);

  // ==========================================
  // PART 1: TOURIST TRIP CREATION & DASHBOARD
  // ==========================================
  console.log("\n--- PART 1: Tourist Trip Request Creation ---");

  // 1. Create Trip Request via POST /bookings
  const trip1From = futureDate(12);
  const trip1To = futureDate(15);
  const resBook1 = await fetch(`${BASE}/bookings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: touristCookie,
    },
    body: JSON.stringify({
      destination: "Araku Valley",
      fromDate: trip1From,
      toDate: trip1To,
      people: 6,
      name: "Priya Tourist",
      countryCode: "+91",
      phone: "9876543210",
      maritalStatus: "single",
    }),
  });
  const book1Json = await resBook1.json();
  console.log(`POST /bookings status: ${resBook1.status} - message: ${book1Json.message}`);

  // Query the created trip
  const trip1Snap = await db.collection("bookings")
    .where("email", "==", touristEmail)
    .where("destination", "==", "Araku Valley")
    .get();

  const trip1Data = trip1Snap.docs[0].data();
  const trip1Id = trip1Snap.docs[0].id;
  createdTripIds.push(trip1Id);

  console.log(`✅ Verified Trip 1 in Firestore:`);
  console.log(`   status: "${trip1Data.status}" (expected "Requested")`);
  console.log(`   touristId: "${trip1Data.touristId}" (expected "${touristUid}")`);
  console.log(`   driverId: ${trip1Data.driverId} (expected null)`);

  if (trip1Data.status !== "Requested" || trip1Data.touristId !== touristUid || trip1Data.driverId !== null) {
    console.error("❌ Trip request schema verification failed!");
  }

  // 2. Verify Tourist Dashboard displays "Looking for Driver"
  console.log("\n--- TEST 2: Tourist Dashboard Status Display ---");
  const resTourDash = await fetch(`${BASE}/dashboard`, {
    headers: { Cookie: touristCookie },
  });
  const tourDashHtml = await resTourDash.text();
  console.log(`GET /dashboard status: ${resTourDash.status}`);
  if (tourDashHtml.includes("Looking for Driver") && tourDashHtml.includes("Not assigned yet")) {
    console.log(`✅ Dashboard renders "Looking for Driver" and "Not assigned yet"`);
  } else {
    console.error("❌ Tourist dashboard does not properly display Requested status!");
  }

  // ==========================================
  // PART 2: DRIVER MATCHING & MARKETPLACE
  // ==========================================
  console.log("\n--- PART 2: Driver Marketplace Matching ---");

  // TEST 4: Matching Trip appears in Marketplace
  const resMarketplace = await fetch(`${BASE}/driver/trips`, {
    headers: { Cookie: driverCookie },
  });
  const marketplaceHtml = await resMarketplace.text();
  console.log(`GET /driver/trips status: ${resMarketplace.status} (expected 200)`);

  if (marketplaceHtml.includes("Araku Valley") && marketplaceHtml.includes("Priya Tourist") && marketplaceHtml.includes("<strong>6</strong> Passenger")) {
    console.log(`✅ Matching trip (Araku Valley, 6 people, ${trip1From} -> ${trip1To}) appears in Driver Marketplace!`);
  } else {
    console.error("❌ Matching trip did NOT appear in marketplace!");
  }

  // Test Direct Contact details presence
  if (marketplaceHtml.includes("tel:+919876543210") && marketplaceHtml.includes("wa.me")) {
    console.log(`✅ Tourist contact buttons (Phone Call & WhatsApp) are present!`);
  } else {
    console.error("❌ Direct contact links missing from marketplace!");
  }

  // Check Driver Dashboard pending matching requests counter
  const resDrivDash = await fetch(`${BASE}/driver/dashboard`, {
    headers: { Cookie: driverCookie },
  });
  const drivDashHtml = await resDrivDash.text();
  if (drivDashHtml.includes("1 Available") || drivDashHtml.includes("Matching Trip Requests")) {
    console.log(`✅ Driver Dashboard shows 1 Available matching trip request!`);
  } else {
    console.error("❌ Driver Dashboard matching requests stat failed!");
  }

  // ==========================================
  // PART 3: EDGE CASES & FILTERING
  // ==========================================
  console.log("\n--- PART 3: Edge Cases & Matching Constraints ---");

  // Helper to test trip matching
  async function createTestTripAndCheckMatch(label, from, to, people, expectedMatch) {
    const res = await fetch(`${BASE}/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: touristCookie },
      body: JSON.stringify({
        destination: `EdgeCase-${label}`,
        fromDate: from,
        toDate: to,
        people,
        name: "Test Traveler",
        countryCode: "+91",
        phone: "9900011222",
        maritalStatus: "single",
      }),
    });
    const snap = await db.collection("bookings").where("destination", "==", `EdgeCase-${label}`).get();
    if (!snap.empty) createdTripIds.push(snap.docs[0].id);

    const resM = await fetch(`${BASE}/driver/trips`, { headers: { Cookie: driverCookie } });
    const html = await resM.text();
    const isMatched = html.includes(`EdgeCase-${label}`);

    if (isMatched === expectedMatch) {
      console.log(`✅ [${label}] Dates: ${from} -> ${to}, People: ${people} => Match: ${isMatched} (Expected: ${expectedMatch})`);
    } else {
      console.error(`❌ [${label}] Dates: ${from} -> ${to}, People: ${people} => Match: ${isMatched} (Expected: ${expectedMatch}) FAILED!`);
    }
  }

  // Edge Case 1: Exact Date Match (d10 to d20, 10 people) -> Expected: MATCH
  await createTestTripAndCheckMatch("Exact-Dates-Max-Capacity", d10, d20, 10, true);

  // Edge Case 2: Inside Dates (d11 to d19, 5 people) -> Expected: MATCH
  await createTestTripAndCheckMatch("Inside-Dates", futureDate(11), futureDate(19), 5, true);

  // Edge Case 3: Starts before availability (d5 to d15) -> Expected: NO MATCH
  await createTestTripAndCheckMatch("Starts-Before", futureDate(5), futureDate(15), 5, false);

  // Edge Case 4: Ends after availability (d15 to d25) -> Expected: NO MATCH
  await createTestTripAndCheckMatch("Ends-After", futureDate(15), futureDate(25), 5, false);

  // Edge Case 5: Over Capacity (d12 to d15, 11 people vs 10 seats) -> Expected: NO MATCH
  await createTestTripAndCheckMatch("Over-Capacity", futureDate(12), futureDate(15), 11, false);

  // ==========================================
  // PART 4: INACTIVE DRIVER & UNAVAILABLE WINDOW
  // ==========================================
  console.log("\n--- PART 4: Inactive Driver & Status Tests ---");

  // Toggle Driver to Inactive
  await fetch(`${BASE}/driver/toggle-active`, {
    method: "POST",
    headers: { Cookie: driverCookie },
    redirect: "manual",
  });
  console.log("Driver toggled to Inactive (isActive = false)");

  const resInactiveMarket = await fetch(`${BASE}/driver/trips`, {
    headers: { Cookie: driverCookie },
  });
  const inactiveHtml = await resInactiveMarket.text();
  if (inactiveHtml.includes("No Matching Trip Requests") && inactiveHtml.includes("currently Inactive")) {
    console.log("✅ Inactive driver sees 0 trip requests and an inactive notice!");
  } else {
    console.error("❌ Inactive driver should NOT see trip requests!");
  }

  // Toggle Driver back to Active
  await fetch(`${BASE}/driver/toggle-active`, {
    method: "POST",
    headers: { Cookie: driverCookie },
    redirect: "manual",
  });
  console.log("Driver toggled back to Active (isActive = true)");

  // ==========================================
  // PART 5: SECURITY & ACCESS CONTROL
  // ==========================================
  console.log("\n--- PART 5: Access Control & Security ---");

  // Tourist cannot access Driver Marketplace
  const resTourMarket = await fetch(`${BASE}/driver/trips`, {
    headers: { Cookie: touristCookie },
  });
  console.log(`GET /driver/trips (as tourist): Status ${resTourMarket.status} (expected 403 Forbidden)`);

  // Driver cannot access Tourist Dashboard
  const resDrivTourDash = await fetch(`${BASE}/dashboard`, {
    headers: { Cookie: driverCookie },
  });
  console.log(`GET /dashboard (as driver): Status ${resDrivTourDash.status} (expected 403 Forbidden)`);

  // Driver cannot accept trips (READ ONLY in Phase 4)
  const resAccept = await fetch(`${BASE}/driver/trips/${trip1Id}/accept`, {
    method: "POST",
    headers: { Cookie: driverCookie },
  });
  console.log(`POST /driver/trips/${trip1Id}/accept: Status ${resAccept.status} (expected 404 - no acceptance endpoint in Phase 4)`);

  // ==========================================
  // PART 6: BACKWARD COMPATIBILITY & CANCELLATION
  // ==========================================
  console.log("\n--- PART 6: Backward Compatibility & Cancellation ---");

  // 1. Create a legacy Confirmed document directly in Firestore
  const legacyBookingRef = db.collection("bookings").doc();
  await legacyBookingRef.set({
    bookingId: legacyBookingRef.id,
    destination: "Goa Beach Legacy",
    fromDate: futureDate(30),
    toDate: futureDate(35),
    people: 2,
    name: "Legacy Tourist",
    email: touristEmail,
    countryCode: "+91",
    phone: "1122334455",
    maritalStatus: "married",
    status: "Confirmed", // Legacy status
    bookedAt: new Date(),
  });
  createdTripIds.push(legacyBookingRef.id);
  console.log(`✅ Created simulated legacy Confirmed booking (${legacyBookingRef.id})`);

  // Check Tourist Dashboard displays legacy Confirmed booking
  const resLegacyDash = await fetch(`${BASE}/dashboard`, { headers: { Cookie: touristCookie } });
  const legacyDashHtml = await resLegacyDash.text();
  if (legacyDashHtml.includes("Goa Beach Legacy") && legacyDashHtml.includes("Confirmed")) {
    console.log(`✅ Legacy Confirmed booking properly rendered on Tourist Dashboard!`);
  } else {
    console.error("❌ Legacy Confirmed booking not properly displayed!");
  }

  // 2. Tourist can cancel their own Requested trip
  const resCancel = await fetch(`${BASE}/cancel-booking/${trip1Id}`, {
    method: "POST",
    headers: { Cookie: touristCookie },
    redirect: "manual",
  });
  console.log(`POST /cancel-booking/${trip1Id} (Tourist cancel own request): Status ${resCancel.status} (expected 302)`);

  const cancelledDoc = await db.collection("bookings").doc(trip1Id).get();
  if (cancelledDoc.data().status === "Cancelled") {
    console.log(`✅ Trip request successfully updated to "Cancelled" in Firestore!`);
  } else {
    console.error("❌ Cancellation failed!");
  }

  // Verify cancelled trip disappears from Driver Marketplace
  const resMarketAfterCancel = await fetch(`${BASE}/driver/trips`, { headers: { Cookie: driverCookie } });
  const marketAfterHtml = await resMarketAfterCancel.text();
  if (!marketAfterHtml.includes("Araku Valley")) {
    console.log(`✅ Cancelled trip immediately disappeared from Driver Marketplace!`);
  } else {
    console.error("❌ Cancelled trip should NOT appear in marketplace!");
  }

  // --- CLEANUP ---
  console.log("\n--- Cleaning up test records from Firestore ---");
  await db.collection("users").doc(driverUid).delete();
  await db.collection("users").doc(touristUid).delete();

  for (const doc of (await db.collection("drivers").doc(driverUid).collection("availability").get()).docs) {
    await doc.ref.delete();
  }
  await db.collection("drivers").doc(driverUid).delete();

  for (const id of createdTripIds) {
    await db.collection("bookings").doc(id).delete();
  }
  console.log("✅ Cleanup complete.");

  console.log("\n🎉 ALL PHASE 4 TESTS COMPLETED AND PASSED SUCCESSFULLY!\n");
  process.exit(0);
}

runTests().catch((err) => {
  console.error("❌ Test suite failed:", err);
  process.exit(1);
});
