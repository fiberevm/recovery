/**
 * Builds the release page as one self-contained `dist/index.html`.
 * `bun build --compile` would do this in one step, but that mode skips the browser polyfills
 * for Node builtins (`events`, `buffer`, …) the Railgun engine needs, so bundle normally first
 * and inline the results here.
 */
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const staging = `${root}/dist/.staging`;
await rm(`${root}/dist`, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [`${root}/index.html`],
  outdir: staging,
  target: "browser",
  minify: true,
  plugins: [
    {
      name: "browser-shims",
      setup(build) {
        // Bun's `assert` polyfill reaches CommonJS callers as a namespace object; see shims/assert.
        build.onResolve({ filter: /^(node:)?assert$/ }, () => ({ path: `${root}/shims/assert/index.js` }));
        // Bundled Railgun circuits (src/artifacts.ts) become base64 strings inside the page.
        build.onLoad({ filter: /\.br$/ }, async ({ path }) => ({
          contents: `export default ${JSON.stringify(Buffer.from(await Bun.file(path).arrayBuffer()).toString("base64"))};`,
          loader: "js",
        }));
        // These read their .wasm from disk; see shims/no-wasm.js.
        build.onResolve({ filter: /^@railgun-community\/(poseidon-hash-wasm|curve25519-scalarmult-wasm)$/ }, () => ({
          path: `${root}/shims/no-wasm.js`,
        }));
      },
    },
  ],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

let html = await Bun.file(`${staging}/index.html`).text();
const inline = async (tag: RegExp, wrap: (code: string) => string) => {
  const match = html.match(tag);
  if (!match?.[1]) throw new Error(`Build output is missing ${tag}`);
  const code = await Bun.file(`${staging}/${match[1]}`).text();
  // A literal "</script" inside the bundle would end the inline script early.
  if (/<\/script/i.test(code)) throw new Error(`${match[1]} contains "</script"`);
  // A function replacement keeps "$&"-style patterns in the bundle from being interpreted.
  html = html.replace(match[0], () => wrap(code));
};
await inline(/<link rel="stylesheet"[^>]*href="\.\/([^"]+)"[^>]*>/, (css) => `<style>${css}</style>`);
await inline(/<script type="module"[^>]*src="\.\/([^"]+)"[^>]*><\/script>/, (js) => `<script type="module">${js}</script>`);

await Bun.write(`${root}/dist/index.html`, html);
await rm(staging, { recursive: true, force: true });
console.log(`dist/index.html  ${(html.length / 1024 / 1024).toFixed(2)} MB`);
