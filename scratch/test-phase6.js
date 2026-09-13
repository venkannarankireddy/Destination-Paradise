const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const path = require("path");
const projectRoot = path.resolve(__dirname, "..");

require(path.join(projectRoot, "node_modules/dotenv")).config({ path: path.join(projectRoot, ".env") });

process.env.PORT = "3090";
const BASE = `http://localhost:${process.env.PORT}`;

async function runPhase6Tests() {
  console.log("================================================================================");
  console.log("🛡️  STARTING PHASE 6 PRODUCTION HARDENING, SECURITY & VALIDATION TEST SUITE");
  console.log("================================================================================\n");

  process.chdir(projectRoot);
  require(path.join(projectRoot, "app.js"));

  // Wait 1.5s for Express and Firestore to initialize
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const admin = require(path.join(projectRoot, "node_modules/firebase-admin"));
  const db = admin.firestore();

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

  // Cookie jar helper for maintaining session and CSRF cookies
  class SessionClient {
    constructor() {
      this.cookies = {};
    }

    updateCookies(response) {
      // Handles multiple set-cookie headers
      const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
      if (setCookies.length === 0) {
        const raw = response.headers.get("set-cookie");
        if (raw) setCookies.push(raw);
      }
      for (const str of setCookies) {
        const pair = str.split(";")[0];
        const [k, v] = pair.split("=");
        if (k && v) {
          this.cookies[k.trim()] = v.trim();
        }
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

    async get(url, headers = {}) {
      const res = await fetch(url, {
        headers: { Cookie: this.getCookieHeader(), ...headers },
        redirect: "manual",
      });
      this.updateCookies(res);
      return res;
    }

    async post(url, body, isJson = false, extraHeaders = {}) {
      const headers = { Cookie: this.getCookieHeader(), ...extraHeaders };
      let reqBody;

      if (isJson) {
        headers["Content-Type"] = "application/json";
        reqBody = typeof body === "string" ? body : JSON.stringify(body);
      } else {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        reqBody = body instanceof URLSearchParams ? body.toString() : new URLSearchParams(body).toString();
      }

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: reqBody,
        redirect: "manual",
      });
      this.updateCookies(res);
      return res;
    }
  }

  const timestamp = Date.now();
  const createdTripIds = [];
  const createdUserUids = [];

  try {
    // =========================================================================
    // TEST GROUP 1: SECURITY HEADERS (HELMET)
    // =========================================================================
    console.log("--- 1. HTTP Security Headers (Helmet) ---");
    const homeRes = await fetch(`${BASE}/`);
    const csp = homeRes.headers.get("content-security-policy");
    const nosniff = homeRes.headers.get("x-content-type-options");
    const frameOptions = homeRes.headers.get("x-frame-options");

    assert(!!csp, "Content-Security-Policy header is present");
    assert(csp && csp.includes("default-src 'self'"), "CSP restricts default-src to 'self'");
    assert(csp && csp.includes("identitytoolkit.googleapis.com"), "CSP whitelists Google Identity Toolkit");
    assert(nosniff === "nosniff", "X-Content-Type-Options is set to 'nosniff'");
    assert(frameOptions === "SAMEORIGIN", "X-Frame-Options is set to 'SAMEORIGIN'");

    // =========================================================================
    // TEST GROUP 2: CSRF PROTECTION (csrf-csrf)
    // =========================================================================
    console.log("\n--- 2. CSRF Token Protection ---");
    const unauthClient = new SessionClient();

    // 2.1 Missing CSRF token
    const noCsrfRes = await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "bad@example.com", password: "password123" }),
      redirect: "manual",
    });
    assert(noCsrfRes.status === 403, `Missing CSRF token rejected with 403 Forbidden (got ${noCsrfRes.status})`);

    // 2.2 Invalid / Tampered CSRF token
    const badTokenRes = await fetch(`${BASE}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-CSRF-Token": "invalid_fake_token_123456",
      },
      body: new URLSearchParams({ email: "bad@example.com", password: "password123" }),
      redirect: "manual",
    });
    assert(badTokenRes.status === 403, `Invalid CSRF token rejected with 403 Forbidden (got ${badTokenRes.status})`);

    // 2.3 Fetch valid CSRF token
    const client = new SessionClient();
    const token = await client.getCsrfToken();
    assert(!!token && token.length > 20, `Retrieved valid CSRF token from /csrf-token (${token.substring(0, 15)}...)`);
    assert(!!client.cookies["dp.x-csrf-token"], "CSRF cookie 'dp.x-csrf-token' was set in client");

    // =========================================================================
    // TEST GROUP 3: SESSION SECURITY & FIXATION PROTECTION
    // =========================================================================
    console.log("\n--- 3. Session Security & Fixation Protection ---");
    const touristClient = new SessionClient();
    const preLoginToken = await touristClient.getCsrfToken();
    const preLoginSessionCookie = touristClient.cookies["dp.sid"];

    const touristEmail = `tourist_p6_${timestamp}@example.com`;
    const regRes = await touristClient.post(`${BASE}/register`, {
      email: touristEmail,
      password: "password123",
      _csrf: preLoginToken,
    });
    assert(regRes.status === 302, `Tourist registered successfully (status: ${regRes.status})`);
    const postLoginSessionCookie = touristClient.cookies["dp.sid"];
    assert(
      !!postLoginSessionCookie && postLoginSessionCookie !== preLoginSessionCookie,
      `Session ID regenerated on authentication (Fixation protected: ${preLoginSessionCookie} -> ${postLoginSessionCookie})`
    );

    const touristSnap = await db.collection("users").where("email", "==", touristEmail).get();
    const touristUid = touristSnap.docs[0].id;
    createdUserUids.push(touristUid);

    // =========================================================================
    // TEST GROUP 4: INPUT VALIDATION & SANITIZATION
    // =========================================================================
    console.log("\n--- 4. Input Validation & Sanitization ---");
    const tourToken = await touristClient.getCsrfToken();

    // 4.1 Unauthenticated booking attempt
    const anonRes = await unauthClient.post(`${BASE}/bookings`, {
      destination: "Goa",
      fromDate: "2026-10-01",
      toDate: "2026-10-05",
      people: 2,
      name: "Anon",
      email: "anon@example.com",
      countryCode: "+91",
      phone: "9876543210",
      maritalStatus: "single",
    }, true, { "X-CSRF-Token": await unauthClient.getCsrfToken() });
    assert(anonRes.status === 401, `Unauthenticated booking rejected with 401 (got ${anonRes.status})`);

    // Helper for tourist JSON booking
    async function submitBooking(overrides = {}) {
      const t = await touristClient.getCsrfToken();
      const payload = {
        destination: "Goa Beach Resort",
        fromDate: "2026-11-10",
        toDate: "2026-11-15",
        people: 4,
        name: "Verified Tourist",
        email: touristEmail,
        countryCode: "+91",
        phone: "9876543210",
        maritalStatus: "married",
        _csrf: t,
        ...overrides,
      };
      return touristClient.post(`${BASE}/bookings`, payload, true, { "X-CSRF-Token": t });
    }

    // 4.2 Malformed date format
    const badDateRes = await submitBooking({ fromDate: "10/11/2026" });
    assert(badDateRes.status === 400, `Malformed fromDate rejected with 400 (got ${badDateRes.status})`);

    // 4.3 Past date
    const pastDateRes = await submitBooking({ fromDate: "2020-01-01", toDate: "2020-01-05" });
    assert(pastDateRes.status === 400, `Past fromDate rejected with 400 (got ${pastDateRes.status})`);

    // 4.4 toDate <= fromDate
    const dateOrderRes = await submitBooking({ fromDate: "2026-11-15", toDate: "2026-11-10" });
    assert(dateOrderRes.status === 400, `toDate <= fromDate rejected with 400 (got ${dateOrderRes.status})`);

    // 4.5 Invalid people count (0 or > 20)
    const zeroPeopleRes = await submitBooking({ people: 0 });
    assert(zeroPeopleRes.status === 400, `Zero people count rejected with 400 (got ${zeroPeopleRes.status})`);

    const tooManyPeopleRes = await submitBooking({ people: 25 });
    assert(tooManyPeopleRes.status === 400, `Excessive people count (>20) rejected with 400 (got ${tooManyPeopleRes.status})`);

    // 4.6 Invalid phone
    const badPhoneRes = await submitBooking({ phone: "123" });
    assert(badPhoneRes.status === 400, `Invalid phone (< 7 digits) rejected with 400 (got ${badPhoneRes.status})`);

    // 4.7 Invalid country code
    const badCountryRes = await submitBooking({ countryCode: "invalid-code" });
    assert(badCountryRes.status === 400, `Unsupported country code rejected with 400 (got ${badCountryRes.status})`);

    // =========================================================================
    // TEST GROUP 5: DUPLICATE BOOKING & WHITELIST WRITES
    // =========================================================================
    console.log("\n--- 5. Duplicate Submission Protection & Strict Whitelisting ---");
    
    // First valid submission
    const validBookRes = await submitBooking({
      destination: "Ooty Hills",
      fromDate: "2026-12-01",
      toDate: "2026-12-05",
      people: 3,
      adminRole: true, // Injection attempt
      isPaid: true,    // Injection attempt
    });
    assert(validBookRes.status === 200, `Valid trip request accepted with 200 (got ${validBookRes.status})`);

    // Fetch the created booking from Firestore
    const ootySnap = await db.collection("bookings")
      .where("email", "==", touristEmail)
      .where("destination", "==", "Ooty Hills")
      .get();
    
    assert(ootySnap.size === 1, "Trip request was persisted to Firestore");
    const ootyData = ootySnap.docs[0].data();
    createdTripIds.push(ootySnap.docs[0].id);

    assert(ootyData.status === "Requested", "Initial trip status is strictly 'Requested'");
    assert(ootyData.driverId === null, "Initial driverId is strictly null");
    assert(ootyData.adminRole === undefined, "Whitelisting prevented 'adminRole' injection");
    assert(ootyData.isPaid === undefined, "Whitelisting prevented 'isPaid' injection");
    assert(ootyData.touristId === touristUid, "touristId strictly matches authenticated session UID");

    // Immediate duplicate booking attempt (within 60s)
    const dupRes = await submitBooking({
      destination: "Ooty Hills",
      fromDate: "2026-12-01",
      toDate: "2026-12-05",
      people: 3,
    });
    assert(dupRes.status === 409 || dupRes.status === 429, `Rapid duplicate trip request rejected with 409/429 (got ${dupRes.status})`);

    // =========================================================================
    // TEST GROUP 6: DRIVER ONBOARDING & INPUT VALIDATION
    // =========================================================================
    console.log("\n--- 6. Driver Onboarding, Validation & Profile ---");
    const driverClient = new SessionClient();
    const driverToken = await driverClient.getCsrfToken();
    const driverEmail = `driver_p6_${timestamp}@example.com`;

    // 6.1 Driver registration validation: capacity < 4
    const badCapRes = await driverClient.post(`${BASE}/driver/register`, {
      name: "Driver Test",
      email: `badcap_${timestamp}@example.com`,
      password: "driverPassword123",
      phone: "+91 9876500001",
      licenseNumber: "DL-P6-BAD",
      vanModel: "Mini Van",
      vanNumber: "TS 09 XY 0001",
      seatingCapacity: "2",
      experienceYears: "3",
      _csrf: driverToken,
    });
    assert(badCapRes.status === 400, `Driver seatingCapacity < 4 rejected with 400 (got ${badCapRes.status})`);

    // 6.2 Driver registration validation: experience > 60
    const badExpRes = await driverClient.post(`${BASE}/driver/register`, {
      name: "Driver Test",
      email: `badexp_${timestamp}@example.com`,
      password: "driverPassword123",
      phone: "+91 9876500002",
      licenseNumber: "DL-P6-BAD",
      vanModel: "Van",
      vanNumber: "TS 09 XY 0002",
      seatingCapacity: "10",
      experienceYears: "75",
      _csrf: await driverClient.getCsrfToken(),
    });
    assert(badExpRes.status === 400, `Driver experience > 60 rejected with 400 (got ${badExpRes.status})`);

    // 6.3 Valid driver registration
    const regDriverRes = await driverClient.post(`${BASE}/driver/register`, {
      name: "Suresh P6 Driver",
      email: driverEmail,
      password: "driverPassword123",
      phone: "+91 9876511111",
      licenseNumber: "DL-P6-12345",
      vanModel: "Force Urbania (14 Seats)",
      vanNumber: "TS 09 AB 9999",
      seatingCapacity: "14",
      experienceYears: "7",
      _csrf: await driverClient.getCsrfToken(),
    });
    assert(regDriverRes.status === 302, `Valid driver registered successfully (status: ${regDriverRes.status})`);

    const driverSnap = await db.collection("drivers").where("email", "==", driverEmail).get();
    const driverUid = driverSnap.docs[0].id;
    createdUserUids.push(driverUid);
    await db.collection("drivers").doc(driverUid).update({ verificationStatus: "verified" });

    // =========================================================================
    // TEST GROUP 7: DRIVER AVAILABILITY & OVERLAP PREVENTION
    // =========================================================================
    console.log("\n--- 7. Driver Availability Management ---");
    const dToken = await driverClient.getCsrfToken();

    // 7.1 Add availability window: 2026-12-01 to 2026-12-10
    const addAvailRes = await driverClient.post(`${BASE}/driver/availability`, {
      fromDate: "2026-12-01",
      toDate: "2026-12-10",
      status: "available",
      _csrf: dToken,
    });
    assert(addAvailRes.status === 302, `Availability window added (status: ${addAvailRes.status})`);

    // 7.2 Attempt overlapping availability window
    const overlapAvailRes = await driverClient.post(`${BASE}/driver/availability`, {
      fromDate: "2026-12-05",
      toDate: "2026-12-15",
      status: "available",
      _csrf: await driverClient.getCsrfToken(),
    });
    assert(
      overlapAvailRes.status === 302 && overlapAvailRes.headers.get("location").includes("err="),
      "Overlapping availability window rejected with error in redirect"
    );

    // =========================================================================
    // TEST GROUP 8: END-TO-END MARKETPLACE & TRANSACTIONAL ACCEPTANCE
    // =========================================================================
    console.log("\n--- 8. Marketplace Discovery & Atomic Acceptance ---");

    // 8.1 Driver checks marketplace: Ooty trip (Dec 1-5, 3 people) matches Dec 1-10 availability (14 seats)
    const marketplaceRes = await driverClient.get(`${BASE}/driver/trips`);
    assert(marketplaceRes.status === 200, `Marketplace loaded with 200 OK`);
    const marketHtml = await marketplaceRes.text();
    assert(marketHtml.includes("Ooty Hills"), "Matching Ooty trip request appears in driver marketplace");

    // 8.2 Driver accepts Ooty trip
    const acceptRes = await driverClient.post(`${BASE}/driver/trips/${ootySnap.docs[0].id}/accept`, {
      _csrf: await driverClient.getCsrfToken(),
    }, false, { Accept: "application/json" });
    assert(acceptRes.status === 200, `Trip accepted atomically with 200 OK (got ${acceptRes.status})`);

    // 8.3 Verify trip in Firestore
    const acceptedDoc = await db.collection("bookings").doc(ootySnap.docs[0].id).get();
    const acceptedData = acceptedDoc.data();
    assert(acceptedData.status === "Accepted", "Trip status transitioned to 'Accepted'");
    assert(acceptedData.driverId === driverUid, "Trip driverId assigned to authenticated driver UID");
    assert(acceptedData.driverName === "Suresh P6 Driver", "Driver snapshot stored on trip");
    assert(acceptedData.vanNumber === "TS 09 AB 9999", "Vehicle plate snapshot stored on trip");

    // 8.4 Second acceptance attempt fails (already accepted)
    const doubleAcceptRes = await driverClient.post(`${BASE}/driver/trips/${ootySnap.docs[0].id}/accept`, {
      _csrf: await driverClient.getCsrfToken(),
    }, false, { Accept: "application/json" });
    assert(doubleAcceptRes.status === 400, `Re-accepting accepted trip rejected with 400 (got ${doubleAcceptRes.status})`);

    // 8.5 Tourist checks dashboard and sees assigned driver
    const tourDashRes = await touristClient.get(`${BASE}/dashboard`);
    assert(tourDashRes.status === 200, "Tourist dashboard loaded with 200 OK");
    const dashHtml = await tourDashRes.text();
    assert(dashHtml.includes("Driver Assigned"), "Dashboard displays 'Driver Assigned' status badge");
    assert(dashHtml.includes("Suresh P6 Driver"), "Dashboard displays assigned driver name");
    assert(dashHtml.includes("TS 09 AB 9999"), "Dashboard displays vehicle plate number");

    // 8.6 Tourist cancels trip
    const cancelRes = await touristClient.post(`${BASE}/cancel-booking/${ootySnap.docs[0].id}`, {
      _csrf: await touristClient.getCsrfToken(),
    });
    assert(cancelRes.status === 302, `Tourist cancelled trip (status: ${cancelRes.status})`);
    const cancelledDoc = await db.collection("bookings").doc(ootySnap.docs[0].id).get();
    assert(cancelledDoc.data().status === "Cancelled", "Trip status is now 'Cancelled'");

    // =========================================================================
    // TEST GROUP 9: BACKWARD COMPATIBILITY WITH LEGACY BOOKINGS
    // =========================================================================
    console.log("\n--- 9. Legacy Bookings Compatibility ---");
    const legacyRef = db.collection("bookings").doc();
    createdTripIds.push(legacyRef.id);
    await legacyRef.set({
      bookingId: legacyRef.id,
      email: touristEmail,
      destination: "Legacy Goa Trip",
      fromDate: "2025-01-10",
      toDate: "2025-01-15",
      people: 2,
      name: "Legacy Traveler",
      countryCode: "+1",
      phone: "1234567890",
      status: "Confirmed", // Legacy Phase 1-3 status
      driverId: null,
      bookedAt: new Date("2025-01-01"),
    });

    const legacyDashRes = await touristClient.get(`${BASE}/dashboard`);
    const legacyHtml = await legacyDashRes.text();
    assert(legacyHtml.includes("Legacy Goa Trip"), "Legacy booking rendered on tourist dashboard");
    assert(legacyHtml.includes("Confirmed"), "Legacy 'Confirmed' badge displayed properly");

  } finally {
    // CLEANUP
    console.log("\n--- CLEANUP: Removing Test Records ---");
    for (const id of createdTripIds) {
      try {
        await db.collection("bookings").doc(id).delete();
      } catch (_) {}
    }
    for (const uid of createdUserUids) {
      try {
        await db.collection("users").doc(uid).delete();
        await db.collection("drivers").doc(uid).collection("availability").get().then((snap) => {
          snap.forEach((d) => d.ref.delete());
        });
        await db.collection("drivers").doc(uid).delete();
      } catch (_) {}
    }
    console.log(`Cleaned up ${createdTripIds.length} trip records and ${createdUserUids.length} test accounts.`);
  }

  console.log("\n================================================================================");
  console.log(`🏁 PHASE 6 TEST RESULTS: ${passedTests} PASSED, ${failedTests} FAILED (Total: ${passedTests + failedTests})`);
  console.log("================================================================================");

  if (failedTests > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runPhase6Tests().catch((err) => {
  console.error("❌ Test suite encountered unhandled error:", err);
  process.exit(1);
});
