// Mirrors omni's `packages/cli/src/chains.ts` (Fiber's pool deployments) and
// `packages/shared/asset-definitions/tokens.ts` (token labels).

export type Token = { address: string; symbol: string; name: string; decimals: number };

export type RecoveryChain = {
  id: number;
  /** Names the snapshot file and the snapshot script's `--<slug>-rpc` flag. */
  slug: string;
  name: string;
  /** Gas token, shown when a browser wallet pays for a send. */
  nativeSymbol: string;
  explorer: string;
  /** Free endpoints that allow browser (CORS) requests and historical eth_getLogs. */
  defaultRpc: string;
  pool: { proxy: string; relayAdapt: string; deploymentBlock: number };
  /** Used only to label holdings; anything else shows its contract address. */
  tokens: Token[];
};

export const RECOVERY_CHAINS: RecoveryChain[] = [
  {
    id: 42161,
    slug: "arbitrum",
    name: "Arbitrum",
    nativeSymbol: "ETH",
    explorer: "https://arbiscan.io",
    defaultRpc: "https://arb1.arbitrum.io/rpc",
    pool: {
      proxy: "0x7233d17ec3Ce855Acb8F7A9412Bf90757117A092",
      relayAdapt: "0xB4F2d77bD12c6b548Ae398244d7FAD4ABCE4D89b",
      deploymentBlock: 512_998_944,
    },
    tokens: [
      { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", symbol: "USDC", name: "USD Coin", decimals: 6 },
      { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", symbol: "USDT", name: "Tether USD", decimals: 6 },
      { address: "0x5a847BE0F397a57C8f7E4193AF093F4f0A422571", symbol: "fUSDT0", name: "Aave USDT0 vault", decimals: 6 },
    ],
  },
  {
    id: 8453,
    slug: "base",
    name: "Base",
    nativeSymbol: "ETH",
    explorer: "https://basescan.org",
    // mainnet.base.org refuses historical log queries; Tenderly allows 1,000 blocks per request.
    defaultRpc: "https://base.gateway.tenderly.co",
    pool: {
      proxy: "0x22F45899EE13042ae046f7Aa7C2292Ea74C7F1c6",
      relayAdapt: "",
      deploymentBlock: 45_619_056,
    },
    tokens: [
      { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", name: "USD Coin", decimals: 6 },
      { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", name: "Wrapped Ether", decimals: 18 },
      { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", symbol: "cbBTC", name: "Coinbase Bitcoin", decimals: 8 },
      { address: "0x043eB4B75d0805c43D7C834902E335621983Cf03", symbol: "CADC", name: "CAD Coin", decimals: 18 },
      { address: "0xA1168D47Fc27775153f210c663BdCb3761070c8F", symbol: "USDC Prime", name: "Gauntlet USDC Prime vault", decimals: 18 },
    ],
  },
  {
    id: 56,
    slug: "bnb",
    name: "BNB Chain",
    nativeSymbol: "BNB",
    explorer: "https://bscscan.com",
    // bloXroute allows 5,000 blocks per log query; the BNB Chain dataseeds refuse log queries.
    defaultRpc: "https://bsc.rpc.blxrbdn.com",
    pool: {
      // Same CREATE address as Arbitrum's pool; always select the pool by chain ID.
      proxy: "0x7233d17ec3Ce855Acb8F7A9412Bf90757117A092",
      relayAdapt: "",
      deploymentBlock: 129_064_218,
    },
    tokens: [
      // Tether's BEP-20 USDT uses 18 decimals, unlike USDT elsewhere.
      { address: "0x55d398326f99059fF775485246999027B3197955", symbol: "USDT", name: "Tether USD", decimals: 18 },
      { address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", symbol: "WBNB", name: "Wrapped BNB", decimals: 18 },
      // Same address as Arbitrum's fUSDT0 vault, but 18 decimals here.
      { address: "0x5a847BE0F397a57C8f7E4193AF093F4f0A422571", symbol: "FUSDT", name: "Aave USDT vault", decimals: 18 },
    ],
  },
];
