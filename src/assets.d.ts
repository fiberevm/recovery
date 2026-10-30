// Bundled Railgun circuits: scripts/build.ts loads each `.br` file as base64 of its bytes.
declare module "*.br" {
  const base64: string;
  export default base64;
}

// brotli ships no types; its decoder takes and returns raw bytes.
declare module "brotli/decompress" {
  const decompress: (input: Uint8Array) => Uint8Array;
  export default decompress;
}

// snarkjs and ffjavascript ship no types; only these entry points are used.
declare module "snarkjs" {
  export const groth16: { fullProve: (...args: unknown[]) => Promise<unknown>; verify: unknown };
}
declare module "ffjavascript" {
  export function buildBn128(singleThread?: boolean): Promise<unknown>;
}
