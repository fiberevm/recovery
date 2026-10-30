// Railgun proving circuits for the unshield flow. Common shapes are bundled into the page
// (scripts/artifacts.ts); anything else downloads from IPFS. Every zkey and wasm is checked
// against Railgun's published sha256 before use, wherever it came from.
import decompress from "brotli/decompress";
import zkey01x01 from "./artifacts/01x01/zkey.br";
import wasm01x01 from "./artifacts/01x01/wasm.br";
import vkey01x01 from "./artifacts/01x01/vkey.json";
import zkey01x02 from "./artifacts/01x02/zkey.br";
import wasm01x02 from "./artifacts/01x02/wasm.br";
import vkey01x02 from "./artifacts/01x02/vkey.json";
import zkey02x01 from "./artifacts/02x01/zkey.br";
import wasm02x01 from "./artifacts/02x01/wasm.br";
import vkey02x01 from "./artifacts/02x01/vkey.json";
import zkey02x02 from "./artifacts/02x02/zkey.br";
import wasm02x02 from "./artifacts/02x02/wasm.br";
import vkey02x02 from "./artifacts/02x02/vkey.json";
import hashes from "./artifacts/hashes.json";
import { ARTIFACT_GATEWAY } from "./artifact-variants";

const ARTIFACT_ROOT = `${ARTIFACT_GATEWAY}/ipfs/QmUsmnK4PFc7zDp2cmC4wBZxYLjNyRgWfs5GNcJJ2uLcpU`;

export type Artifact = { zkey: Uint8Array; wasm: Uint8Array; vkey: object };

/** Bundled files are base64 of the brotli bytes (see the `.br` loader in scripts/build.ts). */
const BUNDLED: Record<string, { zkey: string; wasm: string; vkey: object }> = {
  "01x01": { zkey: zkey01x01, wasm: wasm01x01, vkey: vkey01x01 },
  "01x02": { zkey: zkey01x02, wasm: wasm01x02, vkey: vkey01x02 },
  "02x01": { zkey: zkey02x01, wasm: wasm02x01, vkey: vkey02x01 },
  "02x02": { zkey: zkey02x02, wasm: wasm02x02, vkey: vkey02x02 },
};

const HASHES = hashes as Record<string, { zkey: string; wasm: string }>;
const loaded = new Map<string, Promise<Artifact>>();

export const variantName = (nullifiers: number, commitments: number) =>
  `${String(nullifiers).padStart(2, "0")}x${String(commitments).padStart(2, "0")}`;

export const hasCircuit = (variant: string) => variant in HASHES;
export const isBundled = (variant: string) => variant in BUNDLED;

/** Loads, decompresses and verifies one circuit; repeated requests share the first load. */
export function loadArtifact(variant: string): Promise<Artifact> {
  let artifact = loaded.get(variant);
  if (!artifact) {
    artifact = readArtifact(variant);
    loaded.set(variant, artifact);
    // A failed download can be retried on the next attempt.
    artifact.catch(() => loaded.delete(variant));
  }
  return artifact;
}

async function readArtifact(variant: string): Promise<Artifact> {
  const expected = HASHES[variant];
  if (!expected) throw new Error(`Railgun has no ${variant} circuit`);

  const bundled = BUNDLED[variant];
  const [zkeyBrotli, wasmBrotli, vkey] = bundled
    ? [fromBase64(bundled.zkey), fromBase64(bundled.wasm), bundled.vkey]
    : await Promise.all([
        download(`${ARTIFACT_ROOT}/circuits/${variant}/zkey.br`),
        download(`${ARTIFACT_ROOT}/prover/snarkjs/${variant}.wasm.br`),
        // Railgun publishes no vkey hash; it only lets the engine check proofs before sending.
        fetch(`${ARTIFACT_ROOT}/circuits/${variant}/vkey.json`).then((response) => response.json() as Promise<object>),
      ]);

  const zkey = await verified(decompress(zkeyBrotli), expected.zkey, `${variant} zkey`);
  const wasm = await verified(decompress(wasmBrotli), expected.wasm, `${variant} wasm`);
  return { zkey, wasm, vkey };
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Couldn't download proving files (HTTP ${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

async function verified(data: Uint8Array, expectedHex: string, label: string): Promise<Uint8Array> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hex !== expectedHex) throw new Error(`The ${label} proving file doesn't match Railgun's published hash`);
  return data;
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
