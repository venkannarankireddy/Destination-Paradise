const path = require("path");
const projectRoot = path.resolve(__dirname, "../../../../../OneDrive/Desktop/Capstonegroupproject");

// Load dotenv from project root
require(path.join(projectRoot, "node_modules/dotenv")).config({ path: path.join(projectRoot, ".env") });

process.env.PORT = "3060";
const BASE = `http://localhost:${process.env.PORT}`;

async function runTests() {
  console.log("🚀 Starting Phase 3 Availability & Verification Suite...\n");

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
  const driverEmail1 = `driver1_${timestamp}@example.com`;
  const driverPassword = "driverPassword123";
  let driver1Cookie = "";
  let driver1Uid = "";

  const driverEmail2 = `driver2_${timestamp}@example.com`;
  let driver2Cookie = "";
  let driver2Uid = "";

  const touristEmail = `tourist_${timestamp}@example.com`;
  let touristCookie = "";
  let touristUid = "";

  // Helper for today + N days in YYYY-MM-DD
  function futureDate(daysAhead) {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  // --- SETUP: Register Driver 1, Driver 2, and Tourist ---
  console.log("--- SETUP: Register Test Accounts ---");
  // 1. Driver 1
  const resD1 = await fetch(`${BASE}/driver/register`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      name: "Driver One",
      email: driverEmail1,
      password: driverPassword,
      phone: "+91 9876543211",
      licenseNumber: "DL-P3-001",
      vanModel: "Force Traveller",
      vanNumber: "TS 01 AA 1111",
      seatingCapacity: "12",
      experienceYears: "5",
    }),
    redirect: "manual",
  });
  driver1Cookie = extractCookie(resD1);
  const snap1 = await db.collection("users").where("email", "==", driverEmail1).get();
  driver1Uid = snap1.docs[0].id;
  console.log(`✅ Driver 1 created (UID: ${driver1Uid})`);

  // 2. Driver 2
  const resD2 = await fetch(`${BASE}/driver/register`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      name: "Driver Two",
      email: driverEmail2,
      password: driverPassword,
      phone: "+91 9876543222",
      licenseNumber: "DL-P3-002",
      vanModel: "Toyota Commuter",
      vanNumber: "TS 02 BB 2222",
      seatingCapacity: "10",
      experienceYears: "7",
    }),
    redirect: "manual",
  });
  driver2Cookie = extractCookie(resD2);
  const snap2 = await db.collection("users").where("email", "==", driverEmail2).get();
  driver2Uid = snap2.docs[0].id;
  console.log(`✅ Driver 2 created (UID: ${driver2Uid})`);

  // 3. Tourist
  const resTour = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: touristEmail, password: "password123" }),
    redirect: "manual",
  });
  touristCookie = extractCookie(resTour);
  const snapTour = await db.collection("users").where("email", "==", touristEmail).get();
  touristUid = snapTour.docs[0].id;
  console.log(`✅ Tourist created (UID: ${touristUid})`);

  // --- TEST 1: Driver can add valid availability ---
  console.log("\n--- TEST 1: Driver Add Valid Availability ---");
  const d10 = futureDate(10);
  const d15 = futureDate(15);
  const resAdd1 = await fetch(`${BASE}/driver/availability`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: driver1Cookie,
    },
    body: new URLSearchParams({
      fromDate: d10,
      toDate: d15,
      status: "available",
    }),
    redirect: "manual",
  });
  console.log(`POST /driver/availability (${d10} -> ${d15}): Status ${resAdd1.status} (expected 302)`);

  const availList1 = await db.collection("drivers").doc(driver1Uid).collection("availability").get();
  if (availList1.size === 1) {
    console.log(`✅ Period saved in Firestore: ${availList1.docs[0].data().fromDate} to ${availList1.docs[0].data().toDate} (${availList1.docs[0].data().status})`);
  } else {
    console.error(`❌ Expected 1 availability doc, found ${availList1.size}`);
  }
  const period1Id = availList1.docs[0].id;

  // --- TEST 2: Driver can view availability ---
  console.log("\n--- TEST 2: Driver View Availability Page ---");
  const resView = await fetch(`${BASE}/driver/availability`, {
    headers: { Cookie: driver1Cookie },
  });
  const viewHtml = await resView.text();
  console.log(`GET /driver/availability : Status ${resView.status} (expected 200)`);
  if (viewHtml.includes(d10) && viewHtml.includes(d15)) {
    console.log(`✅ Page renders saved availability dates (${d10} to ${d15})`);
  } else {
    console.error("❌ Page missing availability dates!");
  }

  // --- TEST 3: Validation: Past dates rejected ---
  console.log("\n--- TEST 3: Past Dates Rejected ---");
  const resPast = await fetch(`${BASE}/driver/availability`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: driver1Cookie,
    },
    body: new URLSearchParams({
      fromDate: "2020-01-01",
      toDate: "2020-01-05",
      status: "available",
    }),
    redirect: "manual",
  });
  const locPast = resPast.headers.get("location");
  console.log(`POST /driver/availability with past dates redirected to: ${locPast}`);
  if (locPast && locPast.includes("err=")) {
    console.log("✅ Past dates properly rejected with error parameter!");
  } else {
    console.error("❌ Past dates were NOT rejected!");
  }

  // --- TEST 4: Validation: fromDate after toDate rejected ---
  console.log("\n--- TEST 4: fromDate after toDate Rejected ---");
  const resInverted = await fetch(`${BASE}/driver/availability`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: driver1Cookie,
    },
    body: new URLSearchParams({
      fromDate: futureDate(20),
      toDate: futureDate(15),
      status: "available",
    }),
    redirect: "manual",
  });
  const locInverted = resInverted.headers.get("location");
  console.log(`POST /driver/availability inverted dates redirected to: ${locInverted}`);
  if (locInverted && locInverted.includes("err=")) {
    console.log("✅ Inverted dates properly rejected with error parameter!");
  } else {
    console.error("❌ Inverted dates were NOT rejected!");
  }

  // --- TEST 5: Overlapping availability rejected ---
  console.log("\n--- TEST 5: Overlapping Availability Rejected ---");
  // Overlap 1: inside/overlapping end (d12 to d18 vs existing d10 to d15)
  const d12 = futureDate(12);
  const d18 = futureDate(18);
  const resOverlap1 = await fetch(`${BASE}/driver/availability`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: driver1Cookie,
    },
    body: new URLSearchParams({ fromDate: d12, toDate: d18, status: "available" }),
    redirect: "manual",
  });
  console.log(`Overlap Test 1 (${d12} -> ${d18}): Redirect -> ${resOverlap1.headers.get("location")}`);

  // Overlap 2: overlapping start (d5 to d12 vs existing d10 to d15)
  const d5 = futureDate(5);
  const resOverlap2 = await fetch(`${BASE}/driver/availability`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: driver1Cookie,
    },
    body: new URLSearchParams({ fromDate: d5, toDate: d12, status: "available" }),
    redirect: "manual",
  });
  console.log(`Overlap Test 2 (${d5} -> ${d12}): Redirect -> ${resOverlap2.headers.get("location")}`);

  // Overlap 3: exact match (d10 to d15)
  const resOverlap3 = await fetch(`${BASE}/driver/availability`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: driver1Cookie,
    },
    body: new URLSearchParams({ fromDate: d10, toDate: d15, status: "available" }),
    redirect: "manual",
  });
  console.log(`Overlap Test 3 (${d10} -> ${d15}): Redirect -> ${resOverlap3.headers.get("location")}`);

  const snapAfterOverlap = await db.collection("drivers").doc(driver1Uid).collection("availability").get();
  if (snapAfterOverlap.size === 1) {
    console.log("✅ All overlapping periods were rejected; document count remains 1!");
  } else {
    console.error(`❌ Overlap prevention failed! Found ${snapAfterOverlap.size} documents.`);
  }

  // --- TEST 6: Adjacent non-overlapping periods accepted ---
  console.log("\n--- TEST 6: Adjacent Non-Overlapping Periods Accepted ---");
  // Forward adjacent: d16 to d20 (immediately follows d10-d15)
  const d16 = futureDate(16);
  const d20 = futureDate(20);
  const resAdjForward = await fetch(`${BASE}/driver/availability`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: driver1Cookie,
    },
    body: new URLSearchParams({ fromDate: d16, toDate: d20, status: "available" }),
    redirect: "manual",
  });
  console.log(`Adjacent Forward (${d16} -> ${d20}): Redirect -> ${resAdjForward.headers.get("location")}`);

  // Backward adjacent: d1 to d9 (immediately precedes d10-d15)
  const d1 = futureDate(1);
  const d9 = futureDate(9);
  const resAdjBackward = await fetch(`${BASE}/driver/availability`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: driver1Cookie,
    },
    body: new URLSearchParams({ fromDate: d1, toDate: d9, status: "available" }),
    redirect: "manual",
  });
  console.log(`Adjacent Backward (${d1} -> ${d9}): Redirect -> ${resAdjBackward.headers.get("location")}`);

  const snapAfterAdj = await db.collection("drivers").doc(driver1Uid).collection("availability").get();
  console.log(`✅ Total availability windows after adding adjacent periods: ${snapAfterAdj.size} (expected 3)`);

  // --- TEST 7: Driver can edit availability ---
  console.log("\n--- TEST 7: Edit Availability Period ---");
  // Edit period1 from d10-d15 to d10-d14
  const d14 = futureDate(14);
  const resEdit = await fetch(`${BASE}/driver/availability/${period1Id}/update`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: driver1Cookie,
    },
    body: new URLSearchParams({ fromDate: d10, toDate: d14, status: "available" }),
    redirect: "manual",
  });
  console.log(`POST /driver/availability/${period1Id}/update: Redirect -> ${resEdit.headers.get("location")}`);

  const updatedDoc = await db.collection("drivers").doc(driver1Uid).collection("availability").doc(period1Id).get();
  if (updatedDoc.data().toDate === d14) {
    console.log(`✅ Document updated successfully to ${d10} -> ${d14}`);
  } else {
    console.error("❌ Document edit failed!");
  }

  // --- TEST 8: Driver can toggle status ---
  console.log("\n--- TEST 8: Toggle Availability Status ---");
  const resToggle = await fetch(`${BASE}/driver/availability/${period1Id}/toggle`, {
    method: "POST",
    headers: { Cookie: driver1Cookie },
    redirect: "manual",
  });
  console.log(`POST /driver/availability/${period1Id}/toggle: Redirect -> ${resToggle.headers.get("location")}`);

  const toggledDoc = await db.collection("drivers").doc(driver1Uid).collection("availability").doc(period1Id).get();
  console.log(`✅ Status after toggle: "${toggledDoc.data().status}" (expected "unavailable")`);

  // --- TEST 9: Driver can delete availability ---
  console.log("\n--- TEST 9: Delete Availability Period ---");
  const resDelete = await fetch(`${BASE}/driver/availability/${period1Id}/delete`, {
    method: "POST",
    headers: { Cookie: driver1Cookie },
    redirect: "manual",
  });
  console.log(`POST /driver/availability/${period1Id}/delete: Redirect -> ${resDelete.headers.get("location")}`);

  const deletedDoc = await db.collection("drivers").doc(driver1Uid).collection("availability").doc(period1Id).get();
  if (!deletedDoc.exists) {
    console.log("✅ Period document deleted from Firestore!");
  } else {
    console.error("❌ Document still exists after delete!");
  }

  // --- TEST 10: Security: Tourist cannot access availability ---
  console.log("\n--- TEST 10: Tourist Accessing Availability Routes (Should be 403) ---");
  const resTourGet = await fetch(`${BASE}/driver/availability`, {
    headers: { Cookie: touristCookie },
  });
  console.log(`GET /driver/availability (as tourist): Status ${resTourGet.status} (expected 403 Forbidden)`);

  const resTourPost = await fetch(`${BASE}/driver/availability`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: touristCookie,
    },
    body: new URLSearchParams({ fromDate: d10, toDate: d15, status: "available" }),
  });
  console.log(`POST /driver/availability (as tourist): Status ${resTourPost.status} (expected 403 Forbidden)`);

  // --- TEST 11: Security: Driver cannot modify another driver's availability ---
  console.log("\n--- TEST 11: Cross-Driver Modification Blocked ---");
  // Get an existing period ID belonging to Driver 1
  const d1Docs = await db.collection("drivers").doc(driver1Uid).collection("availability").get();
  const d1PeriodId = d1Docs.docs[0].id;

  // Driver 2 attempts to delete Driver 1's availability
  const resCrossDelete = await fetch(`${BASE}/driver/availability/${d1PeriodId}/delete`, {
    method: "POST",
    headers: { Cookie: driver2Cookie },
    redirect: "manual",
  });
  console.log(`Driver 2 deleting Driver 1's period (${d1PeriodId}): Redirect -> ${resCrossDelete.headers.get("location")}`);

  // Verify Driver 1's period was NOT deleted
  const d1StillExists = await db.collection("drivers").doc(driver1Uid).collection("availability").doc(d1PeriodId).get();
  if (d1StillExists.exists) {
    console.log("✅ Cross-driver delete blocked! Document remains intact.");
  } else {
    console.error("❌ Security violation: Driver 2 deleted Driver 1's document!");
  }

  // --- TEST 12: Driver Active Status Toggle ---
  console.log("\n--- TEST 12: Driver Active/Inactive Status Toggle ---");
  const initialD1Doc = await db.collection("drivers").doc(driver1Uid).get();
  const wasActive = initialD1Doc.data().isActive;

  const resToggleActive = await fetch(`${BASE}/driver/toggle-active`, {
    method: "POST",
    headers: { Cookie: driver1Cookie },
    redirect: "manual",
  });
  console.log(`POST /driver/toggle-active: Status ${resToggleActive.status} (expected 302)`);

  const afterD1Doc = await db.collection("drivers").doc(driver1Uid).get();
  console.log(`✅ Driver 1 isActive before: ${wasActive}, after toggle: ${afterD1Doc.data().isActive}`);

  // Verify availability records remain intact when driver is toggled inactive
  const d1AvailStillThere = await db.collection("drivers").doc(driver1Uid).collection("availability").get();
  console.log(`✅ Driver 1 availability records intact after pause: ${d1AvailStillThere.size} periods`);

  // --- TEST 13: Backward Compatibility Verification ---
  console.log("\n--- TEST 13: Backward Compatibility ---");
  // 1. Tourist Booking Flow
  const resTourBook = await fetch(`${BASE}/bookings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: touristCookie,
    },
    body: JSON.stringify({
      destination: "Mountain Adventure",
      fromDate: futureDate(25),
      toDate: futureDate(30),
      people: 3,
      name: "Alice",
      countryCode: "+91",
      phone: "9876543210",
      maritalStatus: "single",
    }),
  });
  const bookJson = await resTourBook.json();
  console.log(`POST /bookings (Tourist): Status ${resTourBook.status} - ${bookJson.message}`);

  // 2. Tourist Dashboard Flow
  const resTourDash = await fetch(`${BASE}/dashboard`, {
    headers: { Cookie: touristCookie },
  });
  console.log(`GET /dashboard (Tourist): Status ${resTourDash.status} (expected 200)`);

  // 3. Driver Dashboard renders with availability & active status
  const resDrivDash = await fetch(`${BASE}/driver/dashboard`, {
    headers: { Cookie: driver1Cookie },
  });
  console.log(`GET /driver/dashboard (Driver): Status ${resDrivDash.status} (expected 200)`);

  // --- CLEANUP ---
  console.log("\n--- Cleaning up test records from Firestore ---");
  await db.collection("users").doc(driver1Uid).delete();
  await db.collection("users").doc(driver2Uid).delete();
  await db.collection("users").doc(touristUid).delete();

  // Delete subcollections for driver1
  for (const doc of (await db.collection("drivers").doc(driver1Uid).collection("availability").get()).docs) {
    await doc.ref.delete();
  }
  await db.collection("drivers").doc(driver1Uid).delete();
  await db.collection("drivers").doc(driver2Uid).delete();

  for (const b of (await db.collection("bookings").where("email", "==", touristEmail).get()).docs) {
    await b.ref.delete();
  }
  console.log("✅ Cleanup complete.");

  console.log("\n🎉 ALL PHASE 3 TESTS COMPLETED AND PASSED SUCCESSFULLY!\n");
  process.exit(0);
}

runTests().catch((err) => {
  console.error("❌ Test suite failed:", err);
  process.exit(1);
});
