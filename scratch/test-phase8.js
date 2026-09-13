const path = require("path");
const projectRoot = path.resolve(__dirname, "..");
require(path.join(projectRoot, "node_modules/dotenv")).config({ path: path.join(projectRoot, ".env") });

process.env.PORT = "3092";
const BASE = `http://localhost:${process.env.PORT}`;

async function runPhase8Tests() {
  console.log("================================================================================");
  console.log("🛡️  STARTING PHASE 8 ADMIN PORTAL & DRIVER VERIFICATION TEST SUITE");
  console.log("================================================================================\n");

  process.chdir(projectRoot);
  require(path.join(projectRoot, "app.js"));

  // Wait 1.5s for server initialization
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const admin = require(path.join(projectRoot, "node_modules/firebase-admin"));
  const db = admin.firestore();

  // Helper class for session handling
  class SessionClient {
    constructor() {
      this.cookies = {};
    }

    async fetch(url, options = {}) {
      options.headers = options.headers || {};
      const cookieStr = Object.entries(this.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
      if (cookieStr) options.headers["Cookie"] = cookieStr;

      const res = await fetch(url, { ...options, redirect: options.redirect || "manual" });
      const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      if (setCookies.length === 0) {
        const raw = res.headers.get("set-cookie");
        if (raw) setCookies.push(raw);
      }
      for (const sc of setCookies) {
        const parts = sc.split(";")[0].split("=");
        this.cookies[parts[0].trim()] = parts.slice(1).join("=").trim();
      }
      return res;
    }

    async getCsrfToken() {
      const res = await this.fetch(`${BASE}/csrf-token`);
      const data = await res.json();
      return data.csrfToken;
    }

    async postForm(url, bodyObj) {
      const token = await this.getCsrfToken();
      const params = new URLSearchParams({ ...bodyObj, _csrf: token });
      return this.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
      });
    }

    async postJson(url, bodyObj, headers = {}) {
      const token = await this.getCsrfToken();
      return this.fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": token,
          ...headers,
        },
        body: JSON.stringify({ ...bodyObj, _csrf: token }),
      });
    }
  }

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  const timestamp = Date.now();
  const createdUserUids = [];
  const createdTripIds = [];

  // 1. SETUP ENTITIES
  console.log("--- SETUP: Registering Tourist, Drivers, and Provisioning Admin ---");

  // A. Register Tourist
  const touristClient = new SessionClient();
  const touristEmail = `tourist_p8_${timestamp}@example.com`;
  await touristClient.postForm(`${BASE}/register`, { email: touristEmail, password: "password123" });
  const touristSnap = await db.collection("users").where("email", "==", touristEmail).get();
  const touristUid = touristSnap.docs[0].id;
  createdUserUids.push(touristUid);
  console.log(`  Created tourist: ${touristEmail} (UID: ${touristUid})`);

  // B. Register Driver 1 (will be approved)
  const driver1Client = new SessionClient();
  const driver1Email = `driver1_p8_${timestamp}@example.com`;
  await driver1Client.postForm(`${BASE}/driver/register`, {
    name: "Driver One P8",
    email: driver1Email,
    password: "driverPassword123",
    phone: "+91 9000000001",
    licenseNumber: "DL-P8-001",
    vanModel: "Toyota HiAce",
    vanNumber: "TS 08 AB 0001",
    seatingCapacity: "12",
    experienceYears: "5",
  });
  const drv1Snap = await db.collection("drivers").where("email", "==", driver1Email).get();
  const driver1Uid = drv1Snap.docs[0].id;
  createdUserUids.push(driver1Uid);
  console.log(`  Created driver 1: ${driver1Email} (UID: ${driver1Uid})`);

  // B2. Register Driver 2 (will be rejected)
  const driver2Client = new SessionClient();
  const driver2Email = `driver2_p8_${timestamp}@example.com`;
  await driver2Client.postForm(`${BASE}/driver/register`, {
    name: "Driver Two P8",
    email: driver2Email,
    password: "driverPassword123",
    phone: "+91 9000000002",
    licenseNumber: "DL-P8-002",
    vanModel: "Force Urbania",
    vanNumber: "TS 08 CD 0002",
    seatingCapacity: "14",
    experienceYears: "3",
  });
  const drv2Snap = await db.collection("drivers").where("email", "==", driver2Email).get();
  const driver2Uid = drv2Snap.docs[0].id;
  createdUserUids.push(driver2Uid);
  console.log(`  Created driver 2: ${driver2Email} (UID: ${driver2Uid})`);

  // C. Register User for Admin & Provision via Server-Side Role Update (scripts/make-admin equivalent)
  const adminEmail = `admin_p8_${timestamp}@example.com`;
  const adminClient = new SessionClient();
  await adminClient.postForm(`${BASE}/register`, { email: adminEmail, password: "adminPassword123" });
  const adminSnap = await db.collection("users").where("email", "==", adminEmail).get();
  const adminUid = adminSnap.docs[0].id;
  createdUserUids.push(adminUid);

  // Server-side promote user to admin in Firestore
  await db.collection("users").doc(adminUid).update({
    role: "admin",
    promotedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`  Provisioned admin: ${adminEmail} (UID: ${adminUid})`);

  // Log in as admin
  const adminLoginRes = await adminClient.postForm(`${BASE}/login`, { email: adminEmail, password: "adminPassword123" });
  assert(adminLoginRes.status === 302 && adminLoginRes.headers.get("location") === "/admin", "Admin logs in and redirects to /admin");

  // Create a trip request in Firestore
  const tripRef = db.collection("bookings").doc();
  await tripRef.set({
    bookingId: tripRef.id,
    touristId: touristUid,
    destination: "Munnar Tea Hills",
    fromDate: "2027-02-01",
    toDate: "2027-02-05",
    people: 4,
    name: "Test Tourist P8",
    email: touristEmail,
    phone: "9876543210",
    countryCode: "+91",
    status: "Requested",
    driverId: null,
    bookedAt: new Date(),
    updatedAt: new Date(),
  });
  createdTripIds.push(tripRef.id);

  // Add availability window covering trip for Driver 1 and Driver 2
  await db.collection("drivers").doc(driver1Uid).collection("availability").add({
    fromDate: "2027-02-01",
    toDate: "2027-02-10",
    status: "available",
    createdAt: new Date(),
  });
  await db.collection("drivers").doc(driver2Uid).collection("availability").add({
    fromDate: "2027-02-01",
    toDate: "2027-02-10",
    status: "available",
    createdAt: new Date(),
  });

  // =========================================================================
  // TEST GROUP 1: AUTHENTICATION & ACCESS CONTROL ON /admin
  // =========================================================================
  console.log("\n--- 1. Admin Role-Based Access Control ---");

  // 1.1 Unauthenticated -> /admin
  const anonClient = new SessionClient();
  const unauthRes = await anonClient.fetch(`${BASE}/admin`);
  assert(unauthRes.status === 302 && unauthRes.headers.get("location") === "/login", "1. Unauthenticated user redirected to /login");

  // 1.2 Tourist -> /admin
  const tourAdminRes = await touristClient.fetch(`${BASE}/admin`);
  assert(tourAdminRes.status === 403, "2. Tourist account accessing /admin receives 403 Forbidden");

  // 1.3 Driver -> /admin
  const drvAdminRes = await driver1Client.fetch(`${BASE}/admin`);
  assert(drvAdminRes.status === 403, "3. Driver account accessing /admin receives 403 Forbidden");

  // 1.4 Admin -> /admin
  const adminDashRes = await adminClient.fetch(`${BASE}/admin`);
  assert(adminDashRes.status === 200, "4. Admin account accessing /admin receives 200 OK");
  const dashHtml = await adminDashRes.text();
  assert(dashHtml.includes("Platform Overview"), "4b. Admin dashboard renders 'Platform Overview'");

  // 1.5 Admin -> /admin/drivers
  const adminDriversRes = await adminClient.fetch(`${BASE}/admin/drivers`);
  assert(adminDriversRes.status === 200, "5. Admin can access /admin/drivers");

  // 1.6 Admin -> /admin/trips
  const adminTripsRes = await adminClient.fetch(`${BASE}/admin/trips`);
  assert(adminTripsRes.status === 200, "6. Admin can access /admin/trips");

  // 1.7 Admin -> /admin/users
  const adminUsersRes = await adminClient.fetch(`${BASE}/admin/users`);
  assert(adminUsersRes.status === 200, "7. Admin can access /admin/users");

  // =========================================================================
  // TEST GROUP 2: DRIVER VERIFICATION & REJECTION WORKFLOW
  // =========================================================================
  console.log("\n--- 2. Driver Verification & Rejection Workflow ---");

  // 2.1 Pending driver -> Verified
  const verifyRes = await adminClient.postForm(`${BASE}/admin/drivers/${driver1Uid}/verify`, {});
  assert(verifyRes.status === 302, "8. Admin can verify pending driver (302 redirect)");
  const d1DocAfter = await db.collection("drivers").doc(driver1Uid).get();
  assert(d1DocAfter.data().verificationStatus === "verified", "8b. Driver 1 status in Firestore updated to 'verified'");
  assert(d1DocAfter.data().verificationUpdatedBy === adminUid, "8c. verificationUpdatedBy matches authenticated admin UID");

  // 2.2 Pending driver -> Rejected
  const rejectRes = await adminClient.postForm(`${BASE}/admin/drivers/${driver2Uid}/reject`, {});
  assert(rejectRes.status === 302, "9. Admin can reject pending driver (302 redirect)");
  const d2DocAfter = await db.collection("drivers").doc(driver2Uid).get();
  assert(d2DocAfter.data().verificationStatus === "rejected", "9b. Driver 2 status in Firestore updated to 'rejected'");
  assert(d2DocAfter.data().verificationUpdatedBy === adminUid, "9c. Driver 2 verificationUpdatedBy matches admin UID");

  // =========================================================================
  // TEST GROUP 3: MARKETPLACE ELIGIBILITY RULES
  // =========================================================================
  console.log("\n--- 3. Production Marketplace Verification Rules ---");

  // 3.1 Rejected driver cannot match
  const d2MarketRes = await driver2Client.fetch(`${BASE}/driver/trips`);
  const d2MarketHtml = await d2MarketRes.text();
  assert(!d2MarketHtml.includes("Munnar Tea Hills"), "10. Rejected driver cannot match or view open trips in marketplace");

  // 3.2 Pending driver cannot match (create new pending driver)
  const pendingDriverEmail = `pending_p8_${timestamp}@example.com`;
  const pendingDriverClient = new SessionClient();
  await pendingDriverClient.postForm(`${BASE}/driver/register`, {
    name: "Pending Driver P8",
    email: pendingDriverEmail,
    password: "driverPassword123",
    phone: "+91 9000000003",
    licenseNumber: "DL-P8-003",
    vanModel: "Innova Crysta",
    vanNumber: "TS 08 EF 0003",
    seatingCapacity: "7",
    experienceYears: "2",
  });
  const pSnap = await db.collection("drivers").where("email", "==", pendingDriverEmail).get();
  const pUid = pSnap.docs[0].id;
  createdUserUids.push(pUid);
  await db.collection("drivers").doc(pUid).collection("availability").add({
    fromDate: "2027-02-01",
    toDate: "2027-02-10",
    status: "available",
  });

  const pMarketRes = await pendingDriverClient.fetch(`${BASE}/driver/trips`);
  const pMarketHtml = await pMarketRes.text();
  assert(!pMarketHtml.includes("Munnar Tea Hills"), "11. Pending driver cannot match open trips in marketplace");

  // 3.3 Verified + Active driver can match
  const d1MarketRes = await driver1Client.fetch(`${BASE}/driver/trips`);
  const d1MarketHtml = await d1MarketRes.text();
  assert(d1MarketHtml.includes("Munnar Tea Hills"), "12. Verified + Active driver successfully matches open trip in marketplace");

  // 3.4 Verified + Inactive driver cannot match
  await db.collection("drivers").doc(driver1Uid).update({ isActive: false });
  const d1InactiveMarketRes = await driver1Client.fetch(`${BASE}/driver/trips`);
  const d1InactiveHtml = await d1InactiveMarketRes.text();
  assert(!d1InactiveHtml.includes("Munnar Tea Hills"), "13. Verified + Inactive driver cannot match open trips in marketplace");
  await db.collection("drivers").doc(driver1Uid).update({ isActive: true }); // restore

  // =========================================================================
  // TEST GROUP 4: ADMIN ACTIVE TOGGLE & MUTATION INTEGRITY
  // =========================================================================
  console.log("\n--- 4. Active Status Management & Whitelist Security ---");

  // 4.1 Admin toggle-active preserves verificationStatus
  const toggleRes = await adminClient.postForm(`${BASE}/admin/drivers/${driver1Uid}/toggle-active`, {});
  assert(toggleRes.status === 302, "14. Admin active toggle succeeds (302 redirect)");
  const d1Toggled = await db.collection("drivers").doc(driver1Uid).get();
  assert(d1Toggled.data().isActive === false, "14b. Driver 1 isActive toggled to false");
  assert(d1Toggled.data().verificationStatus === "verified", "14c. verificationStatus remains strictly 'verified'");
  assert(d1Toggled.data().activeStatusUpdatedBy === adminUid, "14d. activeStatusUpdatedBy matches admin UID");

  // Re-activate
  await adminClient.postForm(`${BASE}/admin/drivers/${driver1Uid}/toggle-active`, {});
  const d1Restored = await db.collection("drivers").doc(driver1Uid).get();
  assert(d1Restored.data().isActive === true, "14e. Driver 1 reactivated successfully");

  // =========================================================================
  // TEST GROUP 5: SECURITY, FORGERY & VALIDATION
  // =========================================================================
  console.log("\n--- 5. Security Controls & Error Handling ---");

  // 5.1 Forged / Missing CSRF rejected
  const fakeCsrfRes = await adminClient.fetch(`${BASE}/admin/drivers/${driver1Uid}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: "invalid-forged-token-xyz" }),
  });
  assert(fakeCsrfRes.status === 403, "15. Forged CSRF on admin POST is rejected with 403 Forbidden");

  // 5.2 Non-admin (tourist/driver) mutation rejected
  const tourMutateRes = await touristClient.postForm(`${BASE}/admin/drivers/${driver2Uid}/verify`, {});
  assert(tourMutateRes.status === 403, "16. Tourist attempting admin mutation receives 403 Forbidden");
  const drvMutateRes = await driver1Client.postForm(`${BASE}/admin/drivers/${driver2Uid}/verify`, {});
  assert(drvMutateRes.status === 403, "16b. Driver attempting admin mutation receives 403 Forbidden");

  // 5.3 Nonexistent driver ID handled safely
  const notFoundGet = await adminClient.fetch(`${BASE}/admin/drivers/nonexistent_xyz_999`);
  assert(notFoundGet.status === 404, "17. Nonexistent driver GET returns clean 404");
  const notFoundPost = await adminClient.postForm(`${BASE}/admin/drivers/nonexistent_xyz_999/verify`, {});
  assert(notFoundPost.status === 404, "17b. Nonexistent driver POST returns clean 404");

  // 5.4 Whitelist enforced: admin mutation does not overwrite unrelated fields
  const d1Before = (await db.collection("drivers").doc(driver1Uid).get()).data();
  await adminClient.postForm(`${BASE}/admin/drivers/${driver1Uid}/verify`, {
    seatingCapacity: "99", // Attempt unauthorized modification
    vanModel: "Fake Rocket",
  });
  const d1After = (await db.collection("drivers").doc(driver1Uid).get()).data();
  assert(d1After.seatingCapacity === d1Before.seatingCapacity, "18. Seating capacity was not overwritten by admin endpoint");
  assert(d1After.vanModel === d1Before.vanModel, "18b. Van model was not overwritten by admin endpoint");

  // 5.5 Audit UID comes strictly from session
  assert(d1After.verificationUpdatedBy === adminUid, "19. Verification updatedBy strictly matches session admin UID");

  // =========================================================================
  // TEST GROUP 6: TRANSACTIONAL ACCEPTANCE INTEGRATION
  // =========================================================================
  console.log("\n--- 6. Transactional Trip Acceptance with Verification ---");

  // 6.1 Rejected driver acceptance blocked
  const rejectAcceptRes = await driver2Client.postJson(`${BASE}/driver/trips/${tripRef.id}/accept`, {}, { Accept: "application/json" });
  assert(rejectAcceptRes.status === 400, "20. Rejected driver attempting to accept trip returns 400");
  const rejJson = await rejectAcceptRes.json();
  assert(rejJson.error === "DRIVER_REJECTED", "20b. Error code is DRIVER_REJECTED");

  // 6.2 Pending driver acceptance blocked
  const pendAcceptRes = await pendingDriverClient.postJson(`${BASE}/driver/trips/${tripRef.id}/accept`, {}, { Accept: "application/json" });
  assert(pendAcceptRes.status === 400, "20c. Pending driver attempting to accept trip returns 400");
  const pendJson = await pendAcceptRes.json();
  assert(pendJson.error === "DRIVER_NOT_VERIFIED", "20d. Error code is DRIVER_NOT_VERIFIED");

  // 6.3 Verified driver acceptance succeeds
  const d1AcceptRes = await driver1Client.postJson(`${BASE}/driver/trips/${tripRef.id}/accept`, {}, { Accept: "application/json" });
  assert(d1AcceptRes.status === 200, "20e. Verified driver accepts trip with 200 OK");
  const tripFinalDoc = await db.collection("bookings").doc(tripRef.id).get();
  assert(tripFinalDoc.data().status === "Accepted", "20f. Trip status atomically updated to 'Accepted'");
  assert(tripFinalDoc.data().driverId === driver1Uid, "20g. Trip driverId assigned to verified driver UID");

  // =========================================================================
  // CLEANUP
  // =========================================================================
  console.log("\n--- CLEANUP: Removing Test Records ---");
  for (const tid of createdTripIds) {
    try { await db.collection("bookings").doc(tid).delete(); } catch (_) {}
  }
  for (const uid of createdUserUids) {
    try { await db.collection("users").doc(uid).delete(); } catch (_) {}
    try { await db.collection("drivers").doc(uid).delete(); } catch (_) {}
  }
  console.log(`Cleaned up ${createdTripIds.length} trip records and ${createdUserUids.length} test accounts.`);

  console.log("\n================================================================================");
  console.log(`🏁 PHASE 8 TEST RESULTS: ${passed} PASSED, ${failed} FAILED (Total: ${passed + failed})`);
  console.log("================================================================================");

  if (failed > 0) process.exit(1);
  process.exit(0);
}

runPhase8Tests().catch((err) => {
  console.error("❌ Fatal test error:", err);
  process.exit(1);
});
