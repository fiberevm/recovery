// Tokens held outside the private pool, at the wallet's own addresses. Fiber's backup lists the
// ones it knew of, but the page doesn't rely on that list: it derives the wallet's addresses and
// looks on-chain itself, through the user's RPCs.
//
// Two passes. The sweep reads the balance of every labelled token (and the gas token) at every
// address, a few hundred balances per call, and takes seconds. The history scan reads ERC-20
// Transfer logs sent to those addresses, which finds any other token, and takes minutes on free
// servers because each allows only a small block range per request.
import { id, Interface, zeroPadValue } from "ethers";
import type { Chain, Token } from "./chains";
import { fetchPoolLogs, liveRpcs, rpcAny } from "./pool-logs";

/** Fiber's placeholder address for a chain's gas token (ETH, BNB). */
export const NATIVE_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

/**
 * How many addresses are checked. Fiber numbers a wallet's addresses 0, 1, 2… as it creates them,
 * so this covers every wallet that has made fewer than this many.
 */
export const PUBLIC_ADDRESS_COUNT = 200;

/** One token balance at one of the wallet's own addresses. */
export type PublicAsset = {
  chain: Chain;
  /** The address holding it, and its derivation index. */
  owner: string;
  index: number;
  /** Lowercase contract address, or `NATIVE_TOKEN`. */
  tokenAddress: string;
  amount: bigint;
  /** Fiber's label for the token, or the contract's own symbol and decimals when it has none. */
  token: Token | undefined;
  /** False when the label came from the contract itself, which anyone can set to anything. */
  labelled: boolean;
};

export type Owner = { address: string; index: number };

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const multicall = new Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])",
  "function getEthBalance(address addr) view returns (uint256)",
]);
const erc20 = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = id("Transfer(address,address,uint256)");
/** Balances per eth_call: small enough for free servers' gas and size caps. */
const CALLS_PER_BATCH = 400;
const PARALLEL_BATCHES = 3;

type Call = { target: string; callData: string };

/** Runs calls through Multicall3 in batches; a failed call comes back as null. */
async function batchCall(rpcUrls: URL[], calls: Call[], onProgress?: (fraction: number) => void) {
  const results: Array<string | null> = new Array(calls.length).fill(null);
  const starts = Array.from({ length: Math.ceil(calls.length / CALLS_PER_BATCH) }, (_, n) => n * CALLS_PER_BATCH);
  let done = 0;
  const worker = async () => {
    for (let start = starts.shift(); start !== undefined; start = starts.shift()) {
      const batch = calls.slice(start, start + CALLS_PER_BATCH);
      const raw = await rpcAny<string>(rpcUrls, "eth_call", [
        {
          to: MULTICALL3,
          data: multicall.encodeFunctionData("aggregate3", [batch.map((call) => ({ ...call, allowFailure: true }))]),
        },
        "latest",
      ]);
      const [answers] = multicall.decodeFunctionResult("aggregate3", raw) as unknown as [
        Array<{ success: boolean; returnData: string }>,
      ];
      answers.forEach((answer, offset) => {
        if (answer.success && answer.returnData !== "0x") results[start! + offset] = answer.returnData;
      });
      done += batch.length;
      onProgress?.(done / calls.length);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL_BATCHES }, worker));
  return results;
}

const balanceCall = (tokenAddress: string, owner: string): Call =>
  tokenAddress === NATIVE_TOKEN
    ? { target: MULTICALL3, callData: multicall.encodeFunctionData("getEthBalance", [owner]) }
    : { target: tokenAddress, callData: erc20.encodeFunctionData("balanceOf", [owner]) };

const nativeToken = (symbol: string): Token => ({
  address: NATIVE_TOKEN,
  symbol,
  name: symbol === "ETH" ? "Ether" : symbol,
  decimals: 18,
});

/**
 * Reads the given (address, token) pairs and returns the ones with a balance. Tokens Fiber has no
 * label for are described by their own `symbol` and `decimals`, marked as not labelled.
 */
