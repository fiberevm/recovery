/**
 * Downloads the Railgun proving circuits bundled into the page (src/artifacts/<variant>/), and
 * checks each against Railgun's published sha256 (src/artifacts/hashes.json, copied from Fiber's
 * fork of @railgun-community/wallet). Files stay brotli-compressed, as Railgun publishes them.
 *
 * Usage: bun scripts/artifacts.ts
 */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { BUNDLED_VARIANTS } from "../src/artifact-variants";

// Railgun's CDN; the page itself uses an IPFS gateway because this one doesn't allow browsers.
const CDN = "https://d28nqgx4vebmjg.cloudfront.net/railgun/v2";
const hashes = (await Bun.file(resolve(import.meta.dir, "../src/artifacts/hashes.json")).json()) as Record<
  string,
  { zkey: string; wasm: string }
>;

for (const variant of BUNDLED_VARIANTS) {
  const dir = resolve(import.meta.dir, `../src/artifacts/${variant}`);
  await mkdir(dir, { recursive: true });

  for (const [name, path] of [
    ["zkey", `circuits/${variant}/zkey.br`],
    ["wasm", `prover/snarkjs/${variant}.wasm.br`],
  ] as const) {
    const compressed = new Uint8Array(await (await fetch(`${CDN}/${path}`)).arrayBuffer());
    const digest = new Bun.CryptoHasher("sha256").update(brotliDecompressSync(compressed)).digest("hex");
    if (digest !== hashes[variant]?.[name]) throw new Error(`${variant} ${name}: hash ${digest} doesn't match Railgun's`);
    await Bun.write(`${dir}/${name}.br`, compressed);
    console.log(`${variant} ${name}  ${(compressed.length / 1024 / 1024).toFixed(1)} MB  sha256 ok`);
  }

  // Railgun publishes no hash for vkeys; the engine uses this one to check each proof locally.
  const vkey = await (await fetch(`${CDN}/circuits/${variant}/vkey.json`)).json();
  await Bun.write(`${dir}/vkey.json`, `${JSON.stringify(vkey)}\n`);
}
