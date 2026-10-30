/**
 * Test helper: shields fUSDT0 to the test wallet (fixtures/test-wallet.fiberseed) on a local
 * Arbitrum fork, so scans and sends can be tried without real funds. Only Fiber's bundler may
 * shield, so it impersonates the bundler, funding it from the pool's own fUSDT0.
 *
 *   anvil --fork-url https://arb1.arbitrum.io/rpc
 *   bun scripts/fork-shield.ts 100 25.5      # one note per amount
 *
 * Then open the page, set the Arbitrum RPC to http://127.0.0.1:8545 under RPC settings, and unlock
 * the test backup. Sending needs a browser wallet connected to the same fork.
 */
import { ABIRailgunSmartWallet, RailgunEngine, ShieldNoteERC20 } from "@railgun-community/engine";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { Interface } from "ethers";
import memdown from "memdown";

const RPC = "http://127.0.0.1:8545";
const POOL = "0x7233d17ec3Ce855Acb8F7A9412Bf90757117A092";
const BUNDLER = "0x3674DCF19Df34505E091Df4882318A1e99eD3e29";
const FUSDT0 = "0x5a847BE0F397a57C8f7E4193AF093F4f0A422571";
// fUSDT0 has 6 decimals on Arbitrum.
const amounts = (process.argv.slice(2).length ? process.argv.slice(2) : ["100"]).map((value) =>
  BigInt(Math.round(Number(value) * 1e6)),
);

const rpc = async (method: string, params: unknown[]) => {
  const j: any = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
};
const send = async (from: string, to: string, data: string) => {
  const hash = await rpc("eth_sendTransaction", [{ from, to, data, gas: "0x1000000" }]);
  let receipt = null;
  for (let i = 0; i < 50 && !receipt; i++) {
    receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (!receipt) await Bun.sleep(200);
  }
  if (receipt?.status !== "0x1") throw new Error(`tx to ${to} reverted or never mined`);
};
const erc20 = new Interface(["function transfer(address,uint256)", "function approve(address,uint256)"]);

const engine = await RailgunEngine.initForWallet("shieldfixture", memdown(), {} as any, async () => ({ commitmentEvents: [], unshieldEvents: [], nullifierEvents: [] }), async () => [], async () => true, async () => ({ txidIndex: undefined, merkleroot: undefined }), undefined, false);
const wallet = await engine.createWalletFromMnemonic("00".repeat(32), entropyToMnemonic(new Uint8Array(32), wordlist), 0);
const { masterPublicKey, viewingPublicKey } = wallet.addressKeys;

const requests = [];
for (const value of amounts) {
  const note = new ShieldNoteERC20(masterPublicKey, Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex"), value, FUSDT0);
  requests.push(await note.serialize(crypto.getRandomValues(new Uint8Array(32)), viewingPublicKey));
}

const total = amounts.reduce((a, b) => a + b, 0n);
for (const account of [POOL, BUNDLER]) await rpc("anvil_impersonateAccount", [account]);
await rpc("anvil_setBalance", [BUNDLER, "0x56BC75E2D63100000"]);
await rpc("anvil_setBalance", [POOL, "0x56BC75E2D63100000"]);
await send(POOL, FUSDT0, erc20.encodeFunctionData("transfer", [BUNDLER, total]));
await send(BUNDLER, FUSDT0, erc20.encodeFunctionData("approve", [POOL, total]));
await send(BUNDLER, POOL, new Interface(ABIRailgunSmartWallet).encodeFunctionData("shield", [requests]));
console.log(`Shielded ${amounts.map((a) => Number(a) / 1e6).join(" + ")} fUSDT0 to the test wallet at block ${parseInt(await rpc("eth_blockNumber", []), 16)}`);
process.exit(0);