export async function readBalances(
  chain: Chain,
  rpcUrls: URL[],
  pairs: Array<{ owner: Owner; tokenAddress: string }>,
  onProgress?: (fraction: number) => void,
): Promise<PublicAsset[]> {
  const unique = [
    ...new Map(
      pairs.map((pair) => [`${pair.owner.address.toLowerCase()}:${pair.tokenAddress.toLowerCase()}`, pair]),
    ).values(),
  ]
    .map((pair) => ({ owner: pair.owner, tokenAddress: pair.tokenAddress.toLowerCase() }))
    // Where the gas token is a labelled token too (Arc), it is read once, through its contract.
    .filter((pair) => pair.tokenAddress !== NATIVE_TOKEN || chain.nativeSymbol);
  const balances = await batchCall(
    rpcUrls,
    unique.map((pair) => balanceCall(pair.tokenAddress, pair.owner.address)),
    onProgress,
  );

  const labels = new Map<string, Token>(chain.tokens.map((token) => [token.address.toLowerCase(), token]));
  if (chain.nativeSymbol) labels.set(NATIVE_TOKEN, nativeToken(chain.nativeSymbol));
  const held = unique.flatMap((pair, index) => {
    const raw = balances[index];
    const amount = raw && raw.length >= 66 ? BigInt(raw.slice(0, 66)) : 0n;
    return amount > 0n ? [{ ...pair, amount }] : [];
  });

  // Ask unlabelled contracts to describe themselves.
  const unknown = [...new Set(held.map((asset) => asset.tokenAddress).filter((address) => !labels.has(address)))];
  const described = await batchCall(
    rpcUrls,
    unknown.flatMap((address) => [
      { target: address, callData: erc20.encodeFunctionData("symbol") },
      { target: address, callData: erc20.encodeFunctionData("decimals") },
    ]),
  );
  const selfDescribed = new Map<string, Token>();
  unknown.forEach((address, index) => {
    try {
      const [symbol] = erc20.decodeFunctionResult("symbol", described[index * 2] ?? "0x") as unknown as [string];
      const [decimals] = erc20.decodeFunctionResult("decimals", described[index * 2 + 1] ?? "0x") as unknown as [bigint];
      const clean = symbol.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 16);
      if (clean && decimals <= 36n) {
        selfDescribed.set(address, { address, symbol: clean, name: clean, decimals: Number(decimals) });
      }
    } catch {
      // Not a standard token; it shows by contract address with its raw amount.
    }
  });

  return held.map((asset) => ({
    chain,
    owner: asset.owner.address,
    index: asset.owner.index,
    tokenAddress: asset.tokenAddress,
    amount: asset.amount,
    token: labels.get(asset.tokenAddress) ?? selfDescribed.get(asset.tokenAddress),
    labelled: labels.has(asset.tokenAddress),
  }));
}

/** Every labelled token and the gas token, at every address: the fast, history-free pass. */
export function sweepBalances(
  chain: Chain,
  rpcUrls: URL[],
  owners: Owner[],
  onProgress?: (fraction: number) => void,
): Promise<PublicAsset[]> {
  const tokens = [...(chain.nativeSymbol ? [NATIVE_TOKEN] : []), ...chain.tokens.map((token) => token.address)];
  return readBalances(
    chain,
    rpcUrls,
    owners.flatMap((owner) => tokens.map((tokenAddress) => ({ owner, tokenAddress }))),
    onProgress,
  );
}

/** How many stretches a history scan is cut into; a retry resumes at the first unfinished one. */
const HISTORY_SEGMENTS = 40;
/** Free servers rate-limit long scans; a stretch that fails waits and tries again this many times. */
const SEGMENT_ATTEMPTS = 3;
const SEGMENT_RETRY_MS = 20_000;

export type TransferScan = {
  /** Reads on from where the last run stopped, and returns what is still held once it finishes. */
  run(onProgress: (fraction: number) => void): Promise<PublicAsset[]>;
};

/**
 * Finds every ERC-20 sent to the addresses since Fiber launched (`publicStartBlock`), by
 * reading Transfer logs, then returns the ones still held. This is what finds tokens Fiber has no
 * label for. It is slow on free servers, which allow a few thousand blocks per request and
 * rate-limit long scans, so it keeps its place: calling `run` again after a failure carries on.
 */
export function transferScan(chain: Chain, rpcUrls: URL[], owners: Owner[]): TransferScan {
  const byTopic = new Map(owners.map((owner) => [zeroPadValue(owner.address, 32).toLowerCase(), owner]));
  const pairs = new Map<string, { owner: Owner; tokenAddress: string }>();
  const start = chain.publicStartBlock;
  let next = start;
  let head: number | undefined;

  return {
    async run(onProgress) {
      const live = await liveRpcs(rpcUrls);
      // The first run fixes the end; anything newer is covered by the balance sweep's tokens.
      head ??= live.head;
      const size = Math.max(1, Math.ceil((head - start + 1) / HISTORY_SEGMENTS));
      while (next <= head) {
        const from = next;
        const to = Math.min(head, from + size - 1);
        // The last few percent is reading the balances found.
        const report = (fraction: number) =>
          onProgress(((from - start + fraction * (to - from + 1)) / (head! - start + 1)) * 0.97);
        for (let attempt = 1; ; attempt++) {
          try {
            const logs = await fetchPoolLogs(
              live.rpcUrls,
              // Transfer(from, to, value) with `to` being any of the wallet's addresses, from any contract.
              { topics: [TRANSFER_TOPIC, null, [...byTopic.keys()]] },
              from,
              to,
              report,
            );
            for (const log of logs) {
              // ERC-721 uses the same event with a fourth topic; only three-topic ERC-20 transfers count.
              const owner = log.topics.length === 3 ? byTopic.get(log.topics[2]!.toLowerCase()) : undefined;
              if (!owner || !log.address) continue;
              pairs.set(`${owner.address}:${log.address.toLowerCase()}`, { owner, tokenAddress: log.address });
            }
            break;
          } catch (caught) {
            if (attempt >= SEGMENT_ATTEMPTS) throw caught;
            await new Promise((resolve) => setTimeout(resolve, SEGMENT_RETRY_MS));
          }
        }
        next = to + 1;
      }
      const assets = await readBalances(chain, rpcUrls, [...pairs.values()]);
      onProgress(1);
      return assets;
    },
  };
}
