const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const path = require("path");
const projectRoot = path.resolve(__dirname, "../../../../../OneDrive/Desktop/Capstonegroupproject");

require(path.join(projectRoot, "node_modules/dotenv")).config({ path: path.join(projectRoot, ".env") });

process.env.PORT = "3080";
const BASE = `http://localhost:${process.env.PORT}`;

async function runTests() {
  console.log("================================================================================");
  console.log("🚀 STARTING PHASE 5 TRANSACTIONAL ACCEPTANCE & VERIFICATION SUITE");
  console.log("================================================================================\n");

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
  const touristEmail = `tourist_p5_${timestamp}@example.com`;
  let touristCookie = "";
  let touristUid = "";

  const driver1Email = `driver1_p5_${timestamp}@example.com`;
  let driver1Cookie = "";
  let driver1Uid = "";

  const driver2Email = `driver2_p5_${timestamp}@example.com`;
  let driver2Cookie = "";
  let driver2Uid = "";

  const driverCapacity10Email = `driver_cap10_${timestamp}@example.com`;
  let driverCap10Cookie = "";
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
  const resTour = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: touristEmail, password: "password123" }),
    redirect: "manual",
  });
  touristCookie = extractCookie(resTour);
  const snapTour = await db.collection("users").where("email", "==", touristEmail).get();
  touristUid = snapTour.docs[0].id;
  createdUserUids.push(touristUid);
  console.log(`Tourist registered: ${touristEmail} (UID: ${touristUid})`);

  // 2. Driver 1: Toyota HiAce, 12 seats, DL-P5-DRV1, Plate TS 01 AB 1111
  const resDrv1 = await fetch(`${BASE}/driver/register`, {
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
    redirect: "manual",
  });
  if (resDrv1.status !== 302) {
    const errBody = await resDrv1.text();
    console.error(`❌ Driver 1 registration failed with status ${resDrv1.status}:`, errBody);
  }
  driver1Cookie = extractCookie(resDrv1);
  const snapDrv1 = await db.collection("users").where("email", "==", driver1Email).get();
  driver1Uid = snapDrv1.docs[0].id;
  createdUserUids.push(driver1Uid);
  console.log(`Driver 1 registered: ${driver1Email} (UID: ${driver1Uid})`);

  // 3. Driver 2: Force Traveller, 14 seats, DL-P5-DRV2, Plate TS 02 CD 2222
  const resDrv2 = await fetch(`${BASE}/driver/register`, {
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
    redirect: "manual",
  });
  if (resDrv2.status !== 302) {
    const errBody = await resDrv2.text();
    console.error(`❌ Driver 2 registration failed with status ${resDrv2.status}:`, errBody);
  }
  driver2Cookie = extractCookie(resDrv2);
  const snapDrv2 = await db.collection("users").where("email", "==", driver2Email).get();
  driver2Uid = snapDrv2.docs[0].id;
  createdUserUids.push(driver2Uid);
  console.log(`Driver 2 registered: ${driver2Email} (UID: ${driver2Uid})`);

  // Helper to create a trip document directly in Firestore
  async function createTripDoc(opts) {
    const ref = db.collection("bookings").doc();
    const docData = {
      bookingId: ref.id,
      touristId: opts.touristId || touristUid,
      email: opts.email || touristEmail,
      destination: opts.destination || "Araku Valley",
      fromDate: opts.fromDate,
      toDate: opts.toDate,
      people: opts.people || 4,
      name: opts.name || "Test Tourist",
      countryCode: "+91",
      phone: "9876543210",
      maritalStatus: "single",
      status: opts.status || "Requested",
      driverId: opts.driverId || null,
      driverName: opts.driverName || null,
      driverPhone: opts.driverPhone || null,
      vanModel: opts.vanModel || null,
      vanNumber: opts.vanNumber || null,
      seatingCapacity: opts.seatingCapacity || null,
      bookedAt: new Date(),
      updatedAt: new Date(),
    };
    if (opts.acceptedAt) docData.acceptedAt = opts.acceptedAt;
    await ref.set(docData);
    createdTripIds.push(ref.id);
    return { id: ref.id, ...docData };
  }

  // Helper to add availability directly
  async function addAvailability(driverUid, fromDate, toDate, status = "available") {
    const ref = db.collection("drivers").doc(driverUid).collection("availability").doc();
    await ref.set({
      availabilityId: ref.id,
      driverId: driverUid,
      fromDate,
      toDate,
      status,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return ref.id;
  }

  // ==========================================
  // TEST SECTION 16: CONCURRENCY PROTECTION
  // ==========================================
  console.log("\n==========================================");
  console.log("TEST 16: CONCURRENCY - TWO DRIVERS ACCEPTING SAME TRIP");
  console.log("==========================================");

  // Set availability for both drivers covering 2026-11-01 to 2026-11-10
  await addAvailability(driver1Uid, "2026-11-01", "2026-11-10", "available");
  await addAvailability(driver2Uid, "2026-11-01", "2026-11-10", "available");

  // Create a single Requested trip for 2026-11-03 to 2026-11-07, 6 passengers
  const concTrip = await createTripDoc({
    destination: "Goa Beach Trip",
    fromDate: "2026-11-03",
    toDate: "2026-11-07",
    people: 6,
    status: "Requested",
  });
  console.log(`Created concurrency test trip: ${concTrip.id}`);

  // Both drivers fire POST /driver/trips/:id/accept simultaneously
  const [resAccept1, resAccept2] = await Promise.all([
    fetch(`${BASE}/driver/trips/${concTrip.id}/accept`, {
      method: "POST",
      headers: { Cookie: driver1Cookie, Accept: "application/json" },
    }),
    fetch(`${BASE}/driver/trips/${concTrip.id}/accept`, {
      method: "POST",
      headers: { Cookie: driver2Cookie, Accept: "application/json" },
    }),
  ]);

  const json1 = await resAccept1.json();
  const json2 = await resAccept2.json();

  console.log(`Driver 1 response status: ${resAccept1.status}`, json1);
  console.log(`Driver 2 response status: ${resAccept2.status}`, json2);

  const oneSucceeded = (resAccept1.status === 200 && json1.success) || (resAccept2.status === 200 && json2.success);
  const oneFailed = (resAccept1.status === 400 && json1.error === "TRIP_ALREADY_ACCEPTED") ||
                    (resAccept2.status === 400 && json2.error === "TRIP_ALREADY_ACCEPTED");

  assert(oneSucceeded && oneFailed, "Exactly ONE driver successfully accepted, the second was cleanly rejected with TRIP_ALREADY_ACCEPTED");

  // Verify trip in Firestore
  const concTripDoc = await db.collection("bookings").doc(concTrip.id).get();
  const concTripData = concTripDoc.data();

  assert(concTripData.status === "Accepted", "Trip status in Firestore is 'Accepted'");
  assert(concTripData.driverId === driver1Uid || concTripData.driverId === driver2Uid, `Single driver assigned: ${concTripData.driverName}`);
  assert(!!concTripData.acceptedAt, "Trip has server-side acceptedAt timestamp");

  // ==========================================
  // TEST SECTION 17: OVERLAP PREVENTION
  // ==========================================
  console.log("\n==========================================");
  console.log("TEST 17: STRICT DRIVER OVERLAP PREVENTION");
  console.log("==========================================");

  // Setup Driver 1 with wide availability: 2026-10-01 to 2026-10-31
  await addAvailability(driver1Uid, "2026-10-01", "2026-10-31", "available");

  // Create an already Accepted trip for Driver 1: 2026-10-10 to 2026-10-15
  const baseTrip = await createTripDoc({
    destination: "Existing Base Trip",
    fromDate: "2026-10-10",
    toDate: "2026-10-15",
    people: 4,
    status: "Accepted",
    driverId: driver1Uid,
    driverName: "Ramesh Driver One",
    acceptedAt: new Date(),
  });
  console.log(`Base accepted trip for Driver 1: 2026-10-10 to 2026-10-15 (ID: ${baseTrip.id})`);

  // Case 1: 2026-10-12 to 2026-10-18 (Overlaps end) -> REJECT
  const tripOver1 = await createTripDoc({ fromDate: "2026-10-12", toDate: "2026-10-18", people: 4 });
  const resOver1 = await fetch(`${BASE}/driver/trips/${tripOver1.id}/accept`, {
    method: "POST",
    headers: { Cookie: driver1Cookie, Accept: "application/json" },
  });
  const jsonOver1 = await resOver1.json();
  assert(resOver1.status === 400 && jsonOver1.error === "OVERLAPPING_TRIP", "2026-10-12 to 2026-10-18: REJECTED with OVERLAPPING_TRIP");

  // Case 2: 2026-10-05 to 2026-10-12 (Overlaps start) -> REJECT
  const tripOver2 = await createTripDoc({ fromDate: "2026-10-05", toDate: "2026-10-12", people: 4 });
  const resOver2 = await fetch(`${BASE}/driver/trips/${tripOver2.id}/accept`, {
    method: "POST",
    headers: { Cookie: driver1Cookie, Accept: "application/json" },
  });
  const jsonOver2 = await resOver2.json();
  assert(resOver2.status === 400 && jsonOver2.error === "OVERLAPPING_TRIP", "2026-10-05 to 2026-10-12: REJECTED with OVERLAPPING_TRIP");

  // Case 3: 2026-10-10 to 2026-10-15 (Exact same dates) -> REJECT
  const tripOver3 = await createTripDoc({ fromDate: "2026-10-10", toDate: "2026-10-15", people: 4 });
  const resOver3 = await fetch(`${BASE}/driver/trips/${tripOver3.id}/accept`, {
    method: "POST",
    headers: { Cookie: driver1Cookie, Accept: "application/json" },
  });
  const jsonOver3 = await resOver3.json();
  assert(resOver3.status === 400 && jsonOver3.error === "OVERLAPPING_TRIP", "2026-10-10 to 2026-10-15: REJECTED with OVERLAPPING_TRIP");

  // Case 4: 2026-10-16 to 2026-10-20 (Adjacent after) -> ACCEPT
  const tripAdjAfter = await createTripDoc({ fromDate: "2026-10-16", toDate: "2026-10-20", people: 4 });
  const resAdjAfter = await fetch(`${BASE}/driver/trips/${tripAdjAfter.id}/accept`, {
    method: "POST",
    headers: { Cookie: driver1Cookie, Accept: "application/json" },
  });
  const jsonAdjAfter = await resAdjAfter.json();
  assert(resAdjAfter.status === 200 && jsonAdjAfter.success, "2026-10-16 to 2026-10-20 (Adjacent after): ACCEPTED successfully");

  // Case 5: 2026-10-01 to 2026-10-09 (Adjacent before) -> ACCEPT
  const tripAdjBefore = await createTripDoc({ fromDate: "2026-10-01", toDate: "2026-10-09", people: 4 });
  const resAdjBefore = await fetch(`${BASE}/driver/trips/${tripAdjBefore.id}/accept`, {
    method: "POST",
    headers: { Cookie: driver1Cookie, Accept: "application/json" },
  });
  const jsonAdjBefore = await resAdjBefore.json();
  assert(resAdjBefore.status === 200 && jsonAdjBefore.success, "2026-10-01 to 2026-10-09 (Adjacent before): ACCEPTED successfully");

  // ==========================================
  // TEST SECTION 18: CAPACITY CONSTRAINTS
  // ==========================================
  console.log("\n==========================================");
  console.log("TEST 18: SEATING CAPACITY CONSTRAINTS");
  console.log("==========================================");

  // Register a specific driver with capacity exactly 10
  const resDrvCap10 = await fetch(`${BASE}/driver/register`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      name: "Ten Seater Driver",
      email: driverCapacity10Email,
      password: "driverPassword123",
      phone: "+91 9333333333",
      licenseNumber: "DL-P5-CAP10",
      vanModel: "Tempo Traveller (10 Seats)",
      vanNumber: "TS 03 CAP 10",
      seatingCapacity: "10",
      experienceYears: "4",
    }),
    redirect: "manual",
  });
  driverCap10Cookie = extractCookie(resDrvCap10);
  const snapCap10 = await db.collection("users").where("email", "==", driverCapacity10Email).get();
  driverCap10Uid = snapCap10.docs[0].id;
  createdUserUids.push(driverCap10Uid);

  // Add availability: 2026-12-01 to 2026-12-20
  await addAvailability(driverCap10Uid, "2026-12-01", "2026-12-20", "available");

  // 1. Trip people = 10 (equal to capacity) -> ACCEPT
  const tripCap10 = await createTripDoc({ fromDate: "2026-12-05", toDate: "2026-12-08", people: 10 });
  const resCap10 = await fetch(`${BASE}/driver/trips/${tripCap10.id}/accept`, {
    method: "POST",
    headers: { Cookie: driverCap10Cookie, Accept: "application/json" },
  });
  const jsonCap10 = await resCap10.json();
  assert(resCap10.status === 200 && jsonCap10.success, "Trip people = 10 for Driver capacity = 10: ACCEPTED");

  // 2. Trip people = 11 (exceeds capacity) -> REJECT
  const tripCap11 = await createTripDoc({ fromDate: "2026-12-10", toDate: "2026-12-14", people: 11 });
  const resCap11 = await fetch(`${BASE}/driver/trips/${tripCap11.id}/accept`, {
    method: "POST",
    headers: { Cookie: driverCap10Cookie, Accept: "application/json" },
  });
  const jsonCap11 = await resCap11.json();
  assert(resCap11.status === 400 && jsonCap11.error === "INSUFFICIENT_CAPACITY", "Trip people = 11 for Driver capacity = 10: REJECTED with INSUFFICIENT_CAPACITY");

  // ==========================================
  // TEST SECTION 19: AVAILABILITY VALIDATION
  // ==========================================
  console.log("\n==========================================");
  console.log("TEST 19: AVAILABILITY COVERAGE & ACTIVE TOGGLE");
  console.log("==========================================");

  // Driver 2 availability: 2027-01-10 to 2027-01-20
  const availDocId = await addAvailability(driver2Uid, "2027-01-10", "2027-01-20", "available");

  // 1. Trip inside window: 2027-01-12 to 2027-01-15 -> ACCEPT
  const tripAvailOk = await createTripDoc({ fromDate: "2027-01-12", toDate: "2027-01-15", people: 5 });
  const resAvailOk = await fetch(`${BASE}/driver/trips/${tripAvailOk.id}/accept`, {
    method: "POST",
    headers: { Cookie: driver2Cookie, Accept: "application/json" },
  });
  const jsonAvailOk = await resAvailOk.json();
  assert(resAvailOk.status === 200 && jsonAvailOk.success, "Trip 2027-01-12 to 2027-01-15 (within 2027-01-10 -> 2027-01-20): ACCEPTED");

  // 2. Trip starts before: 2027-01-05 to 2027-01-15 -> REJECT
  const tripAvailBefore = await createTripDoc({ fromDate: "2027-01-05", toDate: "2027-01-15", people: 5 });
  const resAvailBefore = await fetch(`${BASE}/driver/trips/${tripAvailBefore.id}/accept`, {
    method: "POST",
    headers: { Cookie: driver2Cookie, Accept: "application/json" },
  });
  const jsonAvailBefore = await resAvailBefore.json();
  assert(resAvailBefore.status === 400 && jsonAvailBefore.error === "AVAILABILITY_CHANGED", "Trip 2027-01-05 to 2027-01-15 (starts before window): REJECTED with AVAILABILITY_CHANGED");

  // 3. Trip ends after: 2027-01-12 to 2027-01-25 -> REJECT
  const tripAvailAfter = await createTripDoc({ fromDate: "2027-01-12", toDate: "2027-01-25", people: 5 });
  const resAvailAfter = await fetch(`${BASE}/driver/trips/${tripAvailAfter.id}/accept`, {
    method: "POST",
    headers: { Cookie: driver2Cookie, Accept: "application/json" },
  });
  const jsonAvailAfter = await resAvailAfter.json();
  assert(resAvailAfter.status === 400 && jsonAvailAfter.error === "AVAILABILITY_CHANGED", "Trip 2027-01-12 to 2027-01-25 (ends after window): REJECTED with AVAILABILITY_CHANGED");

  // 4. Set availability status to "unavailable" -> REJECT
  await db.collection("drivers").doc(driver2Uid).collection("availability").doc(availDocId).update({
    status: "unavailable",
  });
  const tripAvailUnavail = await createTripDoc({ fromDate: "2027-01-16", toDate: "2027-01-19", people: 5 });
  const resAvailUnavail = await fetch(`${BASE}/driver/trips/${tripAvailUnavail.id}/accept`, {
    method: "POST",
    headers: { Cookie: driver2Cookie, Accept: "application/json" },
  });
  const jsonAvailUnavail = await resAvailUnavail.json();
  assert(resAvailUnavail.status === 400 && jsonAvailUnavail.error === "AVAILABILITY_CHANGED", "Driver availability window set to 'unavailable': REJECTED with AVAILABILITY_CHANGED");

  // Restore availability to 'available'
  await db.collection("drivers").doc(driver2Uid).collection("availability").doc(availDocId).update({
    status: "available",
  });

  // 5. Set driver isActive = false -> REJECT with DRIVER_INACTIVE
  await db.collection("drivers").doc(driver2Uid).update({ isActive: false });
  const tripInactive = await createTripDoc({ fromDate: "2027-01-16", toDate: "2027-01-19", people: 5 });
  const resInactive = await fetch(`${BASE}/driver/trips/${tripInactive.id}/accept`, {
    method: "POST",
    headers: { Cookie: driver2Cookie, Accept: "application/json" },
  });
  const jsonInactive = await resInactive.json();
  assert(resInactive.status === 400 && jsonInactive.error === "DRIVER_INACTIVE", "Driver isActive = false: REJECTED with DRIVER_INACTIVE");

  // Restore driver isActive = true
  await db.collection("drivers").doc(driver2Uid).update({ isActive: true });

  // ==========================================
  // TEST SECTION 9 & 10: MARKETPLACE DISAPPEARANCE & MY TRIPS
  // ==========================================
  console.log("\n==========================================");
  console.log("TEST 9 & 10: MARKETPLACE DISAPPEARANCE & MY TRIPS DISPLAY");
  console.log("==========================================");

  // Create a trip that Driver 2 will accept
  const marketTrip = await createTripDoc({
    destination: "Kodaikanal Pines",
    fromDate: "2027-01-16",
    toDate: "2027-01-19",
    people: 5,
    name: "Aarti Passenger",
  });

  // Check it appears in marketplace before acceptance
  const resMarketBefore = await fetch(`${BASE}/driver/trips`, {
    headers: { Cookie: driver2Cookie },
  });
  const htmlMarketBefore = await resMarketBefore.text();
  assert(htmlMarketBefore.includes("Kodaikanal Pines"), "Trip appears in marketplace before acceptance");

  // Accept the trip
  const resAcceptMarket = await fetch(`${BASE}/driver/trips/${marketTrip.id}/accept`, {
    method: "POST",
    headers: { Cookie: driver2Cookie, Accept: "application/json" },
  });
  const jsonAcceptMarket = await resAcceptMarket.json();
  assert(resAcceptMarket.status === 200 && jsonAcceptMarket.success, "Market trip accepted by Driver 2");

  // Verify trip NO LONGER appears in marketplace for Driver 2 or Driver 1
  const resMarketAfter = await fetch(`${BASE}/driver/trips`, {
    headers: { Cookie: driver2Cookie },
  });
  const htmlMarketAfter = await resMarketAfter.text();
  assert(!htmlMarketAfter.includes("Kodaikanal Pines"), "Accepted trip DISAPPEARED from marketplace");

  // Verify trip appears in Driver 2's My Trips
  const resMyTrips2 = await fetch(`${BASE}/driver/my-trips`, {
    headers: { Cookie: driver2Cookie },
  });
  const htmlMyTrips2 = await resMyTrips2.text();
  assert(htmlMyTrips2.includes("Kodaikanal Pines") && htmlMyTrips2.includes("Aarti Passenger"), "Accepted trip appears in Driver 2's My Trips page");

  // Verify trip DOES NOT appear in Driver 1's My Trips
  const resMyTrips1 = await fetch(`${BASE}/driver/my-trips`, {
    headers: { Cookie: driver1Cookie },
  });
  const htmlMyTrips1 = await resMyTrips1.text();
  assert(!htmlMyTrips1.includes("Kodaikanal Pines"), "Accepted trip does NOT appear in other drivers' My Trips");

  // ==========================================
  // TEST SECTION 8 & 13: TOURIST DASHBOARD & CANCELLATION
  // ==========================================
  console.log("\n==========================================");
  console.log("TEST 8 & 13: TOURIST DASHBOARD DISPLAY & CANCELLATION");
  console.log("==========================================");

  // Tourist views dashboard
  const resTourDash = await fetch(`${BASE}/dashboard`, {
    headers: { Cookie: touristCookie },
  });
  const htmlTourDash = await resTourDash.text();

  assert(htmlTourDash.includes("🟢 Driver Assigned"), "Tourist dashboard displays '🟢 Driver Assigned'");
  assert(htmlTourDash.includes("Suresh Driver Two"), "Tourist dashboard shows Driver Name (Suresh Driver Two)");
  assert(htmlTourDash.includes("+91 9222222222"), "Tourist dashboard shows Driver Phone (+91 9222222222)");
  assert(htmlTourDash.includes("Force Traveller"), "Tourist dashboard shows Van Model (Force Traveller)");
  assert(htmlTourDash.includes("TS 02 CD 2222"), "Tourist dashboard shows Vehicle Registration (TS 02 CD 2222)");
  assert(htmlTourDash.includes("14 seats"), "Tourist dashboard shows Seating Capacity (14 seats)");
  assert(!htmlTourDash.includes(driver2Uid), "Tourist dashboard does NOT leak driver UID or internal IDs");

  // Tourist cancels this accepted trip
  console.log(`Tourist cancelling accepted trip: ${marketTrip.id}`);
  const resCancel = await fetch(`${BASE}/cancel-booking/${marketTrip.id}`, {
    method: "POST",
    headers: { Cookie: touristCookie },
    redirect: "manual",
  });
  assert(resCancel.status === 302, "POST /cancel-booking/:id redirects to /dashboard");

  // Check Firestore: status is Cancelled, driver assignment info preserved
  const cancelledDoc = await db.collection("bookings").doc(marketTrip.id).get();
  const cancelledData = cancelledDoc.data();
  assert(cancelledData.status === "Cancelled", "Cancelled trip status in Firestore is 'Cancelled'");
  assert(cancelledData.driverId === driver2Uid, "Driver assignment ID is preserved in history");
  assert(cancelledData.driverName === "Suresh Driver Two", "Driver name is preserved in history");

  // Check Driver 2's My Trips: cancelled trip should no longer be in active/upcoming trips
  const resMyTripsAfterCancel = await fetch(`${BASE}/driver/my-trips`, {
    headers: { Cookie: driver2Cookie },
  });
  const htmlMyTripsAfterCancel = await resMyTripsAfterCancel.text();
  assert(!htmlMyTripsAfterCancel.includes("Kodaikanal Pines"), "Cancelled trip disappears from driver's active My Trips schedule");

  // Check Overlap: Driver 2 can now accept a new trip during those exact dates!
  const replacementTrip = await createTripDoc({
    destination: "Ooty Tea Gardens",
    fromDate: "2027-01-16",
    toDate: "2027-01-19",
    people: 5,
  });
  const resAcceptReplacement = await fetch(`${BASE}/driver/trips/${replacementTrip.id}/accept`, {
    method: "POST",
    headers: { Cookie: driver2Cookie, Accept: "application/json" },
  });
  const jsonAcceptReplacement = await resAcceptReplacement.json();
  assert(resAcceptReplacement.status === 200 && jsonAcceptReplacement.success, "Driver schedule was freed: new trip for same dates ACCEPTED successfully");

  // ==========================================
  // TEST SECTION 20: BACKWARD COMPATIBILITY
  // ==========================================
  console.log("\n==========================================");
  console.log("TEST 20: BACKWARD COMPATIBILITY OF LEGACY BOOKINGS");
  console.log("==========================================");

  // Create legacy "Confirmed" package booking
  const legacyConfirmed = await createTripDoc({
    destination: "Heritage Hampi Tour",
    fromDate: "2027-02-01",
    toDate: "2027-02-05",
    people: 2,
    status: "Confirmed",
  });

  // Create legacy "Cancelled" package booking
  const legacyCancelled = await createTripDoc({
    destination: "Goa Weekend Express",
    fromDate: "2027-02-10",
    toDate: "2027-02-12",
    people: 2,
    status: "Cancelled",
  });

  // Tourist views dashboard: both legacy bookings must render without crashing
  const resLegacyDash = await fetch(`${BASE}/dashboard`, {
    headers: { Cookie: touristCookie },
  });
  const htmlLegacyDash = await resLegacyDash.text();

  assert(htmlLegacyDash.includes("Heritage Hampi Tour") && htmlLegacyDash.includes("✅ Confirmed"), "Legacy Confirmed booking renders correctly on tourist dashboard");
  assert(htmlLegacyDash.includes("Goa Weekend Express") && htmlLegacyDash.includes("❌ Cancelled"), "Legacy Cancelled booking renders correctly on tourist dashboard");
  assert(htmlLegacyDash.includes("Package Booking"), "Legacy booking shows 'Package Booking' for driver info");

  // Clean up created test documents from Firestore
  console.log("\n--- Cleaning up test Firestore documents ---");
  for (const tid of createdTripIds) {
    try { await db.collection("bookings").doc(tid).delete(); } catch(e) {}
  }
  for (const uid of createdUserUids) {
    try {
      await db.collection("users").doc(uid).delete();
      // Delete availability subcollection
      const avs = await db.collection("drivers").doc(uid).collection("availability").get();
      for (const d of avs.docs) await d.ref.delete();
      await db.collection("drivers").doc(uid).delete();
    } catch(e) {}
  }
  console.log(`Cleaned up ${createdTripIds.length} test bookings and ${createdUserUids.length} test user profiles.`);

  // SUMMARY
  console.log("\n================================================================================");
  console.log(`VERIFICATION SUMMARY: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log("================================================================================");

  if (failedTests === 0) {
    console.log("🎉 ALL PHASE 5 REQUIREMENTS VERIFIED SUCCESSFULLY!");
    process.exit(0);
  } else {
    console.error("❌ SOME TESTS FAILED!");
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("FATAL ERROR in test suite:", err);
  process.exit(1);
});
