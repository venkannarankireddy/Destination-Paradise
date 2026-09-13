const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const path = require("path");
const projectRoot = path.resolve(__dirname, "..");

require(path.join(projectRoot, "node_modules/dotenv")).config({ path: path.join(projectRoot, ".env") });

process.env.PORT = "3085";
const BASE = `http://localhost:${process.env.PORT}`;

async function runTests() {
  console.log("================================================================================");
  console.log("🚀 STARTING PHASE 5 REGRESSION TEST SUITE (WITH CSRF PROTECTION)");
  console.log("================================================================================\n");

  process.chdir(projectRoot);
  require(path.join(projectRoot, "app.js"));

  // Wait 1.5s for server and Firestore to initialize
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const admin = require(path.join(projectRoot, "node_modules/firebase-admin"));
  const db = admin.firestore();

  // Global cookie storage by role/user
  class Client {
    constructor() {
      this.cookies = {};
    }

    updateCookies(res) {
      const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      if (setCookies.length === 0) {
        const raw = res.headers.get("set-cookie");
        if (raw) setCookies.push(raw);
      }
      for (const s of setCookies) {
        const pair = s.split(";")[0];
        const [k, v] = pair.split("=");
        if (k && v) this.cookies[k.trim()] = v.trim();
      }
    }

    getCookieHeader() {
      return Object.entries(this.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    }

    async getCsrfToken() {
      const res = await fetch(`${BASE}/csrf-token`, {
        headers: { Cookie: this.getCookieHeader() },
      });
      this.updateCookies(res);
      const data = await res.json();
      return data.csrfToken;
    }

    async fetch(url, options = {}) {
      const method = (options.method || "GET").toUpperCase();
      const headers = { Cookie: this.getCookieHeader(), ...(options.headers || {}) };

      if (["POST", "PUT", "DELETE", "PATCH"].includes(method)) {
        const token = await this.getCsrfToken();
        headers.Cookie = this.getCookieHeader();
        headers["X-CSRF-Token"] = token;
      }

      const res = await fetch(url, { ...options, headers, redirect: "manual" });
      this.updateCookies(res);
      return res;
    }
  }

  const timestamp = Date.now();
  const touristClient = new Client();
  const touristEmail = `tourist_p5reg_${timestamp}@example.com`;
  let touristUid = "";

  const driver1Client = new Client();
  const driver1Email = `driver1_p5reg_${timestamp}@example.com`;
  let driver1Uid = "";

  const driver2Client = new Client();
  const driver2Email = `driver2_p5reg_${timestamp}@example.com`;
  let driver2Uid = "";

  const driverCap10Client = new Client();
  const driverCapacity10Email = `driver_cap10_p5reg_${timestamp}@example.com`;
  let driverCap10Uid = "";

  const createdTripIds = [];
  const createdUserUids = [];

  let passedTests = 0;
  let failedTests = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ ${message}`);
      passedTests++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failedTests++;
    }
  }

  // --- SETUP: Register Tourist, Driver 1, Driver 2, and Driver with 10 seats ---
  console.log("--- SETUP: Registering Entities in Firebase ---");

  // 1. Tourist
  const resTour = await touristClient.fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: touristEmail, password: "password123" }),
  });
  assert(resTour.status === 302, "Tourist registered successfully");
  const snapTour = await db.collection("users").where("email", "==", touristEmail).get();
  touristUid = snapTour.docs[0].id;
  createdUserUids.push(touristUid);

  // 2. Driver 1: Toyota HiAce, 12 seats
  const resDrv1 = await driver1Client.fetch(`${BASE}/driver/register`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      name: "Ramesh Driver One",
      email: driver1Email,
      password: "driverPassword123",
      phone: "+91 9111111111",
      licenseNumber: "DL-P5-DRV1",
      vanModel: "Toyota HiAce (12 Seats)",
      vanNumber: "TS 01 AB 1111",
      seatingCapacity: "12",
      experienceYears: "5",
    }),
  });
  assert(resDrv1.status === 302, "Driver 1 registered successfully");
  const snapDrv1 = await db.collection("users").where("email", "==", driver1Email).get();
  driver1Uid = snapDrv1.docs[0].id;
  createdUserUids.push(driver1Uid);
  await db.collection("drivers").doc(driver1Uid).update({ verificationStatus: "verified" });

  // 3. Driver 2: Force Traveller, 14 seats
  const resDrv2 = await driver2Client.fetch(`${BASE}/driver/register`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      name: "Suresh Driver Two",
      email: driver2Email,
      password: "driverPassword123",
      phone: "+91 9222222222",
      licenseNumber: "DL-P5-DRV2",
      vanModel: "Force Traveller (14 Seats)",
      vanNumber: "TS 02 CD 2222",
      seatingCapacity: "14",
      experienceYears: "7",
    }),
  });
  assert(resDrv2.status === 302, "Driver 2 registered successfully");
  const snapDrv2 = await db.collection("users").where("email", "==", driver2Email).get();
  driver2Uid = snapDrv2.docs[0].id;
  createdUserUids.push(driver2Uid);
  await db.collection("drivers").doc(driver2Uid).update({ verificationStatus: "verified" });

  // Helper to create a trip document directly in Firestore
  async function createTripDoc(opts) {
    const ref = db.collection("bookings").doc();
    const docData = {
      bookingId: ref.id,
      touristId: opts.touristId || touristUid,
      email: opts.email || touristEmail,
      name: opts.name || "Test Tourist",
      countryCode: opts.countryCode || "+91",
      phone: opts.phone || "9876543210",
      destination: opts.destination || "Goa Beach",
      fromDate: opts.fromDate || "2027-01-10",
      toDate: opts.toDate || "2027-01-15",
      people: opts.people || 4,
      maritalStatus: "single",
      status: opts.status || "Requested",
      driverId: opts.driverId || null,
      driverName: opts.driverName || null,
      driverPhone: opts.driverPhone || null,
      driverEmail: opts.driverEmail || null,
      vanModel: opts.vanModel || null,
      vanNumber: opts.vanNumber || null,
      seatingCapacity: opts.seatingCapacity || null,
      bookedAt: new Date(),
      updatedAt: new Date(),
    };
    await ref.set(docData);
    createdTripIds.push(ref.id);
    return { id: ref.id, ...docData };
  }

  // ==========================================
  // TEST SECTION 1: AUTHENTICATION CHECK
  // ==========================================
  console.log("\n==========================================");
  console.log("TEST 1: AUTHENTICATION & ROLE RESTRICTIONS");
  console.log("==========================================");

  const anonClient = new Client();
  const resAnon = await anonClient.fetch(`${BASE}/driver/trips/fake-id/accept`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  assert(resAnon.status === 302 && resAnon.headers.get("location")?.includes("/driver/login"), "Unauthenticated request is redirected to /driver/login");

  const resTouristAccept = await touristClient.fetch(`${BASE}/driver/trips/fake-id/accept`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  assert(resTouristAccept.status === 403, "Tourist role attempting to accept trip returns 403 Forbidden");

  // ==========================================
  // TEST SECTION 2: TRIP MUST EXIST
  // ==========================================
  console.log("\n==========================================");
  console.log("TEST 2: NON-EXISTENT TRIP HANDLING");
  console.log("==========================================");

  const resNotFound = await driver1Client.fetch(`${BASE}/driver/trips/nonexistent-doc-id/accept`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  const jsonNotFound = await resNotFound.json();
  assert(resNotFound.status === 404 && jsonNotFound.error === "TRIP_NOT_FOUND", "Non-existent trip returns 404 TRIP_NOT_FOUND");

  // ==========================================
  // TEST SECTION 3: TRIP STATUS VALIDATION
  // ==========================================
  console.log("\n==========================================");
  console.log("TEST 3: TRIP STATUS MUST BE EXACTLY 'Requested'");
  console.log("==========================================");

  const tripAccepted = await createTripDoc({ status: "Accepted", driverId: "other-driver-uid" });
  const resAccepted = await driver1Client.fetch(`${BASE}/driver/trips/${tripAccepted.id}/accept`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  const jsonAccepted = await resAccepted.json();
  assert(resAccepted.status === 400 && jsonAccepted.error === "TRIP_ALREADY_ACCEPTED", "Already Accepted trip returns 400 TRIP_ALREADY_ACCEPTED");

  const tripCancelled = await createTripDoc({ status: "Cancelled" });
  const resCancelled = await driver1Client.fetch(`${BASE}/driver/trips/${tripCancelled.id}/accept`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  const jsonCancelled = await resCancelled.json();
  assert(resCancelled.status === 400 && jsonCancelled.error === "TRIP_ALREADY_ACCEPTED", "Cancelled trip returns 400 TRIP_ALREADY_ACCEPTED");

  // ==========================================
  // TEST SECTION 4: DRIVER ACTIVE STATUS
  // ==========================================
  console.log("\n==========================================");
  console.log("TEST 4: DRIVER ACTIVE STATUS VALIDATION");
  console.log("==========================================");

  await db.collection("drivers").doc(driver1Uid).update({ isActive: false });
  const tripForInactive = await createTripDoc({ status: "Requested" });
  const resInactive = await driver1Client.fetch(`${BASE}/driver/trips/${tripForInactive.id}/accept`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  const jsonInactive = await resInactive.json();
  assert(resInactive.status === 400 && jsonInactive.error === "DRIVER_INACTIVE", "Inactive driver cannot accept trips (DRIVER_INACTIVE)");

  await db.collection("drivers").doc(driver1Uid).update({ isActive: true });
  console.log("Reactivated Driver 1.");

  // ==========================================
  // TEST SECTION 5: SEATING CAPACITY
  // ==========================================
  console.log("\n==========================================");
  console.log("TEST 5: SEATING CAPACITY VALIDATION");
  console.log("==========================================");

  const resDrv10 = await driverCap10Client.fetch(`${BASE}/driver/register`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      name: "Chandra 10 Seater",
      email: driverCapacity10Email,
      password: "driverPassword123",
      phone: "+91 9333333333",
      licenseNumber: "DL-P5-10CAP",
      vanModel: "Tempo Traveller (10 Seats)",
      vanNumber: "TS 03 EF 3333",
      seatingCapacity: "10",
      experienceYears: "4",
    }),
  });
  assert(resDrv10.status === 302, "10-seat driver registered");
  const snapDrv10 = await db.collection("users").where("email", "==", driverCapacity10Email).get();
  driverCap10Uid = snapDrv10.docs[0].id;
  createdUserUids.push(driverCap10Uid);
  await db.collection("drivers").doc(driverCap10Uid).update({ verificationStatus: "verified" });

  await db.collection("drivers").doc(driverCap10Uid).collection("availability").add({
    fromDate: "2027-01-01",
    toDate: "2027-01-31",
    status: "available",
  });

  const trip12Passengers = await createTripDoc({
    fromDate: "2027-01-10",
    toDate: "2027-01-15",
    people: 12,
  });

  const resOverCapacity = await driverCap10Client.fetch(`${BASE}/driver/trips/${trip12Passengers.id}/accept`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  const jsonOverCapacity = await resOverCapacity.json();
  assert(resOverCapacity.status === 400 && jsonOverCapacity.error === "INSUFFICIENT_CAPACITY", "Trip with 12 passengers rejected by 10-seater (INSUFFICIENT_CAPACITY)");

  // ==========================================
  // TEST SECTION 6: AVAILABILITY COVERAGE
  // ==========================================
  console.log("\n==========================================");
  console.log("TEST 6: AVAILABILITY WINDOW COVERAGE");
  console.log("==========================================");

  const tripNoAvail = await createTripDoc({
    fromDate: "2027-03-01",
    toDate: "2027-03-05",
    people: 4,
  });
  const resNoAvail = await driver1Client.fetch(`${BASE}/driver/trips/${tripNoAvail.id}/accept`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  const jsonNoAvail = await resNoAvail.json();
  assert(resNoAvail.status === 400 && jsonNoAvail.error === "AVAILABILITY_CHANGED", "Driver with no availability window cannot accept trip (AVAILABILITY_CHANGED)");

  await db.collection("drivers").doc(driver1Uid).collection("availability").add({
    fromDate: "2027-04-10",
    toDate: "2027-04-20",
    status: "unavailable",
  });
  const tripUnavailablePeriod = await createTripDoc({
    fromDate: "2027-04-12",
    toDate: "2027-04-15",
    people: 4,
  });
  const resUnavail = await driver1Client.fetch(`${BASE}/driver/trips/${tripUnavailablePeriod.id}/accept`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  const jsonUnavail = await resUnavail.json();
  assert(resUnavail.status === 400 && jsonUnavail.error === "AVAILABILITY_CHANGED", "Driver with 'unavailable' window cannot accept trip (AVAILABILITY_CHANGED)");

  // Set broad availability for Driver 1 & Driver 2: 2027-01-01 to 2027-01-31
  await db.collection("drivers").doc(driver1Uid).collection("availability").add({
    fromDate: "2027-01-01",
    toDate: "2027-01-31",
    status: "available",
  });
  await db.collection("drivers").doc(driver2Uid).collection("availability").add({
    fromDate: "2027-01-01",
    toDate: "2027-01-31",
    status: "available",
  });
  console.log("Set broad availability (Jan 1 - Jan 31, 2027) for Driver 1 and Driver 2.");

  // ==========================================
  // TEST SECTION 7: SUCCESSFUL TRIP ACCEPTANCE
  // ==========================================
  console.log("\n==========================================");
  console.log("TEST 7: SUCCESSFUL ATOMIC TRIP ACCEPTANCE");
  console.log("==========================================");

  const tripValid = await createTripDoc({
    destination: "Munnar Tea Estate Tour",
    fromDate: "2027-01-10",
    toDate: "2027-01-15",
    people: 6,
  });

  const resValidAccept = await driver1Client.fetch(`${BASE}/driver/trips/${tripValid.id}/accept`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  const jsonValidAccept = await resValidAccept.json();
  assert(resValidAccept.status === 200 && jsonValidAccept.success, "Valid trip accepted successfully with 200 OK");

  // Verify Firestore document fields
  const acceptedDoc = await db.collection("bookings").doc(tripValid.id).get();
  const acceptedData = acceptedDoc.data();
  assert(acceptedData.status === "Accepted", "Trip status in Firestore changed to 'Accepted'");
  assert(acceptedData.driverId === driver1Uid, "Trip driverId set to Driver 1 UID");
  assert(acceptedData.driverName === "Ramesh Driver One", "Driver name stored correctly on trip");
  assert(acceptedData.driverPhone === "+91 9111111111", "Driver phone stored correctly on trip");
  assert(acceptedData.driverEmail === driver1Email, "Driver email stored correctly on trip");
  assert(acceptedData.vanModel === "Toyota HiAce (12 Seats)", "Van model stored correctly on trip");
  assert(acceptedData.vanNumber === "TS 01 AB 1111", "Van number stored correctly on trip");
  assert(acceptedData.seatingCapacity === 12, "Seating capacity stored correctly on trip");
  assert(!!acceptedData.acceptedAt, "acceptedAt timestamp exists on trip");

  // ==========================================
  // TEST SECTION 8: PREVENT DOUBLE ACCEPTANCE
  // ==========================================
  console.log("\n==========================================");
  console.log("TEST 8: SECOND DRIVER ACCEPTANCE CONFLICT");
  console.log("==========================================");

  const resSecondDriver = await driver2Client.fetch(`${BASE}/driver/trips/${tripValid.id}/accept`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  const jsonSecondDriver = await resSecondDriver.json();
  assert(resSecondDriver.status === 400 && jsonSecondDriver.error === "TRIP_ALREADY_ACCEPTED", "Second driver attempting to accept already accepted trip receives 400 TRIP_ALREADY_ACCEPTED");

  // ==========================================
  // TEST SECTION 9: OVERLAPPING ACCEPTED TRIPS
  // ==========================================
  console.log("\n==========================================");
  console.log("TEST 9: DRIVER OVERLAPPING ACCEPTED TRIP CONFLICT");
  console.log("==========================================");

  const tripOverlap = await createTripDoc({
    destination: "Wayanad Wild Retreat",
    fromDate: "2027-01-12",
    toDate: "2027-01-17",
    people: 4,
  });

  const resDriver1Overlap = await driver1Client.fetch(`${BASE}/driver/trips/${tripOverlap.id}/accept`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  const jsonDriver1Overlap = await resDriver1Overlap.json();
  assert(resDriver1Overlap.status === 400 && jsonDriver1Overlap.error === "OVERLAPPING_TRIP", "Driver 1 blocked from accepting overlapping trip (OVERLAPPING_TRIP)");

  // Driver 2 (who has NO accepted trips) CAN accept it
  const resDriver2AcceptOverlap = await driver2Client.fetch(`${BASE}/driver/trips/${tripOverlap.id}/accept`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  const jsonDriver2AcceptOverlap = await resDriver2AcceptOverlap.json();
  assert(resDriver2AcceptOverlap.status === 200 && jsonDriver2AcceptOverlap.success, "Driver 2 successfully accepts trip that Driver 1 was blocked from");

  // ==========================================
  // TEST SECTION 10: BACKWARD COMPATIBILITY
  // ==========================================
  console.log("\n==========================================");
  console.log("TEST 10: LEGACY BOOKINGS COMPATIBILITY");
  console.log("==========================================");

  const legacyConfirmed = await createTripDoc({
    destination: "Heritage Hampi Tour",
    fromDate: "2027-02-01",
    toDate: "2027-02-05",
    people: 2,
    status: "Confirmed",
  });

  const legacyCancelled = await createTripDoc({
    destination: "Goa Weekend Express",
    fromDate: "2027-02-10",
    toDate: "2027-02-12",
    people: 2,
    status: "Cancelled",
  });

  const resLegacyDash = await touristClient.fetch(`${BASE}/dashboard`);
  const htmlLegacyDash = await resLegacyDash.text();

  assert(htmlLegacyDash.includes("Heritage Hampi Tour") && htmlLegacyDash.includes("✅ Confirmed"), "Legacy Confirmed booking renders correctly on tourist dashboard");
  assert(htmlLegacyDash.includes("Goa Weekend Express") && htmlLegacyDash.includes("❌ Cancelled"), "Legacy Cancelled booking renders correctly on tourist dashboard");
  assert(htmlLegacyDash.includes("Package Booking"), "Legacy booking shows 'Package Booking' for driver info");

  // ==========================================
  // CLEANUP
  // ==========================================
  console.log("\n--- Cleaning up test Firestore documents ---");
  for (const tid of createdTripIds) {
    try { await db.collection("bookings").doc(tid).delete(); } catch(e) {}
  }
  for (const uid of createdUserUids) {
    try {
      await db.collection("users").doc(uid).delete();
      const avs = await db.collection("drivers").doc(uid).collection("availability").get();
      for (const d of avs.docs) await d.ref.delete();
      await db.collection("drivers").doc(uid).delete();
    } catch(e) {}
  }
  console.log(`Cleaned up ${createdTripIds.length} test bookings and ${createdUserUids.length} test user profiles.`);

  console.log("\n================================================================================");
  console.log(`🏁 REGRESSION SUMMARY: ${passedTests} PASSED, ${failedTests} FAILED (Total: ${passedTests + failedTests})`);
  console.log("================================================================================");

  if (failedTests === 0) {
    console.log("🎉 ALL REGRESSION TESTS PASSED WITH ZERO REGRESSIONS!");
    process.exit(0);
  } else {
    console.error("❌ SOME REGRESSION TESTS FAILED!");
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("FATAL ERROR in test suite:", err);
  process.exit(1);
});
