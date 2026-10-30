// Replaces @railgun-community/poseidon-hash-wasm and curve25519-scalarmult-wasm in the browser
// build. Their CommonJS builds read the .wasm file with fs.readFileSync, which browsers lack.
// With nothing exported, the engine uses its JavaScript implementations (circomlibjs Poseidon and
// noble ed25519), which compute the same values.
module.exports = {};
