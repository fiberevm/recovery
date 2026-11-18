// Sends a public holding with the key the backup derives for its address. The transaction is
// signed here and submitted through the user's RPCs, so no browser wallet is involved unless the
// address has nothing to pay the network fee with (src/app.ts then tops it up first).
import { Interface, keccak256, Wallet } from "ethers";
import type { Chain } from "./chains";
import { RecoveryError } from "./fiberseed";
import { rpcAny } from "./pool-logs";
import { NATIVE_TOKEN } from "./public-holdings";

const erc20 = new Interface(["function transfer(address to, uint256 amount) returns (bool)"]);
/** On OP Stack chains (Base, Unichain) a second fee for posting the data is taken from the sender. */
const OP_GAS_ORACLE = "0x420000000000000000000000000000000000000F";
const opOracle = new Interface(["function getL1Fee(bytes data) view returns (uint256)"]);
/** Used to size the fee when the real estimate can't be had before the address holds any gas. */
const FALLBACK_TOKEN_GAS = 100_000n;

export type PublicSendInput = {
  chain: Chain;
  rpcUrls: URL[];
  privateKey: string;
  /** Lowercase contract address, or `NATIVE_TOKEN`. */
  tokenAddress: string;
  decimals: number;
  amount: bigint;
  recipient: string;
};

export type PreparedSend = {
  from: string;
  /** What will arrive. Less than asked when the fee comes out of the same balance. */
  amount: bigint;
  /** The most the network fee can come to, in the gas token's 18-decimal units. */
  fee: bigint;
  /** How much gas token the address is missing to pay `fee`; zero when it can pay. */
  shortfall: bigint;
  /** The signed transaction, ready for `broadcast`. */
  raw: string;
};

const hex = (value: bigint) => `0x${value.toString(16)}`;

/** The token fees are paid in. Arc has no separate gas token: its USDC, listed first, pays them. */
export const gasSymbol = (chain: Chain) => chain.nativeSymbol ?? chain.tokens[0]?.symbol ?? "gas token";

/** Reads the nonce and fee, works out what can be sent, and signs. Nothing is submitted. */
export async function preparePublicSend(input: PublicSendInput): Promise<PreparedSend> {
  const { chain, rpcUrls, tokenAddress, recipient } = input;
  const wallet = new Wallet(input.privateKey);
  const from = wallet.address;
  const native = tokenAddress === NATIVE_TOKEN;
  // The same balance pays the fee: the gas token itself, or on Arc the USDC contract's view of it.
  const paysOwnFee = native || (!chain.nativeSymbol && tokenAddress === chain.tokens[0]?.address.toLowerCase());
  const request = (value: bigint) =>
    native
      ? { to: recipient, value, data: "0x" }
      : { to: tokenAddress, value: 0n, data: erc20.encodeFunctionData("transfer", [recipient, value]) };

  const [nonce, price, have] = await Promise.all([
    rpcAny<string>(rpcUrls, "eth_getTransactionCount", [from, "pending"]),
    rpcAny<string>(rpcUrls, "eth_gasPrice", []),
    rpcAny<string>(rpcUrls, "eth_getBalance", [from, "latest"]),
  ]).then((answers) => answers.map((answer) => BigInt(answer)) as [bigint, bigint, bigint]);

  let estimate: bigint;
  try {
    const probe = request(native ? 1n : input.amount);
    estimate = BigInt(
      await rpcAny<string>(rpcUrls, "eth_estimateGas", [{ from, to: probe.to, data: probe.data, value: hex(probe.value) }]),
    );
  } catch (caught) {
    // Some servers won't estimate for an address with no gas; size the fee and let it be topped up.
    if (have > 0n || paysOwnFee) {
      const reason = caught instanceof Error ? caught.message.trim() : "";
      throw new RecoveryError(`This send would fail on-chain${reason ? ` (${reason})` : ""}. Nothing was sent.`);
    }
    estimate = FALLBACK_TOKEN_GAS;
  }
  // Margins for a busier block by the time it lands; what isn't used stays in the address.
  const gasLimit = (estimate * 125n) / 100n;
  const gasPrice = (price * 125n) / 100n;
  const sign = (value: bigint) =>
    wallet.signTransaction({ type: 0, chainId: chain.id, nonce: Number(nonce), gasLimit, gasPrice, ...request(value) });

  let dataFee = 0n;
  try {
    const answer = await rpcAny<string>(rpcUrls, "eth_call", [
      { to: OP_GAS_ORACLE, data: opOracle.encodeFunctionData("getL1Fee", [await sign(input.amount)]) },
      "latest",
    ]);
    dataFee = BigInt(answer) * 2n;
  } catch {
    // Not an OP Stack chain.
  }
  const fee = gasLimit * gasPrice + dataFee;

  let amount = input.amount;
  let shortfall = 0n;
  if (paysOwnFee) {
    // Arc's USDC contract counts in 6 decimals what the chain itself counts in 18.
    const unit = native ? 1n : 10n ** BigInt(18 - input.decimals);
    const sendable = have / unit - (fee + unit - 1n) / unit;
    if (sendable <= 0n) throw new RecoveryError("This balance is smaller than the network fee to send it.");
    if (amount > sendable) amount = sendable;
  } else if (have < fee) {
    shortfall = fee - have;
  }
  return { from, amount, fee, shortfall, raw: await sign(amount) };
}

/** Submits a signed transaction and resolves with its hash. */
export async function broadcast(rpcUrls: URL[], raw: string): Promise<string> {
  const hash = keccak256(raw);
  try {
    await rpcAny<string>(rpcUrls, "eth_sendRawTransaction", [raw]);
  } catch (caught) {
    // One server may have taken it before failing to answer, and the next then refuses a repeat.
    const known = await rpcAny<unknown>(rpcUrls, "eth_getTransactionByHash", [hash]).catch(() => null);
    if (!known) {
      const reason = caught instanceof Error ? caught.message.trim() : "";
      throw new RecoveryError(`The network didn't accept this send${reason ? ` (${reason})` : ""}. Nothing was sent.`);
    }
  }
  return hash;
}
