import { RecoveryError } from "./fiberseed";

/**
 * Checks that an RPC URL is usable before anything is sent to it.
 * It accepts the text from an input and returns a normalized URL.
 */
export function parseRpcUrl(value: string, chainName: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new RecoveryError(`Enter a valid URL for ${chainName}.`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new RecoveryError(`${chainName} RPC must use https (http is allowed for localhost only).`);
  }
  return url;
}

/** Splits a raw amount into whole and fractional digits, trimmed to `maxFraction` places. */
export function formatUnits(amount: bigint, decimals: number, maxFraction = 6): { whole: string; fraction: string } {
  const base = 10n ** BigInt(decimals);
  const whole = (amount / base).toLocaleString("en-US");
  const fraction = (amount % base).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  if (amount > 0n && whole === "0" && !fraction) return { whole: "<0", fraction: `.${"0".repeat(maxFraction - 1)}1` };
  return { whole, fraction: fraction ? `.${fraction}` : "" };
}
