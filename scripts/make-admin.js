#!/usr/bin/env node

/**
 * CLI Administrator Provisioning Utility
 * Destination Paradise - Phase 8
 * 
 * Usage: node scripts/make-admin.js <email>
 * 
 * Locates an existing user in the Firestore `users` collection
 * and securely updates their application role to "admin".
 */

require("dotenv").config();
const admin = require("firebase-admin");
const path = require("path");
const fs = require("fs");

const emailArg = process.argv[2];

if (!emailArg || !emailArg.trim()) {
  console.error("❌ Usage Error: Email address is required.");
  console.error("   Syntax: node scripts/make-admin.js <email>");
  process.exit(1);
}

const targetEmail = emailArg.trim().toLowerCase();

// Initialize Firebase Admin SDK
let credential;
const localKeyPath = path.join(__dirname, "..", "key.json");

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    const parsedKey = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    credential = admin.credential.cert(parsedKey);
  } else if (fs.existsSync(localKeyPath)) {
    const serviceAccount = JSON.parse(fs.readFileSync(localKeyPath, "utf8"));
    credential = admin.credential.cert(serviceAccount);
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    credential = admin.credential.applicationDefault();
  } else {
    console.error("❌ FATAL: No Firebase Admin credentials found. Ensure key.json exists or configure FIREBASE_SERVICE_ACCOUNT_KEY.");
    process.exit(1);
  }

  admin.initializeApp({ credential });
} catch (err) {
  console.error("❌ FATAL: Firebase initialization failed:", err.message);
  process.exit(1);
}

const db = admin.firestore();

async function makeAdmin() {
  console.log(`🔍 Searching for user with email: ${targetEmail}...`);

  try {
    const userSnapshot = await db
      .collection("users")
      .where("email", "==", targetEmail)
      .get();

    if (userSnapshot.empty) {
      console.error(`❌ User not found: No record in 'users' collection with email '${targetEmail}'.`);
      console.error("   The user must first register an account (via /register) before being promoted to admin.");
      process.exit(1);
    }

    const userDoc = userSnapshot.docs[0];
    const userData = userDoc.data();
    const uid = userDoc.id;

    if (userData.role === "admin") {
      console.log(`ℹ️ User '${targetEmail}' (UID: ${uid}) is already an Administrator.`);
      process.exit(0);
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    await userDoc.ref.update({
      role: "admin",
      promotedAt: now,
      updatedAt: now,
    });

    console.log(`✅ Success: User '${targetEmail}' (UID: ${uid}) has been promoted to Administrator.`);
    console.log(`   Previous role: '${userData.role || "none"}' -> New role: 'admin'`);
    console.log("   The user can now log in at /login and access the Admin Portal at /admin.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Firestore update failed:", err.message);
    process.exit(1);
  }
}

makeAdmin();

