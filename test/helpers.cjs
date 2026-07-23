const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CredentialVault } = require("../electron/credential-vault.cjs");
const { ProduDashStore } = require("../electron/store.cjs");

function createDirectory(prefix = "produdash-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeEncryption(options = {}) {
  return {
    async available() {
      return options.available !== false;
    },
    async encrypt(plainText) {
      return Buffer.from(`protected:${Buffer.from(plainText).toString("base64")}`);
    },
    async decrypt(buffer) {
      const value = buffer.toString();
      if (!value.startsWith("protected:")) throw new Error("Invalid protected value");
      return {
        plaintext: Buffer.from(value.slice("protected:".length), "base64").toString(),
        shouldReEncrypt: Boolean(options.shouldReEncrypt)
      };
    }
  };
}

async function createHarness(options = {}) {
  const directory = options.directory || createDirectory();
  const vault = options.vault || new CredentialVault(directory, options.encryption || fakeEncryption());
  const store = new ProduDashStore(directory, { credentialVault: vault });
  await store.initialize();
  return {
    directory,
    store,
    vault,
    cleanup() {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

module.exports = { createDirectory, createHarness, fakeEncryption };
