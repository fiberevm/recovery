import { base64 } from "@scure/base";

// Mirrors `fiber-wallet-export` version 1 from Fiber's shared wallet-export module.
const PASSWORD_FILE_AAD = new TextEncoder().encode("fiber.wallet-export.password.v1");
const PASSWORD_KDF_ITERATIONS = 600_000;
const FORMAT_VERSION = 1;

/** Real backups are well under 1 KB; anything this large is not a seed file. */
export const MAX_FIBERSEED_BYTES = 64_000;

export type FiberSeedFile = {
  format: "fiber-wallet-export";
  version: typeof FORMAT_VERSION;
  createdAt?: string;
  kdf: { name: "PBKDF2-HMAC-SHA256"; iterations: number; salt: string };
  cipher: { name: "AES-256-GCM"; nonce: string; ciphertext: string };
};

type WalletSeedPayload = {
  format: "fiber-wallet-seed";
  version: typeof FORMAT_VERSION;
  encoding: "base64";
  seed: string;
};

/** WebCrypto's types want ArrayBuffer-backed views, so copy out of the decoder's buffer. */
const decodeBase64 = (value: string) => new Uint8Array(base64.decode(value));

/** Thrown for problems the person can act on, so the UI can show the message as-is. */
export class RecoveryError extends Error {}

/**
 * Checks a dropped file's envelope before asking for a password.
 * It accepts the file's text and rejects unknown formats without touching key material.
 */
export function parseFiberSeedFile(text: string): FiberSeedFile {
  let parsed: Partial<FiberSeedFile>;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RecoveryError("This isn't a Fiber backup file.");
  }

  if (parsed?.format !== "fiber-wallet-export") {
    throw new RecoveryError("This isn't a Fiber backup file.");
  }
  if (
    parsed.version !== FORMAT_VERSION ||
    parsed.kdf?.name !== "PBKDF2-HMAC-SHA256" ||
    parsed.kdf.iterations !== PASSWORD_KDF_ITERATIONS ||
    typeof parsed.kdf.salt !== "string" ||
    parsed.cipher?.name !== "AES-256-GCM" ||
    typeof parsed.cipher.nonce !== "string" ||
    typeof parsed.cipher.ciphertext !== "string"
  ) {
    throw new RecoveryError("This backup uses a format this tool doesn't support yet.");
  }

  return parsed as FiberSeedFile;
}

/**
 * Opens a backup with the browser's native PBKDF2 and AES-GCM, keeping the derived key non-extractable.
 * It accepts a parsed file and its password, and returns the raw master seed bytes.
 */
export async function decryptFiberSeed(file: FiberSeedFile, password: string): Promise<Uint8Array> {
  if (!password) throw new RecoveryError("Enter the password for this backup.");

  const passwordBytes = new TextEncoder().encode(password);
  let payloadBytes: Uint8Array | undefined;

  try {
    const passwordKey = await crypto.subtle.importKey("raw", passwordBytes, "PBKDF2", false, [
      "deriveKey",
    ]);
    const aesKey = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: decodeBase64(file.kdf.salt),
        iterations: file.kdf.iterations,
      },
      passwordKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );

    try {
      payloadBytes = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: decodeBase64(file.cipher.nonce),
            additionalData: PASSWORD_FILE_AAD,
          },
          aesKey,
          decodeBase64(file.cipher.ciphertext),
        ),
      );
    } catch {
      // GCM cannot tell a wrong password from a modified file; both fail authentication.
      throw new RecoveryError("That password doesn't open this backup.");
    }

    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as Partial<WalletSeedPayload>;
    if (
      payload.format !== "fiber-wallet-seed" ||
      payload.version !== FORMAT_VERSION ||
      payload.encoding !== "base64" ||
      typeof payload.seed !== "string"
    ) {
      throw new RecoveryError("This backup opened, but its contents aren't a Fiber seed.");
    }

    const seed = base64.decode(payload.seed);
    if (seed.length < 16 || seed.length > 64) {
      throw new RecoveryError("This backup opened, but its seed is the wrong length.");
    }
    return seed;
  } finally {
    payloadBytes?.fill(0);
    passwordBytes.fill(0);
  }
}
