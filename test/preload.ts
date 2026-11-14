// Loads src/ the way scripts/build.ts bundles it for the page: circuits as base64 strings, and
// the engine's Node-only wasm packages replaced by the empty shim so it uses its JavaScript code.
import { plugin } from "bun";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

plugin({
  name: "page-loaders",
  setup(build) {
    build.onLoad({ filter: /\.br$/ }, async ({ path }) => ({
      contents: `export default ${JSON.stringify(Buffer.from(await Bun.file(path).arrayBuffer()).toString("base64"))};`,
      loader: "js",
    }));
    build.onResolve({ filter: /^@railgun-community\/(poseidon-hash-wasm|curve25519-scalarmult-wasm)$/ }, () => ({
      path: `${root}/shims/no-wasm.js`,
    }));
  },
});
