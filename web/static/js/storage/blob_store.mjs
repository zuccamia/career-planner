// BlobStore contract — every storage backend implements these primitives over
// slash-delimited string keys. Coordinators (attachments, sync-current,
// reconcile) sit above and never touch backend-specific APIs.
//
// Keys can be flat ("current.sqlite") or nested ("attachments/company/foo.pdf").
// Backends split on '/' and treat all but the last segment as directories.
// Callers own path composition — see config.mjs → attachmentKey / syncKey.
//
// This file defines only the shape via JSDoc; each backend declares
// class Foo extends BlobStore in its own module.

export class BlobStore {
  /** @type {string} */ name;

  // ---- lifecycle ----

  /** True if a connection has been established (folder picked, OAuth done). */
  isReady() { throw new Error('not implemented'); }

  /** True if ready AND reachable right now (network up for cloud backends). */
  isAvailable() { throw new Error('not implemented'); }

  /** Interactive connect — must run inside a user gesture. */
  async connect() { throw new Error('not implemented'); }

  /** Silent restore from IDB; returns true iff a live connection resulted. */
  async tryRestore() { throw new Error('not implemented'); }

  /** Drop any persisted connection state (handles, tokens). */
  async forget() { throw new Error('not implemented'); }

  // ---- blob primitives ----

  /**
   * Upsert bytes at `key`. Parent dirs are created as needed.
   * @param {string} key
   * @param {Uint8Array} bytes
   * @returns {Promise<{modifiedAt: Date, sizeBytes: number}>}
   */
  async writeBlob(key, bytes) { throw new Error('not implemented'); }

  /**
   * Read bytes at `key`. Throws if not found.
   * @param {string} key
   * @returns {Promise<Uint8Array>}
   */
  async readBlob(key) { throw new Error('not implemented'); }

  /**
   * True iff a blob exists at `key`. Never throws for missing.
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async hasBlob(key) { throw new Error('not implemented'); }

  /**
   * Delete blob at `key`. Idempotent — missing is not an error.
   * @param {string} key
   */
  async deleteBlob(key) { throw new Error('not implemented'); }

  /**
   * Metadata for `key`, or null if missing. Never throws for missing.
   * @param {string} key
   * @returns {Promise<{modifiedAt: Date, sizeBytes: number} | null>}
   */
  async statBlob(key) { throw new Error('not implemented'); }
}
