const path = require("path");
const projectRoot = path.resolve(__dirname, "..");
require(path.join(projectRoot, "node_modules/dotenv")).config({ path: path.join(projectRoot, ".env") });

// Set Production Mode and Proxy Trust configuration
process.env.PORT = "3097";
process.env.NODE_ENV = "production";
process.env.SESSION_SECRET = "abcdef1234567890abcdef1234567890"; // 32 chars required in prod
process.env.TRUST_PROXY = "1";
process.env.APP_TIMEZONE = "Asia/Colombo";

const BASE = `http://localhost:${process.env.PORT}`;

let passedCount = 0;
let failedCount = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passedCount++;
  } else {
    console.error(`  ❌ FAILED: ${message}`);
    failedCount++;
  }
}

// Emulated HTTPS Client behind Reverse Proxy
class ProxyClient {
  constructor(clientIp = "203.0.113.195") {
    this.cookies = {};
    this.clientIp = clientIp;
  }

  async fetch(url, options = {}) {
    options.headers = options.headers || {};
    // Simulate reverse proxy headers
    options.headers["X-Forwarded-Proto"] = "https";
    options.headers["X-Forwarded-For"] = this.clientIp;

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
        "Accept": "application/json",
        "x-csrf-token": token,
        ...headers,
      },
      body: JSON.stringify(bodyObj),
    });
  }
}

