const path = require("path");
const projectRoot = path.resolve(__dirname, "..");
require(path.join(projectRoot, "node_modules/dotenv")).config({ path: path.join(projectRoot, ".env") });

process.env.PORT = "3094";
const BASE = `http://localhost:${process.env.PORT}`;

async function runPhase9Tests() {
  console.log("================================================================================");
  console.log("🚀 STARTING PHASE 9 TRIP LIFECYCLE & IN-APP NOTIFICATION TEST SUITE");
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
          Accept: "application/json",
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

  // Helper to create test booking
  async function createTestBooking(customFields = {}) {
    const bookingRef = db.collection("bookings").doc();
    const docData = {
      bookingId: bookingRef.id,
      touristId: touristUid,
      destination: "Galle & Mirissa",
      fromDate: "2026-09-13",
      toDate: "2026-09-20",
      people: 4,
      name: "Phase 9 Tester",
      email: touristEmail,
      countryCode: "+91",
      phone: "9876543210",
      maritalStatus: "single",
      status: "Requested",
      driverId: null,
      bookedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...customFields,
    };
    await bookingRef.set(docData);
    createdTripIds.push(bookingRef.id);
    return bookingRef.id;
  }

  console.log("--- SETUP: Registering Tourist, Verified Driver, and Pending Driver ---");

  // A. Register Tourist
  const touristClient = new SessionClient();
  const touristEmail = `tourist_p9_${timestamp}@example.com`;
  await touristClient.postForm(`${BASE}/register`, { email: touristEmail, password: "password123" });
  const touristSnap = await db.collection("users").where("email", "==", touristEmail).get();
  const touristUid = touristSnap.docs[0].id;
  createdUserUids.push(touristUid);
  console.log(`  Tourist UID: ${touristUid}`);

  // B. Register Driver 1 (will be verified)
  const driver1Client = new SessionClient();
  const driver1Email = `driver1_p9_${timestamp}@example.com`;
  await driver1Client.postForm(`${BASE}/driver/register`, {
    name: "Driver Verified P9",
    email: driver1Email,
    password: "driverPassword123",
    phone: "+91 9100000001",
    licenseNumber: "DL-P9-001",
    vanModel: "Toyota HiAce Super GL",
    vanNumber: "TS 09 AB 1001",
    seatingCapacity: "12",
    experienceYears: "6",
  });
  const drv1Snap = await db.collection("drivers").where("email", "==", driver1Email).get();
  const driver1Uid = drv1Snap.docs[0].id;
  createdUserUids.push(driver1Uid);

  // Set Driver 1 to verified in Firestore
  await db.collection("drivers").doc(driver1Uid).update({
    verificationStatus: "verified",
    isActive: true,
  });
  // Add availability window covering September 2026
  await db.collection("drivers").doc(driver1Uid).collection("availability").add({
    fromDate: "2026-09-01",
    toDate: "2026-09-30",
    status: "available",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`  Verified Driver 1 UID: ${driver1Uid}`);

  // C. Register Driver 2 (unverified/pending)
  const driver2Client = new SessionClient();
  const driver2Email = `driver2_p9_${timestamp}@example.com`;
  await driver2Client.postForm(`${BASE}/driver/register`, {
    name: "Driver Pending P9",
    email: driver2Email,
    password: "driverPassword123",
    phone: "+91 9100000002",
    licenseNumber: "DL-P9-002",
    vanModel: "Nissan Caravan",
    vanNumber: "TS 09 CD 2002",
    seatingCapacity: "10",
    experienceYears: "2",
  });
  const drv2Snap = await db.collection("drivers").where("email", "==", driver2Email).get();
  const driver2Uid = drv2Snap.docs[0].id;
  createdUserUids.push(driver2Uid);
  console.log(`  Pending Driver 2 UID: ${driver2Uid}`);

  // D. Register Driver 3 (for another driver testing)
  const driver3Client = new SessionClient();
  const driver3Email = `driver3_p9_${timestamp}@example.com`;
  await driver3Client.postForm(`${BASE}/driver/register`, {
    name: "Driver Three P9",
    email: driver3Email,
    password: "driverPassword123",
    phone: "+91 9100000003",
    licenseNumber: "DL-P9-003",
    vanModel: "Toyota Commuter",
    vanNumber: "TS 09 EF 3003",
    seatingCapacity: "14",
    experienceYears: "4",
  });
  const drv3Snap = await db.collection("drivers").where("email", "==", driver3Email).get();
  const driver3Uid = drv3Snap.docs[0].id;
  createdUserUids.push(driver3Uid);
  await db.collection("drivers").doc(driver3Uid).update({
    verificationStatus: "verified",
    isActive: true,
  });

  console.log("\n--- TEST GROUP 1: START-TRIP DATE VALIDATION (EARLY, LATE, VALID) ---");

  // Test 1: Driver cannot start trip before fromDate
  const earlyTripId = await createTestBooking({
    status: "Accepted",
    driverId: driver1Uid,
    driverName: "Driver Verified P9",
    driverPhone: "+91 9100000001",
    vanModel: "Toyota HiAce Super GL",
    vanNumber: "TS 09 AB 1001",
    seatingCapacity: 12,
    fromDate: "2026-09-14", // Tomorrow relative to 2026-09-13
    toDate: "2026-09-20",
  });
  const earlyRes = await driver1Client.postJson(`${BASE}/driver/trips/${earlyTripId}/start`, {});
  assert(earlyRes.status === 400, `Early start attempt before fromDate rejected with HTTP 400 (Status: ${earlyRes.status})`);
  const earlyData = await earlyRes.json();
  assert(earlyData.error === "TRIP_TOO_EARLY", `Early start returned code TRIP_TOO_EARLY (${earlyData.message})`);

  const earlyDoc = await db.collection("bookings").doc(earlyTripId).get();
  assert(earlyDoc.data().status === "Accepted", "Early trip status remains Accepted in Firestore");

  // Test 2: Driver cannot start trip after toDate
  const lateTripId = await createTestBooking({
    status: "Accepted",
    driverId: driver1Uid,
    driverName: "Driver Verified P9",
    driverPhone: "+91 9100000001",
    vanModel: "Toyota HiAce Super GL",
    vanNumber: "TS 09 AB 1001",
    seatingCapacity: 12,
    fromDate: "2026-09-01",
    toDate: "2026-09-10", // Past relative to 2026-09-13
  });
  const lateRes = await driver1Client.postJson(`${BASE}/driver/trips/${lateTripId}/start`, {});
  assert(lateRes.status === 400, `Late start attempt after toDate rejected with HTTP 400 (Status: ${lateRes.status})`);
  const lateData = await lateRes.json();
  assert(lateData.error === "TRIP_PAST_WINDOW", `Late start returned code TRIP_PAST_WINDOW (${lateData.message})`);

  // Test 3: Driver can start trip within valid window (fromDate <= today <= toDate)
  const validTripId = await createTestBooking({
    status: "Accepted",
    driverId: driver1Uid,
    driverName: "Driver Verified P9",
    driverPhone: "+91 9100000001",
    vanModel: "Toyota HiAce Super GL",
    vanNumber: "TS 09 AB 1001",
    seatingCapacity: 12,
    fromDate: "2026-09-13", // Today
    toDate: "2026-09-20",
  });
  const validStartRes = await driver1Client.postJson(`${BASE}/driver/trips/${validTripId}/start`, {});
  assert(validStartRes.status === 200, `Valid window start succeeded with HTTP 200 (Status: ${validStartRes.status})`);

  const validDoc = await db.collection("bookings").doc(validTripId).get();
  assert(validDoc.data().status === "In Progress", "Trip status transitioned to 'In Progress'");
  assert(!!validDoc.data().startedAt, "startedAt server timestamp recorded in Firestore");

  // Check deterministic notification
  const startNotifDoc = await db.collection("notifications").doc(`notif_${validTripId}_TRIP_STARTED`).get();
  assert(startNotifDoc.exists, "Deterministic notification notif_${id}_TRIP_STARTED created in Firestore");
  assert(startNotifDoc.data().userId === touristUid, `Notification targeted strictly to tourist UID (${touristUid})`);
  assert(startNotifDoc.data().type === "TRIP_STARTED", "Notification type is TRIP_STARTED");

  console.log("\n--- TEST GROUP 2: TRIP COMPLETION & TERMINAL STATE INVARIANTS ---");

  // Test 4: Driver completes In Progress trip
  const completeRes = await driver1Client.postJson(`${BASE}/driver/trips/${validTripId}/complete`, {});
  assert(completeRes.status === 200, `Driver completed trip with HTTP 200 (Status: ${completeRes.status})`);

  const compDoc = await db.collection("bookings").doc(validTripId).get();
  assert(compDoc.data().status === "Completed", "Trip status transitioned to 'Completed'");
  assert(!!compDoc.data().completedAt, "completedAt server timestamp recorded in Firestore");

  const compNotifDoc = await db.collection("notifications").doc(`notif_${validTripId}_TRIP_COMPLETED`).get();
  assert(compNotifDoc.exists, "Deterministic notification notif_${id}_TRIP_COMPLETED created in Firestore");

  // Test 5: Terminal state cannot be re-started or re-completed
  const restartRes = await driver1Client.postJson(`${BASE}/driver/trips/${validTripId}/start`, {});
  assert(restartRes.status === 400, `Attempt to start a Completed trip rejected with HTTP 400 (${restartRes.status})`);

  const reCompleteRes = await driver1Client.postJson(`${BASE}/driver/trips/${validTripId}/complete`, {});
  assert(reCompleteRes.status === 400, `Attempt to complete an already Completed trip rejected with HTTP 400 (${reCompleteRes.status})`);

  const cancelCompRes = await touristClient.postJson(`${BASE}/cancel-booking/${validTripId}`, {});
  assert(cancelCompRes.status === 400, `Tourist cannot cancel a Completed trip (rejected with HTTP 400)`);

  console.log("\n--- TEST GROUP 3: CONCURRENCY RACE CONDITIONS (START VS CANCEL) ---");

  // Test 6: Concurrent start vs tourist cancellation race
  const raceTrip1 = await createTestBooking({
    status: "Accepted",
    driverId: driver1Uid,
    driverName: "Driver Verified P9",
    driverPhone: "+91 9100000001",
    vanModel: "Toyota HiAce Super GL",
    vanNumber: "TS 09 AB 1001",
    seatingCapacity: 12,
    fromDate: "2026-09-13",
    toDate: "2026-09-18",
  });

  const [race1Start, race1Cancel] = await Promise.all([
    driver1Client.postJson(`${BASE}/driver/trips/${raceTrip1}/start`, {}),
    touristClient.postJson(`${BASE}/cancel-booking/${raceTrip1}`, {}),
  ]);

  const race1Doc = await db.collection("bookings").doc(raceTrip1).get();
  const finalStatus1 = race1Doc.data().status;
  assert(
    (race1Start.status === 200 && race1Cancel.status === 400 && finalStatus1 === "In Progress") ||
    (race1Start.status === 400 && race1Cancel.status === 200 && finalStatus1 === "Cancelled"),
    `Concurrent start vs tourist cancellation serialized atomically (Final Status: ${finalStatus1}, Start HTTP: ${race1Start.status}, Cancel HTTP: ${race1Cancel.status})`
  );

  // Test 7: Concurrent start vs driver emergency cancellation race
  const raceTrip2 = await createTestBooking({
    status: "Accepted",
    driverId: driver1Uid,
    driverName: "Driver Verified P9",
    driverPhone: "+91 9100000001",
    vanModel: "Toyota HiAce Super GL",
    vanNumber: "TS 09 AB 1001",
    seatingCapacity: 12,
    fromDate: "2026-09-13",
    toDate: "2026-09-18",
  });

  const [race2Start, race2Cancel] = await Promise.all([
    driver1Client.postJson(`${BASE}/driver/trips/${raceTrip2}/start`, {}),
    driver1Client.postJson(`${BASE}/driver/trips/${raceTrip2}/cancel`, {
      reason: "Urgent family emergency",
      fromStatus: "Accepted",
    }),
  ]);

  const race2Doc = await db.collection("bookings").doc(raceTrip2).get();
  const finalStatus2 = race2Doc.data().status;
  assert(
    (race2Start.status === 200 && race2Cancel.status === 400 && finalStatus2 === "In Progress") ||
    (race2Start.status === 400 && race2Cancel.status === 200 && finalStatus2 === "Cancelled"),
    `Concurrent start vs driver cancellation serialized atomically (Final Status: ${finalStatus2}, Start HTTP: ${race2Start.status}, Cancel HTTP: ${race2Cancel.status})`
  );

  console.log("\n--- TEST GROUP 4: DRIVER EMERGENCY CANCELLATION & SNAPSHOT PRESERVATION ---");

  // Test 8: Emergency cancellation requires reason
  const emerTrip = await createTestBooking({
    status: "In Progress",
    driverId: driver1Uid,
    driverName: "Driver Verified P9",
    driverPhone: "+91 9100000001",
    driverEmail: driver1Email,
    vanModel: "Toyota HiAce Super GL",
    vanNumber: "TS 09 AB 1001",
    seatingCapacity: 12,
    fromDate: "2026-09-13",
    toDate: "2026-09-18",
  });

  const noReasonRes = await driver1Client.postJson(`${BASE}/driver/trips/${emerTrip}/cancel`, { reason: "bad" }); // less than 5 chars
  assert(noReasonRes.status === 400, `Emergency cancel with <5 chars rejected with HTTP 400 (Status: ${noReasonRes.status})`);

  // Valid emergency cancellation
  const emerCancelRes = await driver1Client.postJson(`${BASE}/driver/trips/${emerTrip}/cancel`, {
    reason: "Engine cooling system malfunction on expressway",
  });
  assert(emerCancelRes.status === 200, `Valid emergency cancel accepted with HTTP 200 (Status: ${emerCancelRes.status})`);

  const emerDoc = await db.collection("bookings").doc(emerTrip).get();
  const emerData = emerDoc.data();
  assert(emerData.status === "Cancelled", "Trip status transitioned to 'Cancelled'");
  assert(emerData.cancelledBy === "driver", "cancelledBy set to 'driver'");
  assert(emerData.cancellationReason === "Engine cooling system malfunction on expressway", "cancellationReason correctly recorded");
  assert(emerData.driverId === driver1Uid, "driverId snapshot field PRESERVED");
  assert(emerData.driverName === "Driver Verified P9", "driverName snapshot field PRESERVED");
  assert(emerData.vanModel === "Toyota HiAce Super GL", "vanModel snapshot field PRESERVED");
  assert(emerData.vanNumber === "TS 09 AB 1001", "vanNumber snapshot field PRESERVED");
  assert(emerData.seatingCapacity === 12, "seatingCapacity snapshot field PRESERVED");

  console.log("\n--- TEST GROUP 5: DRIVER AUTHORIZATION & VERIFICATION GATES ---");

  // Test 9: Unverified driver cannot start an accepted trip
  const unverifiedTrip = await createTestBooking({
    status: "Accepted",
    driverId: driver2Uid, // Driver 2 is pending
    driverName: "Driver Pending P9",
    fromDate: "2026-09-13",
    toDate: "2026-09-18",
  });
  const unverifiedStartRes = await driver2Client.postJson(`${BASE}/driver/trips/${unverifiedTrip}/start`, {});
  assert(unverifiedStartRes.status === 403, `Unverified driver cannot start trip (HTTP 403 Forbidden, got: ${unverifiedStartRes.status})`);

  // Test 10: Inactive driver cannot start a trip
  await db.collection("drivers").doc(driver1Uid).update({ isActive: false });
  const inactiveStartRes = await driver1Client.postJson(`${BASE}/driver/trips/${earlyTripId}/start`, {});
  assert(inactiveStartRes.status === 403, `Inactive driver cannot start trip (HTTP 403 Forbidden, got: ${inactiveStartRes.status})`);
  // Re-activate driver 1
  await db.collection("drivers").doc(driver1Uid).update({ isActive: true });

  // Test 11: Non-assigned driver cannot mutate another driver's trip
  const unauthorizedStartRes = await driver3Client.postJson(`${BASE}/driver/trips/${earlyTripId}/start`, {});
  assert(unauthorizedStartRes.status === 403, `Non-assigned driver cannot start trip (HTTP 403 Forbidden, got: ${unauthorizedStartRes.status})`);

  const unauthorizedCompRes = await driver3Client.postJson(`${BASE}/driver/trips/${earlyTripId}/complete`, {});
  assert(unauthorizedCompRes.status === 403, `Non-assigned driver cannot complete trip (HTTP 403 Forbidden, got: ${unauthorizedCompRes.status})`);

  const unauthorizedCancelRes = await driver3Client.postJson(`${BASE}/driver/trips/${earlyTripId}/cancel`, {
    reason: "Trying to cancel another driver trip",
  });
  assert(unauthorizedCancelRes.status === 403, `Non-assigned driver cannot cancel trip (HTTP 403 Forbidden, got: ${unauthorizedCancelRes.status})`);

  console.log("\n--- TEST GROUP 6: SCHEDULE OVERLAP & RELEASE INVARIANT ---");

  // Test 12: In-Progress trip blocks overlapping trip acceptance
  const activeTripForDriver3 = await createTestBooking({
    status: "In Progress",
    driverId: driver3Uid,
    driverName: "Driver Three P9",
    fromDate: "2026-09-15",
    toDate: "2026-09-22",
  });

  // Create overlapping open requested trip
  const overlapTrip = await createTestBooking({
    status: "Requested",
    fromDate: "2026-09-18",
    toDate: "2026-09-25",
  });
  // Add availability window for driver 3
  await db.collection("drivers").doc(driver3Uid).collection("availability").add({
    fromDate: "2026-09-01",
    toDate: "2026-09-30",
    status: "available",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const overlapAcceptRes = await driver3Client.postJson(`${BASE}/driver/trips/${overlapTrip}/accept`, {});
  assert(overlapAcceptRes.status === 400, `In-Progress trip blocks overlapping trip acceptance (HTTP 400, got: ${overlapAcceptRes.status})`);
  const overlapData = await overlapAcceptRes.json();
  assert(overlapData.error === "OVERLAPPING_TRIP", `Correctly rejected with OVERLAPPING_TRIP error code`);

  // Test 13: Completed and Cancelled trips release driver schedule
  await db.collection("bookings").doc(activeTripForDriver3).update({
    status: "Completed",
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  const unblockedAcceptRes = await driver3Client.postJson(`${BASE}/driver/trips/${overlapTrip}/accept`, {});
  assert(unblockedAcceptRes.status === 200, `Completed trip releases driver schedule, acceptance succeeds (HTTP 200)`);

  console.log("\n--- TEST GROUP 7: IN-APP NOTIFICATIONS & MARK-ALL-READ SECURITY ---");

  // Test 14: Tourist can fetch their notifications
  const notifListRes = await touristClient.fetch(`${BASE}/notifications`, {
    headers: { Accept: "application/json" },
  });
  assert(notifListRes.status === 200, `Tourist fetched notifications successfully (HTTP 200)`);
  const notifListData = await notifListRes.json();
  assert(Array.isArray(notifListData.notifications), "notifications array returned in JSON");
  assert(notifListData.unreadCount > 0, `Unread notifications count > 0 (Count: ${notifListData.unreadCount})`);

  // Test 15: Mark single notification as read
  const sampleNotif = notifListData.notifications.find((n) => !n.isRead);
  assert(!!sampleNotif, "Found unread notification to test mark as read");
  const markReadRes = await touristClient.postJson(`${BASE}/notifications/${sampleNotif.id}/read`, {});
  assert(markReadRes.status === 200, `Marked single notification as read (HTTP 200)`);
  const sampleDoc = await db.collection("notifications").doc(sampleNotif.id).get();
  assert(sampleDoc.data().isRead === true, "Notification isRead updated to true in Firestore");

  // Test 16: User cannot mark another user's notification as read
  const driverNotifDoc = await db.collection("notifications").doc(`notif_${raceTrip1}_TRIP_CANCELLED`).get();
  if (driverNotifDoc.exists) {
    const unauthReadRes = await touristClient.postJson(`${BASE}/notifications/${driverNotifDoc.id}/read`, {});
    assert(unauthReadRes.status === 403, `User cannot mark another user's notification as read (HTTP 403 Forbidden)`);
  } else {
    // Or create a dummy driver notification
    const drvDummyNotif = db.collection("notifications").doc();
    await drvDummyNotif.set({
      notificationId: drvDummyNotif.id,
      userId: driver1Uid,
      userRole: "driver",
      title: "Driver Notif",
      message: "Test",
      isRead: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    const unauthReadRes = await touristClient.postJson(`${BASE}/notifications/${drvDummyNotif.id}/read`, {});
    assert(unauthReadRes.status === 403, `User cannot mark another user's notification as read (HTTP 403 Forbidden)`);
  }

  // Test 17: Mark-All-Read security: Only affects caller's notifications, ignores client userId
  // Ensure driver 1 has at least 1 unread notification
  const drvNotifRef = db.collection("notifications").doc(`notif_test_${timestamp}`);
  await drvNotifRef.set({
    notificationId: drvNotifRef.id,
    userId: driver1Uid,
    userRole: "driver",
    title: "Driver Secret Alert",
    message: "Test notification for driver",
    isRead: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Tourist calls mark-all-read passing malicious body { userId: driver1Uid }
  const markAllRes = await touristClient.postJson(`${BASE}/notifications/mark-all-read`, {
    userId: driver1Uid,
  });
  assert(markAllRes.status === 200, `Tourist executed mark-all-read with HTTP 200`);

  // Verify tourist unread count is now 0
  const touristUnreadSnap = await db
    .collection("notifications")
    .where("userId", "==", touristUid)
    .where("isRead", "==", false)
    .get();
  assert(touristUnreadSnap.size === 0, `All tourist notifications are now read (Count: 0)`);

  // Verify driver's notification remains unread!
  const drvCheck = await drvNotifRef.get();
  assert(drvCheck.data().isRead === false, `Driver's notification remains isRead: false (scoped strictly to caller session)`);

  // Test 18: Notification duplicate prevention
  const notifQuerySnap = await db
    .collection("notifications")
    .where("relatedTripId", "==", validTripId)
    .where("type", "==", "TRIP_STARTED")
    .get();
  assert(notifQuerySnap.size === 1, `Exactly 1 notification exists for TRIP_STARTED event (Deterministic ID prevents duplicates)`);

  // Test 19: Tourist cannot cancel an In-Progress trip
  const activeEnRouteTrip = await createTestBooking({
    status: "In Progress",
    driverId: driver1Uid,
    driverName: "Driver Verified P9",
    fromDate: "2026-09-13",
    toDate: "2026-09-18",
  });
  const touristCancelInProgRes = await touristClient.postJson(`${BASE}/cancel-booking/${activeEnRouteTrip}`, {});
  assert(touristCancelInProgRes.status === 400, `Tourist cannot cancel an In-Progress trip (HTTP 400)`);
  const touristCancelInProgData = await touristCancelInProgRes.json();
  assert(touristCancelInProgData.error === "CANNOT_CANCEL_IN_PROGRESS", `Received code CANNOT_CANCEL_IN_PROGRESS`);

  // Cleanup created test records
  console.log("\n--- CLEANUP: Removing test bookings & users ---");
  for (const tid of createdTripIds) {
    try {
      await db.collection("bookings").doc(tid).delete();
    } catch (e) {}
  }
  for (const uid of createdUserUids) {
    try {
      await db.collection("users").doc(uid).delete();
      await db.collection("drivers").doc(uid).delete();
    } catch (e) {}
  }

  console.log("================================================================================");
  console.log(`📊 TEST RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log("================================================================================");

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runPhase9Tests().catch((err) => {
  console.error("FATAL TEST ERROR:", err);
  process.exit(1);
});
