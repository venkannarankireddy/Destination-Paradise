const { shutdownCoordinator } = require("./shutdown");

/**
 * Health and Readiness Endpoints for Destination Paradise
 */
function createHealthRouter(db, options = {}) {
  const cacheTtlMs = options.cacheTtlMs || parseInt(process.env.READINESS_CACHE_TTL_MS, 10) || 5000;
  const timeoutMs = options.timeoutMs || 3000;

  let readinessCache = {
    timestamp: 0,
    isReady: false,
    checks: {},
  };

  /**
   * Performs a lightweight, bounded Firestore connectivity check with a strict timeout.
   */
  async function checkFirestoreReadiness() {
    if (!db) return false;

    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("FIRESTORE_TIMEOUT")), timeoutMs);
    });

    try {
      const queryPromise = db.collection("users").limit(1).get();
      await Promise.race([queryPromise, timeoutPromise]);
      clearTimeout(timer);
      return true;
    } catch (err) {
      clearTimeout(timer);
      return false;
    }
  }

  return {
    /**
     * GET /health - Basic process liveness check.
     * Fast, lightweight, zero external dependencies.
     */
    healthHandler: (req, res) => {
      res.status(200).json({
        status: "ok",
        service: "destination-paradise",
        uptime: parseFloat(process.uptime().toFixed(2)),
        timestamp: new Date().toISOString(),
      });
    },

    /**
     * GET /ready - Application readiness check.
     * Verifies critical dependencies (Firestore) with short caching and timeout.
     * Returns 503 immediately during graceful shutdown.
     */
    readyHandler: async (req, res) => {
      // 1. If application is shutting down, immediately return 503
      if (shutdownCoordinator.isShuttingDown) {
        return res.status(503).json({
          status: "not_ready",
          service: "destination-paradise",
          checks: { server: "shutting_down" },
          timestamp: new Date().toISOString(),
        });
      }

      const now = Date.now();

      // 2. Check if cached readiness result is still valid
      if (now - readinessCache.timestamp < cacheTtlMs) {
        const statusCode = readinessCache.isReady ? 200 : 503;
        return res.status(statusCode).json({
          status: readinessCache.isReady ? "ready" : "not_ready",
          service: "destination-paradise",
          checks: readinessCache.checks,
          cached: true,
          timestamp: new Date().toISOString(),
        });
      }

      // 3. Perform fresh bounded check
      const firestoreOk = await checkFirestoreReadiness();

      readinessCache = {
        timestamp: now,
        isReady: firestoreOk,
        checks: {
          firestore: firestoreOk ? "connected" : "disconnected",
        },
      };

      const statusCode = firestoreOk ? 200 : 503;
      return res.status(statusCode).json({
        status: firestoreOk ? "ready" : "not_ready",
        service: "destination-paradise",
        checks: readinessCache.checks,
        timestamp: new Date().toISOString(),
      });
    },

    // Exported for test manipulation / inspection
    resetCache: () => {
      readinessCache = { timestamp: 0, isReady: false, checks: {} };
    },
    getCache: () => readinessCache,
  };
}

module.exports = {
  createHealthRouter,
};

