// Stand-in for micro-ftch, a Node HTTP helper that needs `url`, `zlib`, `http` and `https`.
// It is only reached through web3 (circomlibjs → web3 → @ethereumjs/util), and recovery never
// calls it: all RPC traffic goes through fetch in src/railgun.ts and the engine's ethers provider.
function fetchUrl() {
  throw new Error("micro-ftch is not available in the browser build");
}
module.exports = fetchUrl;
module.exports.default = fetchUrl;
