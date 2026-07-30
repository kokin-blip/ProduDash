const fs = require("node:fs");
const path = require("node:path");
const { AppError } = require("./errors.cjs");
const { preserveFile, readJson, writeJsonAtomic } = require("./atomic-json.cjs");

class CredentialVault {
  constructor(userDataPath, encryption) {
    this.filePath = path.join(userDataPath, "produdash-credentials.enc.json");
    this.legacyPath = path.join(userDataPath, "produdash-credentials.json");
    this.encryption = encryption;
    this.cache = {};
    this.notices = [];
  }

  async initialize() {
    if (!(await this.encryption.available())) {
      throw new AppError("SECURE_STORAGE_UNAVAILABLE", "Secure operating-system credential storage is unavailable.");
    }
    await this.migrateLegacy();
    this.cache = await this.readEncrypted();
    return this.notices;
  }

  async readEncrypted() {
    if (!fs.existsSync(this.filePath)) {
      const backupPath = `${this.filePath}.bak`;
      if (!fs.existsSync(backupPath)) return {};
      try {
        const { credentials } = await this.decodeFile(backupPath);
        await this.writeEncrypted(credentials);
        this.notices.push({
          code: "CREDENTIALS_RECOVERED",
          message: "Missing encrypted credentials were recovered from a protected backup."
        });
        return credentials;
      } catch {
        preserveFile(backupPath, "recovery");
        throw new AppError("CREDENTIAL_VAULT_INVALID", "The encrypted credential vault backup could not be opened.");
      }
    }
    try {
      const { credentials, shouldReEncrypt } = await this.decodeFile(this.filePath);
      if (shouldReEncrypt) await this.writeEncrypted(credentials);
      return credentials;
    } catch (error) {
      preserveFile(this.filePath, "recovery");
      const backupPath = `${this.filePath}.bak`;
      if (fs.existsSync(backupPath)) {
        try {
          const { credentials } = await this.decodeFile(backupPath);
          await this.writeEncrypted(credentials);
          this.notices.push({ code: "CREDENTIALS_RECOVERED", message: "Encrypted credentials were recovered from a protected backup." });
          return credentials;
        } catch {
          preserveFile(backupPath, "recovery");
        }
      }
      throw new AppError("CREDENTIAL_VAULT_INVALID", "The encrypted credential vault could not be opened.", { cause: error });
    }
  }

