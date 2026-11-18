// How each holding is filed and priced. Prices are read on-chain through the user's RPCs
// (src/prices.ts), so the page needs no price server: Chainlink feeds for market prices, and a
// vault's own share price for tokens that earn.
import type { Token } from "./chains";

export type Category = "stablecoin" | "stock" | "metal" | "crypto" | "other";

export const CATEGORIES: { id: Category; title: string }[] = [
  { id: "stablecoin", title: "Stablecoins" },
  { id: "stock", title: "Stocks" },
  { id: "metal", title: "Metals" },
  { id: "crypto", title: "Crypto" },
  { id: "other", title: "Other" },
];

/** A Chainlink price feed (USD, 8 decimals), read with `latestRoundData`. */
export type Feed = { chainId: number; address: string };

/**
 * Feeds from Chainlink's directory (reference-data-directory.vercel.app), each checked to answer
 * with a fresh price. Arbitrum carries most of them; Netflix is only on BNB Chain and SpaceX only
 * on Ethereum. AMD, Broadcom, Eli Lilly, Marvell, SanDisk and the silver trust have no feed, so
 * those holdings show their amount without a dollar value.
 */
const FEEDS: Record<string, Feed> = {
  AAPL: { chainId: 42161, address: "0x8d0CC5f38f9E802475f2CFf4F9fc7000C2E1557c" },
  AMZN: { chainId: 42161, address: "0xd6a77691f071E98Df7217BED98f38ae6d2313EBA" },
  COIN: { chainId: 42161, address: "0x950DC95D4E537A14283059bADC2734977C454498" },
  GOOGL: { chainId: 42161, address: "0x1D1a83331e9D255EB1Aaf75026B60dFD00A252ba" },
  META: { chainId: 42161, address: "0xcd1bd86fDc33080DCF1b5715B6FCe04eC6F85845" },
  MSFT: { chainId: 42161, address: "0xDde33fb9F21739602806580bdd73BAd831DcA867" },
  NFLX: { chainId: 56, address: "0x1fE6c9Bd9B29e5810c2819f37dDa8559739ebeC9" },
  NVDA: { chainId: 42161, address: "0x4881A4418b5F2460B21d6F08CD5aA0678a7f262F" },
  SPCX: { chainId: 1, address: "0x0a585B784513AB053563deE3CF830c633e4ff6c7" },
  SPY: { chainId: 42161, address: "0x46306F3795342117721D8DEd50fbcF6DF2b3cc10" },
  TSLA: { chainId: 42161, address: "0x3609baAa0a9b1f0FE4d6CC01884585d0e191C3E3" },
  ETH: { chainId: 42161, address: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612" },
  BTC: { chainId: 42161, address: "0x6ce185860a4963106506C203335A2910413708e9" },
  SOL: { chainId: 42161, address: "0x24ceA4b8ce57cdA5058b924B9B9987992450590c" },
  BNB: { chainId: 42161, address: "0x6970460aabF80C5BE983C6b74e5D06dEDCA95D4A" },
  XAU: { chainId: 42161, address: "0x1F954Dc24a49708C26E0C1777f16750B5C6d5a2c" },
  PAXG: { chainId: 42161, address: "0x2BA975D4D7922cD264267Af16F3bD177F206FE3c" },
  CAD: { chainId: 42161, address: "0xf6DA27749484843c4F02f5Ad1378ceE723dD61d4" },
};

/** What one whole unit of a token is worth, before any vault share price is applied. */
export type Quote = { kind: "usd" } | { kind: "feed"; feed: Feed } | { kind: "none" };

export type Market = {
  category: Category;
  quote: Quote;
  /**
   * An ERC-4626 vault share: its value is `convertToAssets` of the underlying, which `quote`
   * prices. `earns` marks the vaults that pay interest, whose value ticks up between reads.
   */
  vault?: {
    underlyingDecimals: number;
    earns: boolean;
    /** The dollar token an earning vault holds, which "Unwrap and send" pays out. */
    underlyingSymbol?: string;
  };
};

const USD: Quote = { kind: "usd" };
const feed = (key: string): Quote => (FEEDS[key] ? { kind: "feed", feed: FEEDS[key] } : { kind: "none" });

/**
 * Yield vault shares, by symbol, with the dollar token each holds. All are ERC-4626 vaults whose
 * `redeem` any holder may call, checked by simulating a redeem from each pool's own shares.
 */
const EARNING_VAULTS: Record<string, { symbol: string; decimals: number }> = {
  "USDC Prime": { symbol: "USDC", decimals: 6 },
  "Galaxy USDT": { symbol: "USDT", decimals: 6 },
  // Arbitrum's USDT is USDT0, which Fiber's registry lists as USDT.
  FUSDT0: { symbol: "USDT", decimals: 6 },
  // BNB Chain's USDT has 18 decimals.
  FUSDT: { symbol: "USDT", decimals: 18 },
};

const SIMPLE: Record<string, Market> = {
  USDC: { category: "stablecoin", quote: USD },
  USDT: { category: "stablecoin", quote: USD },
  CADC: { category: "stablecoin", quote: feed("CAD") },
  PAXG: { category: "metal", quote: feed("PAXG") },
  XAUT: { category: "metal", quote: feed("XAU") },
  SLV: { category: "metal", quote: feed("SLV") },
  ETH: { category: "crypto", quote: feed("ETH") },
  // Gas tokens of deposit networks; none has a Chainlink feed on the chains the page reads.
  POL: { category: "crypto", quote: feed("POL") },
  MON: { category: "crypto", quote: feed("MON") },
  HYPE: { category: "crypto", quote: feed("HYPE") },
  XPL: { category: "crypto", quote: feed("XPL") },
  BNB: { category: "crypto", quote: feed("BNB") },
  WETH: { category: "crypto", quote: feed("ETH") },
  WBTC: { category: "crypto", quote: feed("BTC") },
  cbBTC: { category: "crypto", quote: feed("BTC") },
  SOL: { category: "crypto", quote: feed("SOL") },
  WBNB: { category: "crypto", quote: feed("BNB") },
};

// Tokenized stocks: Ondo ("AAPLon"), xStocks ("AAPLx", or "wAAPLx" wrapped) and bStocks ("AAPLB").
const STOCK = /^(w?)(AAPL|AMD|AMZN|AVGO|COIN|GOOGL|LLY|META|MRVL|MSFT|NFLX|NVDA|SNDK|SPCX|SPY|TSLA)(on|x|B)$/;

/** Files a labelled token under a category and says how to price it. Unlabelled tokens are "other". */
export function marketFor(token: Token | undefined): Market {
  if (!token) return { category: "other", quote: { kind: "none" } };
  const earning = EARNING_VAULTS[token.symbol];
  if (earning) {
    return {
      category: "stablecoin",
      quote: USD,
      vault: { underlyingDecimals: earning.decimals, earns: true, underlyingSymbol: earning.symbol },
    };
  }
  const simple = SIMPLE[token.symbol];
  if (simple) return simple;
  const stock = token.symbol.match(STOCK);
  if (stock) {
    const [, wrapped, ticker] = stock;
    // A wrapped xStock is a vault over the xStock itself, which has the same decimals.
    const vault = wrapped ? { underlyingDecimals: token.decimals, earns: false } : undefined;
    return { category: "stock", quote: feed(ticker!), vault };
  }
  return { category: "other", quote: { kind: "none" } };
}
