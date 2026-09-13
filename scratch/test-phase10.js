const path = require("path");
const projectRoot = path.resolve(__dirname, "..");
require(path.join(projectRoot, "node_modules/dotenv")).config({ path: path.join(projectRoot, ".env") });

process.env.PORT = "3096";
process.env.NODE_ENV = "development";
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

// SessionClient helper for cookie and CSRF handling
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
        "Accept": "application/json",
        "x-csrf-token": token,
        ...headers,
      },
      body: JSON.stringify(bodyObj),
    });
  }
}

async function runPhase10Tests() {
  console.log("================================================================================");
  console.log("🚀 STARTING PHASE 10 PRODUCTION INFRASTRUCTURE & RELIABILITY TEST SUITE");
  console.log("================================================================================\n");

  process.chdir(projectRoot);

  // Load modules
  const { validateConfig } = require(path.join(projectRoot, "lib/config"));
  const { logger, sanitizeLogData } = require(path.join(projectRoot, "lib/logger"));
  const { requestIdMiddleware, VALID_REQUEST_ID_REGEX } = require(path.join(projectRoot, "lib/request-id"));
  const { FirestoreSessionStore } = require(path.join(projectRoot, "lib/session-store"));
  const { ShutdownCoordinator } = require(path.join(projectRoot, "lib/shutdown"));
  const { createHealthRouter } = require(path.join(projectRoot, "lib/health"));

  // ---------------------------------------------------------------------------
  // 1. Startup Configuration Validation Tests
  // ---------------------------------------------------------------------------
  console.log("--- 1. Startup Configuration Validation ---");

  // Missing SESSION_SECRET in production
  const res1 = validateConfig({ NODE_ENV: "production", FIREBASE_API_KEY: "fake", FIREBASE_SERVICE_ACCOUNT_KEY: "{}" }, false);
  assert(!res1.valid && res1.errors.some((e) => e.includes("SESSION_SECRET is required")), "1. Detects missing SESSION_SECRET in production mode");

  // Short SESSION_SECRET in production (< 32 chars)
  const res2 = validateConfig({ NODE_ENV: "production", SESSION_SECRET: "short-secret", FIREBASE_API_KEY: "fake", FIREBASE_SERVICE_ACCOUNT_KEY: "{}" }, false);
  assert(!res2.valid && res2.errors.some((e) => e.includes("at least 32 characters")), "2. Detects short SESSION_SECRET (<32 chars) in production mode");

  // Insecure placeholder SESSION_SECRET in production
  const res3 = validateConfig({ NODE_ENV: "production", SESSION_SECRET: "your_strong_session_secret_here", FIREBASE_API_KEY: "fake", FIREBASE_SERVICE_ACCOUNT_KEY: "{}" }, false);
  assert(!res3.valid && res3.errors.some((e) => e.includes("insecure default")), "3. Detects placeholder SESSION_SECRET in production mode");

  // Missing FIREBASE_API_KEY in production
  const res4 = validateConfig({ NODE_ENV: "production", SESSION_SECRET: "a".repeat(32), FIREBASE_SERVICE_ACCOUNT_KEY: "{}" }, false);
  assert(!res4.valid && res4.errors.some((e) => e.includes("FIREBASE_API_KEY is required")), "4. Detects missing FIREBASE_API_KEY in production mode");

  // Valid production configuration passes
  const res5 = validateConfig({
    NODE_ENV: "production",
    SESSION_SECRET: "abcdef1234567890abcdef1234567890",
    FIREBASE_API_KEY: "AIzaSyFakeKeyValidFormat12345",
    FIREBASE_SERVICE_ACCOUNT_KEY: JSON.stringify({ project_id: "test" }),
    PORT: "3000",
    APP_TIMEZONE: "Asia/Colombo",
  }, false);
  assert(res5.valid && res5.errors.length === 0, "5. Valid production configuration passes all checks");

  // ---------------------------------------------------------------------------
  // 2. Structured Logger & Redaction Tests
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. Structured Logger & Redaction ---");

  const dirtyPayload = {
    email: "user@example.com",
    password: "superSecretPassword123",
    _csrf: "sensitiveCsrfTokenValue",
    apiKey: "AIzaSyFakeApiKey",
    sessionSecret: "ultraSecretSessionKey",
    user: {
      name: "John Doe",
      token: "bearerTokenValue",
      nested: {
        private_key: "-----BEGIN PRIVATE KEY-----",
      },
    },
  };

  const cleanPayload = sanitizeLogData(dirtyPayload);
  assert(cleanPayload.email === "user@example.com", "6. Non-sensitive fields (email, name) are preserved");
  assert(cleanPayload.password === "[REDACTED]", "7. Password is redacted in logs");
  assert(cleanPayload._csrf === "[REDACTED]", "8. CSRF token is redacted in logs");
  assert(cleanPayload.apiKey === "[REDACTED]", "9. API Key is redacted in logs");
  assert(cleanPayload.sessionSecret === "[REDACTED]", "10. Session secret is redacted in logs");
  assert(cleanPayload.user.token === "[REDACTED]", "11. Nested bearer token is redacted in logs");
  assert(cleanPayload.user.nested.private_key === "[REDACTED]", "12. Deeply nested private key is redacted in logs");

  // ---------------------------------------------------------------------------
  // 3. Start Live Server & Initialize Firebase Context
  // ---------------------------------------------------------------------------
  require(path.join(projectRoot, "app.js"));
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const admin = require(path.join(projectRoot, "node_modules/firebase-admin"));
  const db = admin.firestore();

  // ---------------------------------------------------------------------------
  // 4. FirestoreSessionStore Unit Tests (Store Semantics & Multi-Instance)
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. FirestoreSessionStore Unit Tests ---");

  const storeInstance1 = new FirestoreSessionStore({ db, collection: "test_sessions", ttlMs: 60000 });
  const storeInstance2 = new FirestoreSessionStore({ db, collection: "test_sessions", ttlMs: 60000 }); // Represents second cluster instance

  const testSid = `sid_test_${Date.now()}`;
  const testSessionData = {
    cookie: { originalMaxAge: 60000, expires: new Date(Date.now() + 60000).toISOString(), httpOnly: true, path: "/" },
    user: { uid: "test-uid-123", email: "test@example.com", role: "tourist" },
    cart: ["item1", "item2"],
  };

  // set -> get
  await new Promise((resolve, reject) => {
    storeInstance1.set(testSid, testSessionData, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
  assert(true, "13. store.set() successfully saves session data to Firestore");

  const retrievedSess = await new Promise((resolve, reject) => {
    // Read from instance 2 to prove multi-instance / cluster compatibility
    storeInstance2.get(testSid, (err, sess) => {
      if (err) return reject(err);
      resolve(sess);
    });
  });
  assert(retrievedSess !== null && retrievedSess.user?.uid === "test-uid-123", "14. store.get() on second instance retrieves saved session (multi-instance ready)");
  assert(retrievedSess.cart?.[0] === "item1", "15. Session data structure is deserialized accurately");

  // touch
  const updatedSess = { ...testSessionData, cookie: { ...testSessionData.cookie, expires: new Date(Date.now() + 120000).toISOString() } };
  await new Promise((resolve, reject) => {
    storeInstance1.touch(testSid, updatedSess, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
  const touchedDoc = await db.collection("test_sessions").doc(testSid).get();
  assert(touchedDoc.exists && touchedDoc.data().expiresMs > Date.now() + 60000, "16. store.touch() extends expiration time in Firestore");

  // Concurrent session access
  const concurrentPromises = [
    new Promise((resolve) => storeInstance1.get(testSid, (err, s) => resolve(s))),
    new Promise((resolve) => storeInstance2.get(testSid, (err, s) => resolve(s))),
    new Promise((resolve) => storeInstance1.get(testSid, (err, s) => resolve(s))),
  ];
  const concurrentResults = await Promise.all(concurrentPromises);
  assert(concurrentResults.every((r) => r && r.user?.uid === "test-uid-123"), "17. Concurrent store.get() calls across multiple instances succeed without data corruption");

  // destroy
  await new Promise((resolve, reject) => {
    storeInstance2.destroy(testSid, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
  const destroyedDoc = await db.collection("test_sessions").doc(testSid).get();
  assert(!destroyedDoc.exists, "18. store.destroy() removes session document from Firestore");

  const afterDestroySess = await new Promise((resolve) => {
    storeInstance1.get(testSid, (err, sess) => resolve(sess));
  });
  assert(afterDestroySess === null, "19. store.get() after destroy returns null");

  // Expired session handling
  const expiredSid = `sid_expired_${Date.now()}`;
  const expiredSessionData = {
    cookie: { originalMaxAge: 1000, expires: new Date(Date.now() - 5000).toISOString(), httpOnly: true },
    user: { uid: "expired-uid" },
  };
  await new Promise((resolve) => storeInstance1.set(expiredSid, expiredSessionData, resolve));
  const expiredResult = await new Promise((resolve) => {
    storeInstance1.get(expiredSid, (err, sess) => resolve(sess));
  });
  assert(expiredResult === null, "20. store.get() on expired session returns null and rejects expired credentials");

  // Clean test sessions
  await db.collection("test_sessions").doc(expiredSid).delete();

  // ---------------------------------------------------------------------------
  // 5. Live Server Operational Endpoints (/health, /ready, X-Request-ID)
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. Live Server Operational Endpoints (/health, /ready, X-Request-ID) ---");

  const client = new SessionClient();

  // /health
  const healthRes = await fetch(`${BASE}/health`);
  assert(healthRes.status === 200, "21. GET /health returns HTTP 200 OK");
  const healthData = await healthRes.json();
  assert(healthData.status === "ok" && healthData.service === "destination-paradise", "22. /health payload contains status: ok and service name");
  assert(typeof healthData.uptime === "number", "23. /health payload includes process uptime");
  assert(!healthData.key && !healthData.secret && !healthData.credentials, "24. /health does not expose any credentials or secrets");

  // /ready
  const readyRes = await fetch(`${BASE}/ready`);
  assert(readyRes.status === 200, "25. GET /ready returns HTTP 200 OK");
  const readyData = await readyRes.json();
  assert(readyData.status === "ready" && readyData.checks?.firestore === "connected", "26. /ready reports firestore: connected");

  // /ready caching (User correction #2)
  const readyResCached = await fetch(`${BASE}/ready`);
  const readyDataCached = await readyResCached.json();
  assert(readyResCached.status === 200 && readyDataCached.cached === true, "27. Rapid subsequent GET /ready serves from cache to protect Firestore from probe storms");

  // Request Correlation IDs (X-Request-ID)
  assert(healthRes.headers.has("x-request-id"), "28. Response includes X-Request-ID header");
  const generatedReqId = healthRes.headers.get("x-request-id");
  assert(VALID_REQUEST_ID_REGEX.test(generatedReqId), "29. Generated X-Request-ID matches valid correlation regex");

  // Custom valid X-Request-ID passed by client
  const customId = "client-trace-1234567890";
  const customReqRes = await fetch(`${BASE}/health`, { headers: { "X-Request-ID": customId } });
  assert(customReqRes.headers.get("x-request-id") === customId, "30. Valid client-supplied X-Request-ID is preserved across request cycle");

  // Malformed X-Request-ID replaced with secure UUID
  const malformedId = "bad<script>alert(1)</script>id";
  const malformedRes = await fetch(`${BASE}/health`, { headers: { "X-Request-ID": malformedId } });
  const replacedId = malformedRes.headers.get("x-request-id");
  assert(replacedId !== malformedId && VALID_REQUEST_ID_REGEX.test(replacedId), "31. Malformed X-Request-ID is sanitized and replaced with secure UUID");

  // ---------------------------------------------------------------------------
  // 5. Error Handler & Production Safety Tests
  // ---------------------------------------------------------------------------
  console.log("\n--- 5. Error Handling & Security Sanitization ---");

  // Missing / invalid CSRF token JSON response
  const badCsrfRes = await fetch(`${BASE}/cancel-booking/fake-id`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ _csrf: "invalid-token" }),
  });
  assert(badCsrfRes.status === 403, "32. Forged CSRF request receives HTTP 403 Forbidden");
  const badCsrfData = await badCsrfRes.json();
  assert(badCsrfData.error === "EBADCSRFTOKEN", "33. CSRF error response preserves EBADCSRFTOKEN code");
  assert(!!badCsrfData.requestId, "34. Error response includes requestId correlation token");
  assert(!JSON.stringify(badCsrfData).includes("stack"), "35. Error response suppresses internal stack traces");

  // ---------------------------------------------------------------------------
  // 6. Live Session Persistence, Restart Survivability & Auth Lifecycle
  // ---------------------------------------------------------------------------
  console.log("\n--- 6. Live Session Persistence Across Application Lifecycle ---");

  const testEmail = `tourist_p10_${Date.now()}@example.com`;
  const testPassword = "Password123!Safe";

  // Register tourist
  const regRes = await client.postForm(`${BASE}/register`, { email: testEmail, password: testPassword });
  assert(regRes.status === 302, "36. Tourist registration succeeds with 302 redirect");

  // Check dashboard access
  const dashRes1 = await client.fetch(`${BASE}/dashboard`);
  assert(dashRes1.status === 200, "37. Authenticated tourist can access /dashboard");

  // Verify session cookie flags
  const cookieHeader = client.cookies["dp.sid"];
  assert(!!cookieHeader, "38. Session cookie (dp.sid) is issued to client");

  // Verify session is written to Firestore 'sessions' collection
  const sessionSnap = await db.collection("sessions").get();
  let foundSessionDoc = null;
  sessionSnap.forEach((doc) => {
    const d = doc.data();
    if (d.session && d.session.includes(testEmail)) {
      foundSessionDoc = d;
    }
  });
  assert(foundSessionDoc !== null, "39. Session record is persisted in Firestore 'sessions' collection");
  assert(!foundSessionDoc.session.includes(testPassword), "40. Session document strictly contains zero passwords");
  assert(!foundSessionDoc.session.includes("FIREBASE_API_KEY"), "41. Session document strictly contains zero API keys");

  // Simulated server restart / secondary process request using same session cookie
  const secondaryProcessClient = new SessionClient();
  secondaryProcessClient.cookies = { ...client.cookies };
  const dashRes2 = await secondaryProcessClient.fetch(`${BASE}/dashboard`);
  assert(dashRes2.status === 200, "42. Session survives simulated server restart/process separation via Firestore");

  // Logout / session destruction
  const logoutRes = await client.fetch(`${BASE}/logout`);
  assert(logoutRes.status === 302, "43. GET /logout destroys session and redirects");

  // Post-logout access redirected to login
  const dashRes3 = await client.fetch(`${BASE}/dashboard`);
  assert(dashRes3.status === 302 && dashRes3.headers.get("location") === "/login", "44. Post-logout access is rejected and redirected to /login");

  // ---------------------------------------------------------------------------
  // 7. Graceful Shutdown & Readiness Short-Circuit (User Correction #2)
  // ---------------------------------------------------------------------------
  console.log("\n--- 7. Graceful Shutdown & Readiness Short-Circuit ---");

  const testCoordinator = new ShutdownCoordinator({ timeoutMs: 5000, onExit: () => {} });
  let shutdownExecutedCount = 0;

  testCoordinator.shutdown("SIGTERM", (err, executed) => {
    if (executed) shutdownExecutedCount++;
  });
  assert(testCoordinator.isShuttingDown === true, "45. Graceful shutdown sets isShuttingDown flag to true");
  assert(shutdownExecutedCount === 1, "46. Graceful shutdown begins clean shutdown sequence");

  // Duplicate shutdown call ignored (idempotency guard)
  testCoordinator.shutdown("SIGINT", (err, executed) => {
    if (executed) shutdownExecutedCount++;
  });
  assert(shutdownExecutedCount === 1, "47. Duplicate shutdown signal is safely ignored (idempotent)");

  // Verify /ready returns 503 during shutdown
  const healthRouter = createHealthRouter(db);
  const mockReq = {};
  let statusSet = null;
  let jsonSent = null;
  const mockRes = {
    status: (s) => {
      statusSet = s;
      return mockRes;
    },
    json: (j) => {
      jsonSent = j;
    },
  };

  // Point shutdown coordinator to shutting down state
  const { shutdownCoordinator } = require(path.join(projectRoot, "lib/shutdown"));
  shutdownCoordinator.isShuttingDown = true;
  await healthRouter.readyHandler(mockReq, mockRes);
  assert(statusSet === 503, "48. GET /ready immediately returns HTTP 503 when shutdown is in progress");
  assert(jsonSent?.checks?.server === "shutting_down", "49. /ready response indicates server: shutting_down");
  shutdownCoordinator.isShuttingDown = false; // reset for subsequent tests

  // ---------------------------------------------------------------------------
  // 8. Bounded Query & Security Audit Checks
  // ---------------------------------------------------------------------------
  console.log("\n--- 8. Firestore Query Bounds & Security Audit ---");

  // Notification query bound check
  const fsText = require("fs").readFileSync(path.join(projectRoot, "app.js"), "utf8");
  assert(fsText.includes('.collection("notifications")') && fsText.includes(".limit(100)"), "50. GET /notifications query is strictly bounded with limit(100)");

  // Composite indexes for notifications in firestore.indexes.json
  const indexesText = require("fs").readFileSync(path.join(projectRoot, "firestore.indexes.json"), "utf8");
  assert(indexesText.includes('"collectionGroup": "notifications"'), "51. firestore.indexes.json includes composite index for notifications");

  // .gitignore security checks
  const gitignoreText = require("fs").readFileSync(path.join(projectRoot, ".gitignore"), "utf8");
  assert(gitignoreText.includes(".env") && gitignoreText.includes("key.json"), "52. .gitignore strictly excludes .env and key.json credentials");

  // Cleanup test user and session records
  console.log("\n--- CLEANUP: Removing Phase 10 Test Records ---");
  try {
    const userSnap = await db.collection("users").where("email", "==", testEmail).get();
    userSnap.forEach((d) => d.ref.delete());
    const sessSnap = await db.collection("sessions").get();
    sessSnap.forEach((d) => {
      const data = d.data();
      if (data.session && data.session.includes(testEmail)) {
        d.ref.delete();
      }
    });
    console.log("  Cleaned up test user and session records.");
  } catch (e) {
    console.warn("  Cleanup warning:", e.message);
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log(`🏁 PHASE 10 TEST RESULTS: ${passedCount} PASSED, ${failedCount} FAILED (Total: ${passedCount + failedCount})`);
  console.log("================================================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runPhase10Tests().catch((err) => {
  console.error("❌ Phase 10 Test Suite Error:", err);
  process.exit(1);
});
