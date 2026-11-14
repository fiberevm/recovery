/**
 * Scans a local fork of Base through an RPC that leaves one block's pool logs out of its
 * eth_getLogs answers, as some public RPCs do by answering a window with an empty list. The hole
 * sits before two notes shielded to the test wallet: the scan used to stop building the tree at it
 * and report an empty wallet. Needs Foundry's `anvil` and a Base RPC that serves archive state
 * (BASE_FORK_URL, default Sentio's public endpoint):
 *
 *   bun test test/history-gap.test.ts
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { ABIRailgunSmartWallet, RailgunEngine, ShieldNoteERC20 } from "@railgun-community/engine";
import { Interface, Mnemonic } from "ethers";
import memdown from "memdown";
import { RECOVERY_CHAINS, type RecoveryChain } from "../src/chains";
import type { RawLog } from "../src/pool-logs";
import type { PrivateHolding } from "../src/railgun";
import { getPoolSnapshot, type PoolSnapshot } from "../src/snapshots";

const FORK_URL = process.env.BASE_FORK_URL ?? "https://base.rpc.sentio.xyz";
const ANVIL_PORT = 18545;
const FAULTY_PORT = 18546;
const ANVIL = `http://127.0.0.1:${ANVIL_PORT}`;
const FAULTY = `http://127.0.0.1:${FAULTY_PORT}`;

const base = RECOVERY_CHAINS.find((chain) => chain.slug === "base")!;
// Fiber's bundler is the only address the pool lets shield.
const BUNDLER = "0x3674DCF19Df34505E091Df4882318A1e99eD3e29";
// USDC Prime vault shares, which the pool holds plenty of to fund the bundler from.
const TOKEN = "0xA1168D47Fc27775153f210c663BdCb3761070c8F";
const FIRST = 10n ** 17n;
const SECOND = 2n * 10n ** 17n;

// The newest block with pool logs in the bundled history. The scan gets that history cut off just
// before it, so the block is read from the RPC, and the fork starts there.
const bundled = getPoolSnapshot(base)!;
const hiddenBlock = Number(bundled.logs.at(-1)!.blockNumber);
const cutSnapshot: PoolSnapshot = {
  ...bundled,
  toBlock: hiddenBlock - 1,
  logs: bundled.logs.filter((log) => Number(log.blockNumber) < hiddenBlock),
};
mock.module("../src/snapshots", () => ({
  getPoolSnapshot: (chain: RecoveryChain) => (chain.id === base.id ? cutSnapshot : null),
}));

const hasAnvil = Bun.which("anvil") !== null;
let anvil: ReturnType<typeof Bun.spawn> | undefined;
let faulty: ReturnType<typeof Bun.serve> | undefined;
/** "once" acts like a node behind a load balancer that hasn't indexed the block yet. */
let hide: "once" | "always" = "once";
let hidden = 0;