  async decodeFile(filePath) {
    const record = readJson(filePath);
    if (record.version !== 1 || typeof record.ciphertext !== "string") throw new Error("Invalid vault record");
    const decrypted = await this.encryption.decrypt(Buffer.from(record.ciphertext, "base64"));
    const credentials = JSON.parse(decrypted.plaintext);
    if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) throw new Error("Invalid credentials");
    return {
      credentials,
      shouldReEncrypt: decrypted.shouldReEncrypt
    };
  }

  async writeEncrypted(credentials) {
    const encrypted = await this.encryption.encrypt(JSON.stringify(credentials));
    const record = { version: 1, ciphertext: encrypted.toString("base64") };
    // Written twice, deliberately. writeJsonAtomic copies the existing file to
    // `.bak` before replacing it, so one write leaves the *previous* secrets
    // sitting in the backup: revoking a grant or rotating a key would clean the
    // vault while the old value stayed readable on disk. The second write makes
    // the backup a copy of the new contents, which is what actually removes it.
    //
    // This lives here rather than at the call sites because it used to: remove()
    // scrubbed, replace() scrubbed only when it emptied an entry, and save()
    // never did -- so the disconnect path silently kept revoked tokens. One
    // write path means that cannot drift apart again.
    //
    // The cost is a second write of a small file. Recovery is unaffected: a
    // crash between the two writes leaves the previous contents in `.bak`, and
    // after both it holds a valid copy of the current ones.
    writeJsonAtomic(this.filePath, record, { mode: 0o600 });
    writeJsonAtomic(this.filePath, record, { mode: 0o600 });
  }

  async migrateLegacy() {
    if (!fs.existsSync(this.legacyPath)) return;
    let legacy;
    try {
      legacy = readJson(this.legacyPath);
      if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) throw new Error("Invalid legacy credentials");
    } catch {
      // Set aside rather than thrown on. Throwing reached main.cjs, which shows
      // a fatal dialog and quits -- and the file was left in place, so the next
      // launch failed identically. The app became permanently unlaunchable, with
      // no way to reach the UI and clear it.
      //
      // The file is kept, not deleted: it is the user's only copy of those
      // credentials, and it is plaintext, so clearAll() removes its preserved
      // copies too. They are told rather than left to guess why the app is
      // suddenly asking for credentials again.
      preserveFile(this.legacyPath, "recovery");
      this.notices.push({
        code: "LEGACY_CREDENTIALS_UNREADABLE",
        message: "Saved credentials from an older version could not be read. Enter them again to reconnect."
      });
      return;
    }
    await this.writeEncrypted(legacy);
    const descriptor = fs.openSync(this.legacyPath, "r+");
    try {
      fs.ftruncateSync(descriptor, 0);
      fs.writeFileSync(descriptor, "{}\n");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.unlinkSync(this.legacyPath);
    this.notices.push({ code: "CREDENTIALS_MIGRATED", message: "Saved credentials were migrated to secure operating-system storage." });
  }

  get(integrationId) {
    return structuredClone(this.cache[integrationId] || {});
  }

  keys(integrationId) {
    return Object.keys(this.cache[integrationId] || {});
  }

  // The vault's own top-level slots, for callers that store records under a
  // key convention rather than an integration id and need to find them again.
  entryIds() {
    return Object.keys(this.cache);
  }

  async save(integrationId, values) {
    this.cache[integrationId] = { ...(this.cache[integrationId] || {}), ...values };
    await this.writeEncrypted(this.cache);
  }

  async replace(integrationId, values) {
    if (Object.keys(values).length) this.cache[integrationId] = { ...values };
    else delete this.cache[integrationId];
    await this.writeEncrypted(this.cache);
  }

  async remove(integrationId) {
    delete this.cache[integrationId];
    await this.writeEncrypted(this.cache);
  }

  async removeMany(integrationIds) {
    for (const integrationId of integrationIds) delete this.cache[integrationId];
    await this.writeEncrypted(this.cache);
  }

  async clearAll() {
    this.cache = {};
    const directory = path.dirname(this.filePath);
    if (!fs.existsSync(directory)) return;
    const encryptedName = path.basename(this.filePath);
    const legacyName = path.basename(this.legacyPath);
    for (const entry of fs.readdirSync(directory)) {
      // Every sidecar of the vault file, whatever the suffix -- `.bak`, a
      // `.recovery-<stamp>` copy, and `.bak.recovery-<stamp>`, which recovery
      // creates when the *backup* is the unreadable one.
      //
      // This used to enumerate exact suffixes and missed that last shape, so a
      // vault that had ever been through recovery kept a copy of the user's
      // credentials after they asked for everything to be deleted. Failing to
      // decode is not the same as being damaged: a reinstalled OS or a changed
      // keychain leaves the ciphertext intact and readable elsewhere. Matching
      // the prefix means a new sidecar name cannot reintroduce this.
      if (entry === legacyName || entry === encryptedName || entry.startsWith(`${encryptedName}.`) || entry.startsWith(`${legacyName}.`)) {
        fs.unlinkSync(path.join(directory, entry));
      }
    }
  }
}

function createSafeStorageAdapter(safeStorage) {
  return {
    async available() {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
      return process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text";
    },
    async encrypt(plainText) {
      return safeStorage.encryptStringAsync(plainText);
    },
    async decrypt(encrypted) {
      const result = await safeStorage.decryptStringAsync(encrypted);
      return { plaintext: result.result, shouldReEncrypt: result.shouldReEncrypt };
    }
  };
}

module.exports = { CredentialVault, createSafeStorageAdapter };
