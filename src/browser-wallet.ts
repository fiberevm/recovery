// The user's own browser wallet (MetaMask, Rabby, …) pays gas for unshield transactions.
// Its requests go through the extension, not this page's network, and this page never sees its keys.
import type { RecoveryChain } from "./chains";
import { RecoveryError } from "./fiberseed";
import { rpc } from "./pool-logs";

type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

export type BrowserWallet = { id: string; name: string; icon?: string; provider: Eip1193Provider };

const announced = new Map<string, BrowserWallet>();

// EIP-6963 lets every installed wallet announce itself, instead of fighting over window.ethereum.
window.addEventListener("eip6963:announceProvider", (event) => {
  const { info, provider } = (event as CustomEvent<{
    info: { uuid: string; name: string; icon?: string };
    provider: Eip1193Provider;
  }>).detail;
  announced.set(info.uuid, { id: info.uuid, name: info.name, icon: info.icon, provider });
});
window.dispatchEvent(new Event("eip6963:requestProvider"));

/** Installed wallets, falling back to a legacy injected `window.ethereum`. */
export function listBrowserWallets(): BrowserWallet[] {
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  if (announced.size) return [...announced.values()];
  const injected = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  return injected ? [{ id: "injected", name: "Browser wallet", provider: injected }] : [];
}

/** Asks the wallet for an account; the user approves in the wallet's own window. */
export async function connect(wallet: BrowserWallet): Promise<string> {
  const accounts = (await walletRequest(wallet, "eth_requestAccounts")) as string[];
  if (!accounts[0]) throw new RecoveryError(`${wallet.name} didn't share an account.`);
  return accounts[0];
}

/**
 * Sends a prepared transaction on `chain` and resolves with its hash once the wallet submits it.
 * The gas limit comes from the page's own RPC plus a margin: Railgun transactions are heavy
 * (over a million gas) and some wallets' own estimates come in too tight.
 */
export async function sendTransaction(
  wallet: BrowserWallet,
  chain: RecoveryChain,
  rpcUrl: URL,
  from: string,
  transaction: { to: string; data: string },
): Promise<string> {
  let estimate: bigint;
  try {
    estimate = BigInt(await rpc<string>(rpcUrl, "eth_estimateGas", [{ from, ...transaction }]));
  } catch (caught) {
    // A failed estimate means the transaction would revert; say so before asking the wallet.
    const reason = caught instanceof Error ? caught.message.trim() : "";
    throw new RecoveryError(`This send would fail on-chain${reason ? ` (${reason})` : ""}. Nothing was sent.`);
  }
  const gas = `0x${((estimate * 125n) / 100n).toString(16)}`;

  await switchChain(wallet, chain);
  return (await walletRequest(wallet, "eth_sendTransaction", [{ from, ...transaction, gas }])) as string;
}

/**
 * Waits for a transaction through the page's own RPC, so the result doesn't rely on the wallet.
 * Throws if the transaction reverted.
 */
export async function waitForReceipt(rpcUrl: URL, hash: string, timeoutMs = 10 * 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await rpc<{ status: string } | null>(rpcUrl, "eth_getTransactionReceipt", [hash]).catch(() => null);
    if (receipt) {
      if (receipt.status !== "0x1") throw new RecoveryError("The transaction failed on-chain. Nothing was sent.");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new RecoveryError("Still waiting for the transaction. Check it on the block explorer.");
}

async function switchChain(wallet: BrowserWallet, chain: RecoveryChain) {
  const chainId = `0x${chain.id.toString(16)}`;
  try {
    await walletRequest(wallet, "wallet_switchEthereumChain", [{ chainId }]);
  } catch (caught) {
    // 4902: the wallet doesn't know this chain yet, so offer to add it.
    if (errorCode(caught) !== 4902) throw caught;
    await walletRequest(wallet, "wallet_addEthereumChain", [
      {
        chainId,
        chainName: chain.name,
        nativeCurrency: { name: chain.nativeSymbol, symbol: chain.nativeSymbol, decimals: 18 },
        rpcUrls: [chain.defaultRpc],
        blockExplorerUrls: [chain.explorer],
      },
    ]);
  }
}

async function walletRequest(wallet: BrowserWallet, method: string, params?: unknown[]): Promise<unknown> {
  try {
    return await wallet.provider.request({ method, params });
  } catch (caught) {
    // 4001: the user said no in the wallet.
    if (errorCode(caught) === 4001) throw new RecoveryError(`You cancelled this in ${wallet.name}.`);
    if (errorCode(caught) === 4902) throw caught;
    const message = (caught as { message?: string })?.message;
    throw new RecoveryError(message ? `${wallet.name}: ${message}` : `${wallet.name} couldn't do that.`);
  }
}

function errorCode(caught: unknown): number | undefined {
  const error = caught as { code?: number; data?: { originalError?: { code?: number } } };
  return error?.code ?? error?.data?.originalError?.code;
}
