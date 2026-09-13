const session = require("express-session");

/**
 * Firestore-backed session store for express-session.
 * Conforms strictly to the express-session Store specification.
 *
 * Implements:
 * - get(sid, callback)
 * - set(sid, session, callback)
 * - destroy(sid, callback)
 * - touch(sid, session, callback)
 *
 * Guarantees:
 * - Sessions persist across application crashes and restarts.
 * - Multi-instance cluster compatibility via shared Firestore collection.
 * - Expired sessions are discarded and never authenticate users.
 * - Correct asynchronous callback and error handling.
 */
class FirestoreSessionStore extends session.Store {
  /**
   * @param {object} options
   * @param {FirebaseFirestore.Firestore} options.db - Initialized Firestore instance
   * @param {string} [options.collection='sessions'] - Firestore collection name
   * @param {number} [options.ttlMs=86400000] - Default TTL in ms (24 hours)
   */
  constructor(options = {}) {
    super();
    if (!options.db) {
      throw new Error("FirestoreSessionStore requires an initialized Firestore instance (options.db).");
    }

    this.db = options.db;
    this.collectionName = options.collection || "sessions";
    this.ttlMs = options.ttlMs || 24 * 60 * 60 * 1000; // 24h default
  }

  /**
   * Helper to calculate expiration date from session cookie or default TTL.
   * @private
   */
  _getExpirationDate(sess) {
    if (sess && sess.cookie && sess.cookie.expires) {
      const exp = new Date(sess.cookie.expires);
      if (!isNaN(exp.getTime())) return exp;
    }
    return new Date(Date.now() + this.ttlMs);
  }

  /**
   * Helper to safely execute a callback asynchronously.
   * @private
   */
  _callCb(cb, err, result) {
    if (typeof cb === "function") {
      process.nextTick(() => cb(err, result));
    }
  }

  /**
   * Fetch a session by session ID.
   * Discards and deletes expired sessions.
   *
   * @param {string} sid - Session ID
   * @param {function(Error, object=)} cb - Callback(err, session)
   */
  get(sid, cb) {
    if (!sid) return this._callCb(cb, null, null);

    this.db
      .collection(this.collectionName)
      .doc(sid)
      .get()
      .then((doc) => {
        if (!doc.exists) {
          return this._callCb(cb, null, null);
        }

        const data = doc.data();
        const now = Date.now();

        // Validate expiration
        let isExpired = false;
        if (typeof data.expiresMs === "number") {
          isExpired = data.expiresMs <= now;
        } else if (data.expires && typeof data.expires.toMillis === "function") {
          isExpired = data.expires.toMillis() <= now;
        } else if (data.expires) {
          const expTime = new Date(data.expires).getTime();
          isExpired = !isNaN(expTime) && expTime <= now;
        }

        if (isExpired) {
          // Asynchronously purge expired session and do not authenticate
          this.destroy(sid, () => {});
          return this._callCb(cb, null, null);
        }

        // Parse session data
        let sessObj = null;
        try {
          sessObj = typeof data.session === "string" ? JSON.parse(data.session) : data.session;
        } catch (parseErr) {
          return this._callCb(cb, parseErr);
        }

        return this._callCb(cb, null, sessObj);
      })
      .catch((err) => {
        return this._callCb(cb, err);
      });
  }

  /**
   * Save or update a session by session ID.
   *
   * @param {string} sid - Session ID
   * @param {object} sess - Session object to store
   * @param {function(Error=)} cb - Callback(err)
   */
  set(sid, sess, cb) {
    if (!sid) return this._callCb(cb, new Error("Session ID is required for set()"));

    try {
      const expires = this._getExpirationDate(sess);
      const expiresMs = expires.getTime();
      const sessionJson = JSON.stringify(sess);

      const record = {
        session: sessionJson,
        expires: expires,
        expiresMs: expiresMs,
        updatedAt: new Date(),
      };

      this.db
        .collection(this.collectionName)
        .doc(sid)
        .set(record)
        .then(() => this._callCb(cb, null))
        .catch((err) => this._callCb(cb, err));
    } catch (err) {
      return this._callCb(cb, err);
    }
  }

  /**
   * Destroy / delete a session document.
   *
   * @param {string} sid - Session ID
   * @param {function(Error=)} cb - Callback(err)
   */
  destroy(sid, cb) {
    if (!sid) return this._callCb(cb, null);

    this.db
      .collection(this.collectionName)
      .doc(sid)
      .delete()
      .then(() => this._callCb(cb, null))
      .catch((err) => this._callCb(cb, err));
  }

  /**
   * Refresh session expiration time without rewriting the entire payload.
   *
   * @param {string} sid - Session ID
   * @param {object} sess - Session object
   * @param {function(Error=)} cb - Callback(err)
   */
  touch(sid, sess, cb) {
    if (!sid) return this._callCb(cb, null);

    try {
      const expires = this._getExpirationDate(sess);
      const expiresMs = expires.getTime();

      this.db
        .collection(this.collectionName)
        .doc(sid)
        .update({
          expires: expires,
          expiresMs: expiresMs,
          updatedAt: new Date(),
        })
        .then(() => this._callCb(cb, null))
        .catch((err) => {
          // If document does not exist yet, fallback to set()
          if (err.code === 5 || (err.message && err.message.includes("NOT_FOUND"))) {
            return this.set(sid, sess, cb);
          }
          return this._callCb(cb, err);
        });
    } catch (err) {
      return this._callCb(cb, err);
    }
  }
}

module.exports = {
  FirestoreSessionStore,
};