const rpc = async (method: string, params: unknown[]) => {
  const response = await fetch(ANVIL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = (await response.json()) as { result?: any; error?: unknown };
  if (payload.error) throw new Error(`${method}: ${JSON.stringify(payload.error)}`);
  return payload.result;
};

/** Sends from an impersonated account and waits for it to succeed. */
const send = async (from: string, to: string, data: string) => {
  const hash = await rpc("eth_sendTransaction", [{ from, to, data, gas: "0x1000000" }]);
  for (let attempt = 0; attempt < 50; attempt++) {
    const receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (receipt) {
      if (receipt.status !== "0x1") throw new Error(`transaction to ${to} reverted`);
      return;
    }
    await Bun.sleep(200);
  }
  throw new Error(`transaction to ${to} never mined`);
};

beforeAll(async () => {
  if (!hasAnvil) return;
  anvil = Bun.spawn([
    "anvil",
    ...["--fork-url", FORK_URL, "--fork-block-number", String(hiddenBlock)],
    ...["--port", String(ANVIL_PORT), "--chain-id", String(base.id), "--silent"],
  ]);
  for (let attempt = 0; ; attempt++) {
    try {
      await rpc("eth_blockNumber", []);
      break;
    } catch (caught) {
      if (attempt > 100) throw caught;
      await Bun.sleep(200);
    }
  }

  // The test wallet from fixtures/test-wallet.fiberseed: 32 zero bytes of entropy.
  const engine = await RailgunEngine.initForWallet(
    "historygap",
    memdown(),
    {} as never,
    async () => ({ commitmentEvents: [], unshieldEvents: [], nullifierEvents: [] }),
    async () => [],
    async () => true,
    async () => ({ txidIndex: undefined, merkleroot: undefined }),
    undefined,
    false,
  );
  const wallet = await engine.createWalletFromMnemonic("00".repeat(32), Mnemonic.fromEntropy(new Uint8Array(32)).phrase, 0);
  const { masterPublicKey, viewingPublicKey } = wallet.addressKeys;
  const shieldRequest = (value: bigint) =>
    new ShieldNoteERC20(
      masterPublicKey,
      Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex"),
      value,
      TOKEN,
    ).serialize(crypto.getRandomValues(new Uint8Array(32)), viewingPublicKey);

  const erc20 = new Interface(["function transfer(address,uint256)", "function approve(address,uint256)"]);
  const pool = new Interface(ABIRailgunSmartWallet);
  const proxy = base.pool.proxy;
  for (const account of [proxy, BUNDLER]) {
    await rpc("anvil_impersonateAccount", [account]);
    await rpc("anvil_setBalance", [account, "0x56BC75E2D63100000"]);
  }
  await send(proxy, TOKEN, erc20.encodeFunctionData("transfer", [BUNDLER, FIRST + SECOND]));
  await send(BUNDLER, TOKEN, erc20.encodeFunctionData("approve", [proxy, FIRST + SECOND]));
  for (const value of [FIRST, SECOND]) {
    await send(BUNDLER, proxy, pool.encodeFunctionData("shield", [[await shieldRequest(value)]]));
  }
  await engine.unload();

  faulty = Bun.serve({
    port: FAULTY_PORT,
    async fetch(request) {
      const body = (await request.json()) as { id?: number; method?: string; params?: Array<{ fromBlock?: string }> };
      // A failed quick sync makes the engine fall back to its own scan from the pool's first
      // block. Refuse it, so the scan reports the failure without reading the whole chain.
      if (body.method === "eth_getLogs" && Number(body.params?.[0]?.fromBlock) <= base.pool.deploymentBlock) {
        return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "not in this test" } });
      }
      const upstream = await fetch(ANVIL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await upstream.json()) as { result?: unknown };
      if (body.method === "eth_getLogs" && Array.isArray(payload.result)) {
        const logs = payload.result as RawLog[];
        const kept = logs.filter((log) => Number(log.blockNumber) !== hiddenBlock);
        if (kept.length < logs.length && (hide === "always" || hidden++ === 0)) payload.result = kept;
      }
      return Response.json(payload);
    },
  });
}, 120_000);

afterAll(() => {
  faulty?.stop(true);
  anvil?.kill();
});

/** Runs one Base scan of the test wallet and settles with its holdings or its error. */
async function scan(mode: typeof hide): Promise<PrivateHolding[]> {
  hide = mode;
  hidden = 0;
  const { startRecovery } = await import("../src/railgun");
  let outcome: { holdings?: PrivateHolding[]; error?: unknown } = {};
  const session = await startRecovery({
    seed: new Uint8Array(32),
    targets: [{ chain: base, rpcUrls: [new URL(FAULTY)] }],
    onProgress: () => undefined,
    onDone: (_, holdings) => (outcome = { holdings }),
    onError: (_, error) => (outcome = { error }),
  });
  await session.ready;
  await session.close();
  if (outcome.error) throw outcome.error;
  return outcome.holdings!;
}

test.skipIf(!hasAnvil)(
  "reads a block again when the RPC first leaves its logs out",
  async () => {
    expect(await scan("once")).toEqual([{ type: "ERC20", address: TOKEN.toLowerCase(), tokenId: null, amount: FIRST + SECOND }]);
    expect(hidden).toBeGreaterThan(1);
  },
  300_000,
);

test.skipIf(!hasAnvil)(
  "fails instead of reading as empty when the RPC never returns the block",
  async () => {
    await expect(scan("always")).rejects.toThrow("left out part of the pool history");
  },
  300_000,
);
