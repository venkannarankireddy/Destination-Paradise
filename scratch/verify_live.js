const path = require("path");
const projectRoot = path.resolve(__dirname, "..");
require(path.join(projectRoot, "node_modules/dotenv")).config({ path: path.join(projectRoot, ".env") });

process.env.PORT = "3098";
const BASE = `http://localhost:${process.env.PORT}`;

async function verifyLive() {
  console.log("==========================================");
  console.log("🔍 RUNNING LIVE OPERATIONAL VERIFICATION");
  console.log("==========================================");

  // 1. Start application normally
  const { app, server, shutdownCoordinator } = require(path.join(projectRoot, "app.js"));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  console.log("  ✅ Step 7: Application started normally on port", process.env.PORT);

  // 2. Verify /health
  const healthRes = await fetch(`${BASE}/health`);
  const healthData = await healthRes.json();
  if (healthRes.status === 200 && healthData.status === "ok") {
    console.log("  ✅ Step 8: GET /health verified (HTTP 200, status: ok)");
  } else {
    throw new Error(`GET /health failed: ${healthRes.status}`);
  }

  // 3. Verify /ready
  const readyRes = await fetch(`${BASE}/ready`);
  const readyData = await readyRes.json();
  if (readyRes.status === 200 && readyData.status === "ready" && readyData.checks.firestore === "connected") {
    console.log("  ✅ Step 9: GET /ready verified (HTTP 200, firestore: connected)");
  } else {
    throw new Error(`GET /ready failed: ${readyRes.status}`);
  }

  // Helper session client
  class TestClient {
    constructor() { this.cookies = {}; }
    async fetch(url, options = {}) {
      options.headers = options.headers || {};
      const cookieStr = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
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
  }

  const client = new TestClient();

  // 4. Verify login / register
  const testEmail = `verify_p10_${Date.now()}@example.com`;
  const csrfRes = await client.fetch(`${BASE}/csrf-token`);
  const { csrfToken } = await csrfRes.json();

  const regParams = new URLSearchParams({ email: testEmail, password: "Password123!Live", _csrf: csrfToken });
  const regRes = await client.fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: regParams,
  });
  if (regRes.status === 302) {
    console.log("  ✅ Step 10: User registration and login verified (HTTP 302 redirect)");
  } else {
    throw new Error(`Registration failed: ${regRes.status}`);
  }

  // 5. Verify role routing
  const dashRes = await client.fetch(`${BASE}/dashboard`);
  if (dashRes.status === 200) {
    console.log("  ✅ Step 11: Tourist role routing to /dashboard verified (HTTP 200)");
  } else {
    throw new Error(`Dashboard routing failed: ${dashRes.status}`);
  }

  // 6. Verify protected request (Admin forbidden for tourist)
  const adminRes = await client.fetch(`${BASE}/admin`);
  if (adminRes.status === 403) {
    console.log("  ✅ Step 12: Protected route authorization verified (Tourist blocked with 403 Forbidden from /admin)");
  } else {
    throw new Error(`Admin protection check failed: ${adminRes.status}`);
  }

  // 7. Verify graceful shutdown behavior
  await new Promise((resolve) => {
    shutdownCoordinator.shutdown("SIGTERM", (err, executed) => {
      if (err) throw err;
      if (executed) {
        console.log("  ✅ Step 13: Graceful shutdown executed cleanly and closed server");
        resolve();
      }
    });
  });

  // Clean test user
  const admin = require(path.join(projectRoot, "node_modules/firebase-admin"));
  const db = admin.firestore();
  const snap = await db.collection("users").where("email", "==", testEmail).get();
  snap.forEach((d) => d.ref.delete());

  console.log("\n🎉 ALL LIVE OPERATIONAL VERIFICATION CHECKS PASSED!");
  process.exit(0);
}

verifyLive().catch((e) => {
  console.error("❌ Live verification failed:", e);
  process.exit(1);
});

