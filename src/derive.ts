import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import { HDKey } from "@scure/bip32";

// Same paths as Fiber's enclave and the public CLI (`packages/cli/src/private-key.ts`).
const evmPath = (index: number) => `m/44'/60'/0'/0/${index}`;
const solanaPath = (index: number) => `m/44'/501'/${index}'/0'`;
const SLIP10_ED25519_MASTER_KEY = new TextEncoder().encode("ed25519 seed");

/** How many derivation indexes the key search tries before giving up. */
export const MAX_DERIVATION_INDEX = 1_000;

export type RecoveredKey = {
  network: "EVM" | "Solana";
  index: number;
  path: string;
  /** EVM: 0x-prefixed hex. Solana: the base58 64-byte secret key wallets import. */
  privateKey: string;
};

export type AddressKind = "evm" | "solana";

/** Tells EVM and Solana addresses apart, or returns null for anything else. */
export function addressKind(address: string): AddressKind | null {
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) return "evm";
  try {
    if (base58.decode(address).length === 32) return "solana";
  } catch {
    // Not base58.
  }
  return null;
}

/**
 * Walks derivation indexes until one produces `address`, then returns that key.
 * It yields between batches so the page stays responsive, and returns null if nothing matches.
 */
export async function findPrivateKey(seed: Uint8Array, address: string): Promise<RecoveredKey | null> {
  const kind = addressKind(address);
  if (kind === "evm") {
    const target = address.toLowerCase();
    // Every EVM index shares m/44'/60'/0'/0, so derive it once.
    const parent = HDKey.fromMasterSeed(seed).derive("m/44'/60'/0'/0");
    try {
      for (let index = 0; index < MAX_DERIVATION_INDEX; index++) {
        if (index % 100 === 0) await yieldToPage();
        const child = parent.deriveChild(index);
        try {
          if (evmAddress(child.privateKey!).toLowerCase() === target) {
            return { network: "EVM", index, path: evmPath(index), privateKey: `0x${bytesToHex(child.privateKey!)}` };
          }
        } finally {
          child.wipePrivateData();
        }
      }
    } finally {
      parent.wipePrivateData();
    }
  }

  if (kind === "solana") {
    // Every Solana index shares m/44'/501', so derive it once.
    const parent = slip10Child(slip10Child(slip10Master(seed), 44), 501);
    try {
      for (let index = 0; index < MAX_DERIVATION_INDEX; index++) {
        if (index % 100 === 0) await yieldToPage();
        // Keep the shared parent; the intermediate m/44'/501'/index' node is wiped by the second call.
        const leaf = slip10Child(slip10Child(parent, index, false), 0);
        try {
          const secret = leaf.subarray(0, 32);
          const publicKey = ed25519.getPublicKey(secret);
          if (base58.encode(publicKey) === address) {
            const secretKey = new Uint8Array(64);
            secretKey.set(secret);
            secretKey.set(publicKey, 32);
            const privateKey = base58.encode(secretKey);
            secretKey.fill(0);
            return { network: "Solana", index, path: solanaPath(index), privateKey };
          }
        } finally {
          leaf.fill(0);
        }
      }
    } finally {
      parent.fill(0);
    }
  }

  return null;
}

function evmAddress(privateKey: Uint8Array): string {
  const publicKey = secp256k1.getPublicKey(privateKey, false);
  return `0x${bytesToHex(keccak_256(publicKey.subarray(1)).subarray(-20))}`;
}

/* SLIP-0010 Ed25519: every level is hardened. A node is 64 bytes: key, then chain code. */

function slip10Master(seed: Uint8Array): Uint8Array {
  return hmac(sha512, SLIP10_ED25519_MASTER_KEY, seed);
}

/** Derives a hardened child; `wipeParent` clears the parent when the caller no longer needs it. */
function slip10Child(parent: Uint8Array, segment: number, wipeParent = true): Uint8Array {
  const data = new Uint8Array(37);
  data.set(parent.subarray(0, 32), 1);
  new DataView(data.buffer).setUint32(33, (segment | 0x80000000) >>> 0, false);
  const child = hmac(sha512, parent.subarray(32), data);
  data.fill(0);
  if (wipeParent) parent.fill(0);
  return child;
}

const yieldToPage = () => new Promise((resolve) => setTimeout(resolve, 0));
