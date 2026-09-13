const fs = require("fs");
const path = require("path");

const INSECURE_SESSION_SECRETS = new Set([
  "keyboard cat",
  "dev-fallback-secret-destination-paradise",
  "change-me",
  "your_strong_session_secret_here",
  "secret",
  "12345678",
]);

/**
 * Validates startup configuration for Destination Paradise.
 * Fails fast in production on missing or insecure critical configuration.
 *
 * @param {object} env - Environment object (defaults to process.env)
 * @param {boolean} exitOnError - Whether to call process.exit(1) on fatal validation failure
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateConfig(env = process.env, exitOnError = false) {
  const isProd = env.NODE_ENV === "production";
  const errors = [];
  const warnings = [];

  // 1. Validate PORT
  const portVal = env.PORT ? parseInt(env.PORT, 10) : 3000;
  if (isNaN(portVal) || portVal < 1 || portVal > 65535) {
    errors.push("PORT must be a valid integer between 1 and 65535.");
  }

  // 2. Validate APP_TIMEZONE
  const timezone = env.APP_TIMEZONE || "Asia/Colombo";
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch (e) {
    errors.push(`APP_TIMEZONE '${timezone}' is not a valid IANA timezone identifier.`);
  }

  // 3. Validate SESSION_SECRET
  const sessionSecret = env.SESSION_SECRET;
  if (isProd) {
    if (!sessionSecret) {
      errors.push("SESSION_SECRET is required in production mode.");
    } else if (INSECURE_SESSION_SECRETS.has(sessionSecret.trim().toLowerCase())) {
      errors.push("SESSION_SECRET must not use insecure default placeholders in production mode.");
    } else if (sessionSecret.length < 32) {
      errors.push("SESSION_SECRET must be at least 32 characters long in production mode.");
    }
  } else {
    if (!sessionSecret) {
      warnings.push("SESSION_SECRET is not set in .env. Using fallback development secret.");
    } else if (sessionSecret.length < 16) {
      warnings.push("SESSION_SECRET is short (<16 chars). A stronger secret is recommended.");
    }
  }

  // 4. Validate FIREBASE_API_KEY
  const apiKey = env.FIREBASE_API_KEY;
  if (isProd) {
    if (!apiKey || apiKey.trim() === "" || apiKey === "your_firebase_web_api_key_here") {
      errors.push("FIREBASE_API_KEY is required in production mode for authentication services.");
    }
  } else {
    if (!apiKey || apiKey.trim() === "" || apiKey === "your_firebase_web_api_key_here") {
      warnings.push("FIREBASE_API_KEY is not defined in .env. Authentication requests will fail.");
    }
  }

  // 5. Validate Firebase Admin SDK Credentials
  const localKeyPath = path.join(__dirname, "..", "key.json");
  const hasEnvKey = !!(env.FIREBASE_SERVICE_ACCOUNT_KEY && env.FIREBASE_SERVICE_ACCOUNT_KEY.trim());
  const hasGoogleCreds = !!(env.GOOGLE_APPLICATION_CREDENTIALS && env.GOOGLE_APPLICATION_CREDENTIALS.trim());
  const hasLocalFile = fs.existsSync(localKeyPath);

  if (!hasEnvKey && !hasGoogleCreds && !hasLocalFile) {
    errors.push("No Firebase Admin credentials found. Provide key.json locally or set FIREBASE_SERVICE_ACCOUNT_KEY / GOOGLE_APPLICATION_CREDENTIALS.");
  }

  // 6. Validate SHUTDOWN_TIMEOUT_MS
  if (env.SHUTDOWN_TIMEOUT_MS) {
    const timeout = parseInt(env.SHUTDOWN_TIMEOUT_MS, 10);
    if (isNaN(timeout) || timeout <= 0) {
      warnings.push("SHUTDOWN_TIMEOUT_MS must be a positive integer. Using default 10000ms.");
    }
  }

  const valid = errors.length === 0;

  if (!valid && exitOnError) {
    console.error("❌ STARTUP CONFIGURATION ERROR: The application cannot start due to missing or invalid configuration:");
    errors.forEach((err) => console.error(`   - ${err}`));
    console.error("Please verify your environment configuration and restart the application.\n");
    process.exit(1);
  }

  return { valid, errors, warnings };
}

module.exports = {
  validateConfig,
};
