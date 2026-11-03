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
  /**
   * Public endpoints from chainlist.org/rpcs.json, each tested to allow browser (CORS) requests
   * and to return the right logs. Some listed servers answer eth_getLogs with an empty list
   * instead of an error, so test a new one against a range known to hold logs before adding it.
   * Servers Chainlist marks as tracking users ("tracking": "yes") are left out.
   */
  defaultRpcs: string[];
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
    defaultRpcs: [
      "https://0xrpc.io/eth",
      "https://eth.api.pocket.network",
      "https://ethereum.public.blockpi.network/v1/rpc/public",
      "https://rpc.mevblocker.io",
    ],
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
    defaultRpcs: [
      "https://arb1.arbitrum.io/rpc",
      "https://public-arb-mainnet.fastnode.io",
      "https://arb-one.api.pocket.network",
      "https://arbitrum-one.rpc.sentio.xyz",
    ],
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
    // mainnet.base.org refuses historical log queries. Only Sentio reaches the pool's oldest blocks.
    defaultRpcs: [
      "https://base.rpc.sentio.xyz",
      "https://base-rpc.publicnode.com",
      "https://base.public.blockpi.network/v1/rpc/public",
      "https://base.api.pocket.network",
    ],
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
    // The BNB Chain dataseeds refuse log queries, and bsc-rpc.publicnode.com returns no logs at all.
    defaultRpcs: [
      "https://bsc.rpc.sentio.xyz",
      "https://bsc.api.pocket.network",
    ],
    pool: {
      // Same CREATE address as Arbitrum's pool; always select the pool by chain ID.
      proxy: "0x7233d17ec3Ce855Acb8F7A9412Bf90757117A092",
      relayAdapt: "",
      deploymentBlock: 129_064_218,
    },
    tokens: TOKENS[56]!,
  },
];
