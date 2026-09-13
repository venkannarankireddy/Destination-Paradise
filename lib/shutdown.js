const { logger } = require("./logger");

/**
 * Graceful Shutdown Coordinator
 * Ensures in-flight requests finish cleanly upon receiving SIGTERM or SIGINT.
 */
class ShutdownCoordinator {
  constructor(options = {}) {
    this.server = options.server || null;
    this.timeoutMs = options.timeoutMs || parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10) || 10000;
    this.isShuttingDown = false;
    this.onExit = options.onExit || ((code) => process.exit(code));
    this._listenersRegistered = false;
  }

  setServer(server) {
    this.server = server;
  }

  /**
   * Registers OS signal listeners for SIGTERM and SIGINT.
   */
  registerSignalHandlers() {
    if (this._listenersRegistered) return;
    this._listenersRegistered = true;

    process.on("SIGTERM", () => this.shutdown("SIGTERM"));
    process.on("SIGINT", () => this.shutdown("SIGINT"));
  }

  /**
   * Executes graceful shutdown sequence idempotently.
   *
   * @param {string} signal - Signal name (e.g. 'SIGTERM', 'SIGINT')
   * @param {function} [done] - Optional callback for testing
   */
  shutdown(signal = "SIGTERM", done) {
    if (this.isShuttingDown) {
      logger.warn(`Shutdown already in progress. Ignoring duplicate signal: ${signal}`);
      if (typeof done === "function") done(null, false);
      return;
    }

    this.isShuttingDown = true;
    logger.info(`Received ${signal}. Initiating graceful shutdown...`, { timeoutMs: this.timeoutMs });

    // Safety fallback timer to prevent hanging indefinitely
    const forceTimer = setTimeout(() => {
      logger.error("Graceful shutdown timed out. Forcing process termination.");
      if (typeof done === "function") {
        done(new Error("Shutdown timed out"), false);
      } else {
        this.onExit(1);
      }
    }, this.timeoutMs);

    if (forceTimer.unref) {
      forceTimer.unref();
    }

    // Stop accepting new connections
    if (this.server && typeof this.server.close === "function") {
      this.server.close((err) => {
        clearTimeout(forceTimer);
        if (err) {
          logger.error("Error encountered while closing HTTP server", { error: err.message });
          if (typeof done === "function") {
            done(err, false);
          } else {
            this.onExit(1);
          }
          return;
        }

        logger.info("HTTP server closed cleanly. All in-flight requests completed.");
        if (typeof done === "function") {
          done(null, true);
        } else {
          this.onExit(0);
        }
      });
    } else {
      clearTimeout(forceTimer);
      logger.info("No active HTTP server to close. Shutdown complete.");
      if (typeof done === "function") {
        done(null, true);
      } else {
        this.onExit(0);
      }
    }
  }
}

const shutdownCoordinator = new ShutdownCoordinator();

module.exports = {
  ShutdownCoordinator,
  shutdownCoordinator,
};

