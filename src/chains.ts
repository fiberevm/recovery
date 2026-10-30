// Fiber's pool deployments, from omni's `packages/shared/asset-definitions/railgun.ts` (main).
import { TOKENS } from "./tokens";

export type Token = { address: string; symbol: string; name: string; decimals: number };

export type RecoveryChain = {
  id: number;
  /** Names the snapshot file, the snapshot script's `--<slug>-rpc` flag and the network icon. */
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
    id: 1,
    slug: "ethereum",
    name: "Ethereum",
    nativeSymbol: "ETH",
    explorer: "https://etherscan.io",
    // Tenderly's public gateway serves 1M-block log ranges with CORS.
    defaultRpc: "https://mainnet.gateway.tenderly.co",
    pool: {
      proxy: "0xc835F7252338E1A7a533927C64fC148D6A940C5F",
      relayAdapt: "",
      // Just before Fiber's proxy was deployed at block 24,702,699.
      deploymentBlock: 24_702_692,
    },
    tokens: TOKENS[1]!,
  },
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
    tokens: TOKENS[42161]!,
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
    tokens: TOKENS[8453]!,
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
    tokens: TOKENS[56]!,
  },
];