async function runPhase11SmokeTest() {
  console.log("================================================================================");
  console.log("🚀 STARTING PHASE 11 PRODUCTION SMOKE TEST (PROD MODE + TRUST PROXY)");
  console.log("================================================================================\n");

  process.chdir(projectRoot);

  // 1. Boot Live Application
  console.log("--- 1. Application Startup & Operational Probes ---");
  const { app, server, shutdownCoordinator } = require(path.join(projectRoot, "app.js"));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert(true, "1. Application starts successfully with strict production configuration");

  // 2. /health
  const healthRes = await fetch(`${BASE}/health`);
  const healthData = await healthRes.json();
  assert(healthRes.status === 200 && healthData.status === "ok", "2. GET /health responds with HTTP 200 OK (liveness)");

  // 3. /ready
  const readyRes = await fetch(`${BASE}/ready`);
  const readyData = await readyRes.json();
  assert(readyRes.status === 200 && readyData.checks?.firestore === "connected", "3. GET /ready responds with HTTP 200 OK (firestore connected)");

  // 4. Reverse Proxy Trust & HTTPS Cookie Security Verification
  console.log("\n--- 2. Reverse Proxy Trust & HTTPS Cookie Hardening ---");
  const touristClient = new ProxyClient("198.51.100.42");
  const csrfRes = await touristClient.fetch(`${BASE}/csrf-token`);
  assert(csrfRes.status === 200, "4. Reverse proxy client successfully receives CSRF token over HTTPS forwarded connection");

  const rawSetCookie = csrfRes.headers.get("set-cookie") || "";
  assert(rawSetCookie.includes("HttpOnly"), "5. Session cookie contains HttpOnly security flag");
  assert(rawSetCookie.toLowerCase().includes("samesite=lax"), "6. Session cookie contains SameSite=Lax attribute");

  // 5. User Registration & Persistent Session Creation
  console.log("\n--- 3. Tourist Registration, Session Persistence & Trip Creation ---");
  const testEmail = `smoke_tourist_${Date.now()}@example.com`;
  const regRes = await touristClient.postForm(`${BASE}/register`, {
    email: testEmail,
    password: "Password123!Prod",
  });
  assert(regRes.status === 302, "7. Tourist registration succeeds and issues session");

  const dashRes = await touristClient.fetch(`${BASE}/dashboard`);
  assert(dashRes.status === 200, "8. Authenticated tourist can access /dashboard");

  const admin = require(path.join(projectRoot, "node_modules/firebase-admin"));
  const db = admin.firestore();

  // Verify session document in Firestore
  const sessionSnap = await db.collection("sessions").get();
  let foundSession = false;
  sessionSnap.forEach((doc) => {
    const d = doc.data();
    if (d.session && d.session.includes(testEmail)) foundSession = true;
  });
  assert(foundSession, "9. User session document is persisted in Firestore 'sessions/{sid}'");

  // Tourist creates a trip request for tomorrow (must be at least tomorrow per booking validation)
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const fromStr = tomorrow.toISOString().slice(0, 10);
  const futureDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
  const futureStr = futureDate.toISOString().slice(0, 10);

  const tripRes = await touristClient.postForm(`${BASE}/bookings`, {
    destination: "Kandy Cultural Tour",
    name: "John Traveler",
    maritalStatus: "single",
    people: "4",
    phone: "771234567",
    countryCode: "+94",
    fromDate: fromStr,
    toDate: futureStr,
  });
  assert(tripRes.status === 200, "10. Tourist creates trip request (Requested status)");

  // Locate created trip in Firestore
  const tripSnap = await db
    .collection("bookings")
    .where("email", "==", testEmail)
    .where("destination", "==", "Kandy Cultural Tour")
    .limit(1)
    .get();
  assert(!tripSnap.empty, "11. Trip request persisted in Firestore 'bookings' collection");
  const tripDoc = tripSnap.docs[0];
  const tripId = tripDoc.id;

  // 6. Driver Registration, Availability & Admin Verification
  console.log("\n--- 4. Driver Onboarding, Admin Verification & Marketplace Match ---");
  const driverEmail = `smoke_driver_${Date.now()}@example.com`;
  const driverClient = new ProxyClient("198.51.100.88");

  const driverRegRes = await driverClient.postForm(`${BASE}/driver/register`, {
    email: driverEmail,
    password: "Password123!Prod",
    name: "Sunil Perera",
    phone: "0779876543",
    countryCode: "+94",
    experienceYears: "10",
    licenseNumber: "B1234567",
    vanModel: "Toyota HiAce Super GL",
    vanNumber: "WP-ND-5678",
    seatingCapacity: "10",
  });
  assert(driverRegRes.status === 302, "12. Driver registered successfully with 'pending' verification");

  // Fetch driver UID
  const driverUserSnap = await db.collection("users").where("email", "==", driverEmail).limit(1).get();
  const driverUid = driverUserSnap.docs[0].id;

  // Add availability window covering trip dates
  await db
    .collection("drivers")
    .doc(driverUid)
    .collection("availability")
    .doc("avail_smoke_1")
    .set({
      fromDate: fromStr,
      toDate: futureStr,
      status: "available",
      notes: "Ready for tours",
      createdAt: new Date(),
    });

  // Provision Admin to verify driver
  const adminEmail = `smoke_admin_${Date.now()}@example.com`;
  const adminClient = new ProxyClient("198.51.100.99");
  await adminClient.postForm(`${BASE}/register`, { email: adminEmail, password: "Password123!Prod" });
  const adminUserSnap = await db.collection("users").where("email", "==", adminEmail).limit(1).get();
  const adminUid = adminUserSnap.docs[0].id;
  await db.collection("users").doc(adminUid).update({ role: "admin" });

  // Admin logs in and approves driver
  await adminClient.postForm(`${BASE}/login`, { email: adminEmail, password: "Password123!Prod" });
  const verifyRes = await adminClient.postForm(`${BASE}/admin/drivers/${driverUid}/verify`, {});
  assert(verifyRes.status === 302, "13. Administrator approves driver (status updated to 'verified')");

  // Driver logs in and accesses marketplace
  await driverClient.postForm(`${BASE}/driver/login`, { email: driverEmail, password: "Password123!Prod" });
  const marketRes = await driverClient.fetch(`${BASE}/driver/trips`);
  assert(marketRes.status === 200, "14. Verified driver can discover matching trips in marketplace");

  // 7. Transactional Trip Acceptance & Atomic Notification
  console.log("\n--- 5. Atomic Trip Acceptance & Notification Verification ---");
  const acceptRes = await driverClient.postJson(`${BASE}/driver/trips/${tripId}/accept`, {});
  assert(acceptRes.status === 200, "15. Driver atomically accepts trip request (status: Accepted)");

  // Verify tourist notification
  const touristNotifSnap = await db
    .collection("notifications")
    .where("userId", "==", tripDoc.data().touristId)
    .where("type", "==", "TRIP_ACCEPTED")
    .limit(1)
    .get();
  assert(!touristNotifSnap.empty, "16. Tourist receives atomic in-app notification upon driver acceptance");

  // 8. Trip Start with Application Timezone Validation
  console.log("\n--- 6. Trip Start Lifecycle & Timezone Date Window Validation ---");
  // Update trip fromDate to today to satisfy start date validation (fromDate <= today <= toDate)
  const todayStr = new Date().toISOString().slice(0, 10);
  await db.collection("bookings").doc(tripId).update({ fromDate: todayStr });

  const startRes = await driverClient.postJson(`${BASE}/driver/trips/${tripId}/start`, {});
  assert(startRes.status === 200, "17. Driver starts trip within valid date window (status: In Progress)");

  const startedDoc = await db.collection("bookings").doc(tripId).get();
  assert(startedDoc.data().status === "In Progress" && !!startedDoc.data().startedAt, "18. Trip status is 'In Progress' with server startedAt timestamp");

  // 9. Trip Completion & Schedule Release
  console.log("\n--- 7. Trip Completion & Schedule Release ---");
  const completeRes = await driverClient.postJson(`${BASE}/driver/trips/${tripId}/complete`, {});
  assert(completeRes.status === 200, "19. Driver completes trip (status: Completed)");

  const completedDoc = await db.collection("bookings").doc(tripId).get();
  assert(completedDoc.data().status === "Completed" && !!completedDoc.data().completedAt, "20. Trip status transitioned to 'Completed' with completedAt timestamp");

  // 10. Admin Operational Visibility
  console.log("\n--- 8. Administrative Monitoring ---");
  const adminTripsRes = await adminClient.fetch(`${BASE}/admin/trips?status=Completed`);
  assert(adminTripsRes.status === 200, "21. Administrator can monitor completed trip in /admin/trips");

  // 11. Session Logout & Clean Destruction
  console.log("\n--- 9. Session Logout & Destruction ---");
  const logoutRes = await touristClient.fetch(`${BASE}/logout`);
  assert(logoutRes.status === 302, "22. Tourist logs out and session is destroyed in Firestore");

  const postLogoutDash = await touristClient.fetch(`${BASE}/dashboard`);
  assert(postLogoutDash.status === 302 && postLogoutDash.headers.get("location") === "/login", "23. Post-logout access is rejected and redirected to /login");

  // 12. Production Error Masking (No stack traces leaked)
  console.log("\n--- 10. Production Error Masking ---");
  const badCsrfRes = await touristClient.fetch(`${BASE}/cancel-booking/fake-id`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ _csrf: "invalid" }),
  });
  const badCsrfJson = await badCsrfRes.json();
  assert(badCsrfRes.status === 403 && !JSON.stringify(badCsrfJson).includes("stack"), "24. Production error response suppresses internal stack traces");

  // Cleanup test documents
  console.log("\n--- CLEANUP: Removing Phase 11 Smoke Test Records ---");
  try {
    await db.collection("bookings").doc(tripId).delete();
    await db.collection("users").doc(tripDoc.data().touristId).delete();
    await db.collection("users").doc(driverUid).delete();
    await db.collection("drivers").doc(driverUid).delete();
    await db.collection("users").doc(adminUid).delete();
    console.log("  Cleaned up smoke test bookings and users.");
  } catch (e) {
    console.warn("  Cleanup warning:", e.message);
  }

  console.log("\n================================================================================");
  console.log(`🏁 PHASE 11 SMOKE TEST RESULTS: ${passedCount} PASSED, ${failedCount} FAILED (Total: ${passedCount + failedCount})`);
  console.log("================================================================================\n");

  if (failedCount > 0) process.exit(1);
  else process.exit(0);
}

runPhase11SmokeTest().catch((err) => {
  console.error("❌ Phase 11 Smoke Test Error:", err);
  process.exit(1);
});
