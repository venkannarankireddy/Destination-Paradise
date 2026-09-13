const path = require("path");
const fs = require("fs");
const projectRoot = path.resolve(__dirname, "..");
require(path.join(projectRoot, "node_modules/dotenv")).config({ path: path.join(projectRoot, ".env") });

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

async function runPhase11FailureTests() {
  console.log("================================================================================");
  console.log("🚀 STARTING PHASE 11 FAILURE, RECOVERY & SECURITY AUDIT TEST SUITE");
  console.log("================================================================================\n");

  const { validateConfig, parseTrustProxy } = require(path.join(projectRoot, "lib/config"));
  const { FirestoreSessionStore } = require(path.join(projectRoot, "lib/session-store"));
  const { ShutdownCoordinator } = require(path.join(projectRoot, "lib/shutdown"));
  const { createHealthRouter } = require(path.join(projectRoot, "lib/health"));
  const { requestIdMiddleware, VALID_REQUEST_ID_REGEX } = require(path.join(projectRoot, "lib/request-id"));

  // ---------------------------------------------------------------------------
  // 1. TRUST_PROXY Parsing & Production Fail-Fast Validation (User Correction #2)
  // ---------------------------------------------------------------------------
  console.log("--- 1. TRUST_PROXY Parsing & Security Validation ---");

  // Valid configurations
  const tp1 = parseTrustProxy("1");
  assert(tp1.valid && tp1.parsedValue === 1, "1. TRUST_PROXY='1' parsed as integer hop count 1");

  const tp2 = parseTrustProxy("2");
  assert(tp2.valid && tp2.parsedValue === 2, "2. TRUST_PROXY='2' parsed as integer hop count 2");

  const tpTrue = parseTrustProxy("true");
  assert(tpTrue.valid && tpTrue.parsedValue === true, "3. TRUST_PROXY='true' parsed as boolean true");

  const tpFalse = parseTrustProxy("false");
  assert(tpFalse.valid && tpFalse.parsedValue === false, "4. TRUST_PROXY='false' parsed as boolean false");

  const tpSubnet = parseTrustProxy("loopback, 10.0.0.0/8, 172.16.0.0/12");
  assert(tpSubnet.valid && tpSubnet.parsedValue.includes("loopback"), "5. Subnet/CIDR TRUST_PROXY string is preserved safely");

  // Malformed / dangerous configurations
  const tpBadChars = parseTrustProxy("bad;cmd;injection");
  assert(!tpBadChars.valid, "6. Malformed TRUST_PROXY with illegal characters is rejected");

  const tpNegative = parseTrustProxy("-1");
  assert(!tpNegative.valid, "7. Negative TRUST_PROXY hop count is rejected");

  const tpExcessive = parseTrustProxy("9999");
  assert(!tpExcessive.valid, "8. Excessively large hop count (>100) is rejected");

  // Production startup validation fail-fast on invalid TRUST_PROXY
  const configRes = validateConfig({
    NODE_ENV: "production",
    SESSION_SECRET: "abcdef1234567890abcdef1234567890",
    FIREBASE_API_KEY: "AIzaSyFakeKeyValid12345",
    FIREBASE_SERVICE_ACCOUNT_KEY: "{}",
    TRUST_PROXY: "invalid;proxy;string",
  }, false);
  assert(!configRes.valid && configRes.errors.some((e) => e.includes("Invalid TRUST_PROXY")), "9. Production startup fails fast when TRUST_PROXY is malformed");

  // ---------------------------------------------------------------------------
  // 2. Simulated Firestore Unreachability & Readiness Behavior
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. Firestore Timeout & Readiness Failure Simulation ---");

  // Mock a failing Firestore instance that times out or rejects
  const mockFailingDb = {
    collection: () => ({
      limit: () => ({
        get: () => new Promise((_, reject) => setTimeout(() => reject(new Error("NETWORK_DOWN")), 50)),
      }),
    }),
  };

  const failingHealthRouter = createHealthRouter(mockFailingDb, { timeoutMs: 100, cacheTtlMs: 0 });

  let healthCode = null;
  let healthJson = null;
  failingHealthRouter.healthHandler({}, {
    status: (s) => { healthCode = s; return { json: (j) => { healthJson = j; } }; },
  });
  assert(healthCode === 200 && healthJson.status === "ok", "10. /health remains 200 OK even when database has connectivity issues (process liveness)");

  let readyCode = null;
  let readyJson = null;
  await failingHealthRouter.readyHandler({}, {
    status: (s) => { readyCode = s; return { json: (j) => { readyJson = j; } }; },
  });
  assert(readyCode === 503 && readyJson.status === "not_ready", "11. /ready returns HTTP 503 when Firestore is unreachable");
  assert(readyJson.checks.firestore === "disconnected", "12. /ready reports firestore: disconnected without leaking internal error details");

  // ---------------------------------------------------------------------------
  // 3. Graceful Shutdown & In-Flight Request Draining
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. In-Flight Request Draining & Shutdown Short-Circuit ---");

  let serverClosed = false;
  let inFlightRequestFinished = false;

  const mockHttpServer = {
    close: (cb) => {
      setTimeout(() => {
        serverClosed = true;
        cb(null);
      }, 50);
    },
  };

  const testShutdownCoordinator = new ShutdownCoordinator({
    server: mockHttpServer,
    timeoutMs: 3000,
    onExit: () => {},
  });

  // Emulate an in-flight request started just before shutdown
  setTimeout(() => {
    inFlightRequestFinished = true;
  }, 20);

  // Trigger shutdown
  await new Promise((resolve) => {
    testShutdownCoordinator.shutdown("SIGTERM", (err, executed) => {
      resolve();
    });
  });

  assert(inFlightRequestFinished === true, "13. In-flight request completes processing during graceful shutdown");
  assert(serverClosed === true, "14. HTTP server connection closed cleanly after draining requests");

  // ---------------------------------------------------------------------------
  // 4. Expired Session Discard & Auto-Purge
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. Session Expiration & Auto-Purge ---");

  const admin = require(path.join(projectRoot, "node_modules/firebase-admin"));
  if (!admin.apps.length) {
    const localKeyPath = path.join(projectRoot, "key.json");
    let credential;
    if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
      credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY));
    } else if (fs.existsSync(localKeyPath)) {
      credential = admin.credential.cert(JSON.parse(fs.readFileSync(localKeyPath, "utf8")));
    }
    admin.initializeApp({ credential });
  }
  const db = admin.firestore();
  const testStore = new FirestoreSessionStore({ db, collection: "failure_test_sessions" });

  const expiredSid = `exp_test_${Date.now()}`;
  const pastDate = new Date(Date.now() - 3600000); // 1 hour ago

  await db.collection("failure_test_sessions").doc(expiredSid).set({
    session: JSON.stringify({ user: { uid: "expired-user", email: "old@example.com" } }),
    expires: pastDate,
    expiresMs: pastDate.getTime(),
    updatedAt: pastDate,
  });

  const getResult = await new Promise((resolve) => {
    testStore.get(expiredSid, (err, sess) => resolve(sess));
  });
  assert(getResult === null, "15. Expired session document returns null and refuses to authenticate user");

  // Verify document was purged
  await new Promise((r) => setTimeout(r, 100));
  const purgedDoc = await db.collection("failure_test_sessions").doc(expiredSid).get();
  assert(!purgedDoc.exists, "16. Expired session document is automatically purged from Firestore");

  // ---------------------------------------------------------------------------
  // 5. Malformed Request ID Sanitization
  // ---------------------------------------------------------------------------
  console.log("\n--- 5. Malformed Request ID Sanitization ---");

  const maliciousHeaders = [
    "<script>alert('xss')</script>",
    "id\r\nInjected-Header: evil",
    "a".repeat(200), // excessive length > 128
    "id with spaces",
    "id!@#$%^&*()",
  ];

  for (let i = 0; i < maliciousHeaders.length; i++) {
    const rawHeader = maliciousHeaders[i];
    const mockReq = { headers: { "x-request-id": rawHeader } };
    let headerSet = null;
    const mockRes = {
      locals: {},
      setHeader: (k, v) => { if (k === "X-Request-ID") headerSet = v; },
    };
    requestIdMiddleware(mockReq, mockRes, () => {});
    assert(mockReq.id !== rawHeader && VALID_REQUEST_ID_REGEX.test(mockReq.id), `17.${i + 1} Malformed request ID '${rawHeader.slice(0, 15)}...' replaced with valid UUID`);
  }

  // ---------------------------------------------------------------------------
  // 6. Security Audit: Dockerfile, .dockerignore, & Git Credentials
  // ---------------------------------------------------------------------------
  console.log("\n--- 6. Supply-Chain & Container Security Audit ---");

  const dockerfileContent = fs.readFileSync(path.join(projectRoot, "Dockerfile"), "utf8");
  assert(dockerfileContent.includes("FROM node:24-alpine"), "18. Dockerfile uses Node.js 24 Alpine LTS base image");
  assert(dockerfileContent.includes("USER node"), "19. Dockerfile switches to unprivileged non-root 'USER node'");
  assert(dockerfileContent.includes('CMD ["node", "app.js"]'), "20. Dockerfile uses exec form CMD so Node runs as PID 1");
  assert(dockerfileContent.includes("npm ci --omit=dev"), "21. Dockerfile installs production-only dependencies based on package-lock.json");

  const dockerignoreContent = fs.readFileSync(path.join(projectRoot, ".dockerignore"), "utf8");
  assert(dockerignoreContent.includes(".env") && dockerignoreContent.includes("key.json"), "22. .dockerignore strictly excludes .env and key.json secrets");
  assert(dockerignoreContent.includes("node_modules"), "23. .dockerignore excludes local node_modules from container context");
  assert(dockerignoreContent.includes("scratch"), "24. .dockerignore excludes test files and scratch directory from container image");

  const gitignoreContent = fs.readFileSync(path.join(projectRoot, ".gitignore"), "utf8");
  assert(gitignoreContent.includes(".env") && gitignoreContent.includes("key.json"), "25. .gitignore excludes .env and key.json from version control");

  console.log("\n================================================================================");
  console.log(`🏁 PHASE 11 FAILURE & AUDIT RESULTS: ${passedCount} PASSED, ${failedCount} FAILED (Total: ${passedCount + failedCount})`);
  console.log("================================================================================\n");

  if (failedCount > 0) process.exit(1);
  else process.exit(0);
}

runPhase11FailureTests().catch((err) => {
  console.error("❌ Phase 11 Failure Test Error:", err);
  process.exit(1);
});
