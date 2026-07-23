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
    writeJsonAtomic(
      this.filePath,
      {
        version: 1,
        ciphertext: encrypted.toString("base64")
      },
      { mode: 0o600 }
    );
  }

  async migrateLegacy() {
    if (!fs.existsSync(this.legacyPath)) return;
    let legacy;
    try {
      legacy = readJson(this.legacyPath);
      if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) throw new Error("Invalid legacy credentials");
    } catch (error) {
      throw new AppError("LEGACY_CREDENTIALS_INVALID", "Legacy credentials could not be migrated safely.", { cause: error });
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

  async clearAll() {
    this.cache = {};
    for (const target of [this.filePath, `${this.filePath}.bak`, this.legacyPath]) {
      if (fs.existsSync(target)) fs.unlinkSync(target);
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
