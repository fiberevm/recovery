// Fiber's pool deployments, from omni's `packages/shared/asset-definitions/railgun.ts` (main).
import { TOKENS } from "./tokens";

export type Token = { address: string; symbol: string; name: string; decimals: number };

/** A network Fiber wallets can hold tokens on. */
export type Chain = {
  id: number;
  /** Names the snapshot file, the snapshot script's `--<slug>-rpc` flag and the network icon. */
  slug: string;
  name: string;
  /**
   * Gas token, counted as a public holding. Null on Arc, whose gas token is USDC itself: the same
   * balance its USDC contract reports, so counting both would double it.
   */
  nativeSymbol: string | null;
  explorer: string;
  /**
   * Public endpoints from chainlist.org/rpcs.json, each tested to allow browser (CORS) requests
   * and to return the right logs. Some listed servers answer eth_getLogs with an empty list
   * instead of an error, so test a new one against a range known to hold logs before adding it.
   * Servers Chainlist marks as tracking users ("tracking": "yes") are left out.
   */
  defaultRpcs: string[];
  /** Used only to label holdings; anything else shows its contract address. */
  tokens: Token[];
  /**
   * The first block of 1 August 2026 (UTC), the month Fiber launched. No Fiber wallet received
   * anything before it, so transfer-history scans of public addresses start here.
   */
  publicStartBlock: number;
};

/** A network with one of Fiber's private pools. */
export type RecoveryChain = Chain & {
  /** Shown when a browser wallet pays for a send. */
  nativeSymbol: string;
  pool: { proxy: string; relayAdapt: string; deploymentBlock: number };
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
    publicStartBlock: 25_656_292,
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
    publicStartBlock: 489_802_915,
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
    publicStartBlock: 49_376_527,
  },
  {
    id: 56,
    slug: "bnb",
    name: "BNB Chain",
    nativeSymbol: "BNB",
    explorer: "https://bscscan.com",
    // Few public BNB servers keep log history. The dataseeds refuse log queries, and
    // bsc.api.pocket.network, bsc-rpc.publicnode.com and public-bsc-mainnet.fastnode.io answer
    // older ranges with an empty list, which fails the scan's check against the contract.
    // rpc.nodeflare.app allows only 17 keyless log queries a day. These two return the right logs
    // but only for 1,000 and 100 blocks a request, so BNB scans depend on a recent snapshot.
    defaultRpcs: [
      "https://bsc.rpc.sentio.xyz",
      "https://bsc.drpc.org",
    ],
    pool: {
      // Same CREATE address as Arbitrum's pool; always select the pool by chain ID.
      proxy: "0x7233d17ec3Ce855Acb8F7A9412Bf90757117A092",
      relayAdapt: "",
      deploymentBlock: 129_064_218,
    },
    tokens: TOKENS[56]!,
    publicStartBlock: 113_293_988,
  },
];

const USDC = (address: string): Token => ({ address, symbol: "USDC", name: "USD Coin", decimals: 6 });
const USDT = (address: string): Token => ({ address, symbol: "USDT", name: "Tether USD", decimals: 6 });

/**
 * The other networks Fiber takes deposits on, from omni's `asset-definitions` (chains.ts and
 * tokens.ts). They have no private pool; the page only looks for tokens at the wallet's public
 * addresses there. Servers were chosen like the pools': from Chainlist, tested for browser access.
 */
export const DEPOSIT_CHAINS: Chain[] = [
  {
    id: 137,
    slug: "polygon",
    name: "Polygon",
    nativeSymbol: "POL",
    explorer: "https://polygonscan.com",
    defaultRpcs: [
      "https://poly.api.pocket.network",
      "https://polygon-bor-rpc.publicnode.com",
      "https://polygon.drpc.org",
    ],
    tokens: [USDC("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"), USDT("0xc2132D05D31c914a87C6611C10748AEb04B58e8F")],
    publicStartBlock: 91_224_920,
  },
  {
    id: 130,
    slug: "unichain",
    name: "Unichain",
    nativeSymbol: "ETH",
    explorer: "https://uniscan.xyz",
    defaultRpcs: ["https://mainnet.unichain.org", "https://unichain-rpc.publicnode.com", "https://unichain.drpc.org"],
    tokens: [USDC("0x078D782b760474a361dDA0AF3839290b0EF57AD6")],
    publicStartBlock: 54_794_041,
  },
  {
    id: 143,
    slug: "monad",
    name: "Monad",
    nativeSymbol: "MON",
    explorer: "https://monadvision.com",
    defaultRpcs: [
      "https://rpc2.monad.xyz",
      "https://infra.originstake.com/monad/evm",
      "https://monad-rpc.huginn.tech",
    ],
    tokens: [USDC("0x754704Bc059F8C67012fEd69BC8A327a5aafb603"), USDT("0xe7cd86e13AC4309349F30B3435a9d337750fC82D")],
    publicStartBlock: 92_053_502,
  },
  {
    id: 999,
    slug: "hyperevm",
    name: "HyperEVM",
    nativeSymbol: "HYPE",
    explorer: "https://hyperevmscan.io",
    defaultRpcs: [
      "https://rpc.hyperlend.finance",
      "https://rpc.hypurrscan.io",
      "https://hyperliquid-json-rpc.stakely.io",
    ],
    tokens: [USDC("0xb88339CB7199b77E23DB6E890353E22632Ba630f"), USDT("0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb")],
    publicStartBlock: 41_974_595,
  },
  {
    id: 4663,
    slug: "robinhood",
    name: "Robinhood Chain",
    nativeSymbol: "ETH",
    explorer: "https://robinhoodchain.blockscout.com",
    defaultRpcs: [
      "https://rpc.mainnet.chain.robinhood.com",
      "https://robinhood.api.pocket.network",
      "https://rpc.degenprotocol.io/robinhood",
    ],
    tokens: [],
    publicStartBlock: 24_591_563,
  },
  {
    id: 5042,
    slug: "arc",
    name: "Arc",
    nativeSymbol: null,
    explorer: "https://explorer.arc.io",
    defaultRpcs: ["https://rpc.mainnet.arc.io", "https://rpc.quicknode.mainnet.arc.io", "https://arc-rpc.publicnode.com"],
    tokens: [USDC("0x3600000000000000000000000000000000000000")],
    publicStartBlock: 13_238_421,
  },
  {
    id: 9745,
    slug: "plasma",
    name: "Plasma",
    nativeSymbol: "XPL",
    explorer: "https://plasmascan.to",
    defaultRpcs: ["https://rpc.plasma.to"],
    tokens: [USDT("0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb")],
    publicStartBlock: 28_601_974,
  },
];

/** Every network the page reads public addresses on. */
export const ALL_CHAINS: Chain[] = [...RECOVERY_CHAINS, ...DEPOSIT_CHAINS];
