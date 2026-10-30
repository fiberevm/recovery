/**
 * Writes a test `.fiberseed` holding 32 zero bytes of entropy (the public "abandon … art"
 * vector). Real backups hold 32 bytes of entropy too, so Railgun can rebuild the mnemonic.
 *
 * Usage: bun scripts/make-fixture.ts [out-path] [password]
 */

const TEST_SEED = "00".repeat(32);
const out = process.argv[2] ?? "fixtures/test-wallet.fiberseed";
const password = process.argv[3] ?? "correct horse battery";
const createdAt = new Date().toISOString();

const payload = new TextEncoder().encode(
  JSON.stringify({
    format: "fiber-wallet-seed",
    version: 1,
    createdAt,
    encoding: "base64",
    seed: Buffer.from(TEST_SEED, "hex").toString("base64"),
  }),
);
const salt = crypto.getRandomValues(new Uint8Array(32));
const nonce = crypto.getRandomValues(new Uint8Array(12));
const passwordKey = await crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode(password),
  "PBKDF2",
  false,
  ["deriveKey"],
);
const key = await crypto.subtle.deriveKey(
  { name: "PBKDF2", hash: "SHA-256", salt, iterations: 600_000 },
  passwordKey,
  { name: "AES-GCM", length: 256 },
  false,
  ["encrypt"],
);
const ciphertext = new Uint8Array(
  await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: new TextEncoder().encode("fiber.wallet-export.password.v1"),
    },
    key,
    payload,
  ),
);

const file = {
  format: "fiber-wallet-export",
  version: 1,
  createdAt,
  kdf: { name: "PBKDF2-HMAC-SHA256", iterations: 600_000, salt: Buffer.from(salt).toString("base64") },
  cipher: { name: "AES-256-GCM", nonce: Buffer.from(nonce).toString("base64"), ciphertext: Buffer.from(ciphertext).toString("base64") },
};
await Bun.write(out, `${JSON.stringify(file, null, 2)}\n`);
console.log(`Wrote ${out} (password: "${password}")`);
