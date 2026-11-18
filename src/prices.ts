// Dollar values for holdings, read on-chain through the RPCs the user chose. One Multicall3 call
// per chain returns that chain's block time together with every vault share price and Chainlink
// answer needed there, so each reading is consistent and nothing is asked of any other server.
import { Interface } from "ethers";
import type { Token } from "./chains";
import type { Feed, Market } from "./market";
import { rpcAny } from "./pool-logs";

/** Deployed at the same address on Ethereum, Arbitrum, Base and BNB Chain. */
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const multicall = new Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])",
  "function getCurrentBlockTimestamp() view returns (uint256)",
]);
const vaultAbi = new Interface(["function convertToAssets(uint256 shares) view returns (uint256)"]);
const feedAbi = new Interface([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

/** Chainlink USD feeds answer with 8 decimals. */
const FEED_UNIT = 1e8;
/** Stock feeds pause over weekends and holidays; anything older than this is treated as no price. */
const MAX_FEED_AGE_SECONDS = 7 * 24 * 60 * 60;
/** Share prices are asked for a large number of shares, so a few seconds of interest is measurable. */
const SHARE_SCALE = 10n ** 12n;
/** Two readings closer together than this are too near to measure a rate from. */
const MIN_RATE_SPAN_SECONDS = 10;
/** Above 100% a year is taken as a one-off jump in the share price, not a rate to project. */
const MAX_RATE_PER_SECOND = Math.LN2 / (365 * 24 * 60 * 60);
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
/** The second reading comes quickly so earning balances start ticking; then once a minute. */
const READ_DELAYS_MS = [15_000, 30_000, 60_000];

type ShareReading = { blockTime: number; assets: bigint };

type Tracked = {
  chainId: number;
  token: Token;
  market: Market;
  /** USD for one whole token, as last read; null until read or when there is no price. */
  usd: number | null;
  /** When `usd` was read, on this device's clock. */
  readAtMs: number;
  /** Continuous growth per second, measured between share price readings. */
  ratePerSecond: number;
  firstShare?: ShareReading;
};

export type PriceWatcher = {
  /** Starts pricing a holding; `key` names it in later calls. Safe to call again for the same key. */
  track(key: string, chainId: number, token: Token, market: Market): void;
  /** USD for one whole token at `nowMs`, projected forward at the measured rate. Null if unpriced. */
  usd(key: string, nowMs: number): number | null;
  /** The yearly rate an earning holding is growing at, once two readings have measured it. */
  apy(key: string): number | null;
  /** True once a holding has been read at least once, priced or not. */
  settled(key: string): boolean;
  stop(): void;
};

/**
 * Reads prices for tracked holdings now and then about once a minute while the page is visible,
 * calling `onChange` after each reading.
 */
export function watchPrices(rpcUrls: Map<number, URL[]>, onChange: () => void): PriceWatcher {
  const tracked = new Map<string, Tracked>();
  const read = new Set<string>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let kick: ReturnType<typeof setTimeout> | undefined;
  let rounds = 0;
  let reading: Promise<void> | undefined;
  let again = false;

  const schedule = () => {
    clearTimeout(timer);
    if (stopped || document.visibilityState === "hidden") return;
    const delay = READ_DELAYS_MS[Math.min(rounds, READ_DELAYS_MS.length) - 1] ?? READ_DELAYS_MS[0]!;
    timer = setTimeout(() => void readAll(), delay);
  };

  const readAll = (): Promise<void> => {
    // A holding tracked mid-read is picked up by one more read straight after.
    if (reading) {
      again = true;
      return reading;
    }
    reading = (async () => {
      const byChain = new Map<number, Call[]>();
      const feeds = new Map<string, Feed>();
      for (const [key, item] of tracked) {
        if (item.market.vault) {
          const shares = 10n ** BigInt(item.token.decimals) * SHARE_SCALE;
          push(byChain, item.chainId, {
            target: item.token.address,
            data: vaultAbi.encodeFunctionData("convertToAssets", [shares]),
            vaultKey: key,
          });
        }
        if (item.market.quote.kind === "feed") {
          const { feed } = item.market.quote;
          feeds.set(`${feed.chainId}:${feed.address}`, feed);
        }
      }
      for (const [feedKey, feed] of feeds) {
        push(byChain, feed.chainId, {
          target: feed.address,
          data: feedAbi.encodeFunctionData("latestRoundData"),
          feedKey,
        });
      }

      const feedUsd = new Map<string, number>();
      const shares = new Map<string, ShareReading>();
      await Promise.all(
        [...byChain].map(async ([chainId, calls]) => {
          try {
            await readChain(rpcUrls.get(chainId) ?? [], calls, feedUsd, shares);
          } catch (caught) {
            // Prices are an estimate on top of the balances; a failed read keeps the last values.
            console.warn(`Couldn't read prices on chain ${chainId}`, caught);
          }
        }),
      );
      if (stopped) return;

      const now = Date.now();
      for (const [key, item] of tracked) {
        const { quote, vault } = item.market;
        let unit: number | null = quote.kind === "usd" ? 1 : null;
        if (quote.kind === "feed") unit = feedUsd.get(`${quote.feed.chainId}:${quote.feed.address}`) ?? null;
        const share = shares.get(key);
        // Keep the last value when this round's read failed, instead of dropping to "no price".
        const failed = (quote.kind === "feed" && unit === null) || (vault && !share);
        if (failed && item.usd !== null) continue;
        read.add(key);
        if (unit === null || (vault && !share)) {
          item.usd = null;
          continue;
        }
        if (vault && share) {
          const perShare = Number(share.assets) / Number(SHARE_SCALE) / 10 ** vault.underlyingDecimals;
          unit *= perShare;
          if (vault.earns) item.ratePerSecond = measureRate(item, share);
        }
        item.usd = unit;
        item.readAtMs = now;
      }
      rounds++;
      onChange();
    })().finally(() => {
      reading = undefined;
      if (again) {
        again = false;
        void readAll();
      } else {
        schedule();
      }
    });
    return reading;
  };

  const onVisibility = () => {
    if (document.visibilityState === "hidden") clearTimeout(timer);
    else if (tracked.size) void readAll();
  };
  document.addEventListener("visibilitychange", onVisibility);

  return {
    track(key, chainId, token, market) {
      if (tracked.has(key) || stopped) return;
      tracked.set(key, { chainId, token, market, usd: null, readAtMs: 0, ratePerSecond: 0 });
      if (market.quote.kind === "none") return void read.add(key);
      // Holdings arrive a chain at a time; read once for the whole batch.
      kick ??= setTimeout(() => {
        kick = undefined;
        void readAll();
      }, 0);
    },
    usd(key, nowMs) {
      const item = tracked.get(key);
      if (!item || item.usd === null) return null;
      const elapsed = Math.max(0, (nowMs - item.readAtMs) / 1000);
      return item.usd * Math.exp(item.ratePerSecond * elapsed);
    },
    apy(key) {
      const rate = tracked.get(key)?.ratePerSecond ?? 0;
      return rate > 0 ? Math.exp(rate * SECONDS_PER_YEAR) - 1 : null;
    },
    settled: (key) => read.has(key),
    stop() {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(kick);
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}

type Call = { target: string; data: string; vaultKey?: string; feedKey?: string };

function push(byChain: Map<number, Call[]>, chainId: number, call: Call) {
  byChain.set(chainId, [...(byChain.get(chainId) ?? []), call]);
}

/** One eth_call for everything needed on a chain, with the block time it was answered at. */
async function readChain(
  rpcUrls: URL[],
  calls: Call[],
  feedUsd: Map<string, number>,
  shares: Map<string, ShareReading>,
) {
  if (!rpcUrls.length) throw new Error("No RPC for this chain");
  const batch = [
    { target: MULTICALL3, allowFailure: true, callData: multicall.encodeFunctionData("getCurrentBlockTimestamp") },
    ...calls.map((call) => ({ target: call.target, allowFailure: true, callData: call.data })),
  ];
  const raw = await rpcAny<string>(rpcUrls, "eth_call", [
    { to: MULTICALL3, data: multicall.encodeFunctionData("aggregate3", [batch]) },
    "latest",
  ]);
  const [results] = multicall.decodeFunctionResult("aggregate3", raw) as unknown as [
    Array<{ success: boolean; returnData: string }>,
  ];
  const [time, ...answers] = results;
  if (!time?.success) throw new Error("No block time");
  const blockTime = Number(BigInt(time.returnData));

  answers.forEach((answer, index) => {
    const call = calls[index]!;
    if (!answer.success || answer.returnData === "0x") return;
    try {
      if (call.vaultKey) {
        const [assets] = vaultAbi.decodeFunctionResult("convertToAssets", answer.returnData) as unknown as [bigint];
        if (assets > 0n) shares.set(call.vaultKey, { blockTime, assets });
      } else if (call.feedKey) {
        const round = feedAbi.decodeFunctionResult("latestRoundData", answer.returnData);
        const price = Number(round.answer as bigint) / FEED_UNIT;
        const age = blockTime - Number(round.updatedAt as bigint);
        if (price > 0 && age <= MAX_FEED_AGE_SECONDS) feedUsd.set(call.feedKey, price);
      }
    } catch {
      // A contract that answers with something else has no price here.
    }
  });
}

/** The growth rate between the first share price read this session and the newest one. */
function measureRate(item: Tracked, share: ShareReading): number {
  const first = (item.firstShare ??= share);
  const span = share.blockTime - first.blockTime;
  // Servers can trail each other; a reading from an earlier block says nothing new.
  if (span < MIN_RATE_SPAN_SECONDS || share.assets <= first.assets) return item.ratePerSecond;
  const growth = Number(((share.assets - first.assets) * 10n ** 18n) / first.assets) / 1e18;
  const rate = Math.log1p(growth) / span;
  return rate <= MAX_RATE_PER_SECOND ? rate : 0;
}
