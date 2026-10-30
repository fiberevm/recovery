import "./node-shims";

import {
  ABIRailgunSmartWallet,
  EngineEvent,
  MerkletreeScanStatus,
  PollingJsonRpcProvider,
  RailgunEngine,
  RailgunVersionedSmartContracts,
  TokenType,
  TransactionBatch,
  TXIDVersion,
  V2Events,
  WalletBalanceBucket,
  getTokenDataERC20,
  type CommitmentEvent,
  type Nullifier,
  type UnshieldStoredEvent,
} from "@railgun-community/engine";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { getAddress, Interface, type Result } from "ethers";
import memdown from "memdown";
import { hasCircuit, loadArtifact, variantName } from "./artifacts";
import type { RecoveryChain } from "./chains";
import { RecoveryError } from "./fiberseed";
import { fetchPoolLogs, rpcBlockNumber, type RawLog } from "./pool-logs";
import { getPoolSnapshot } from "./snapshots";

export type PrivateHolding = {
  type: "ERC20" | "ERC721" | "ERC1155";
  address: string;
  tokenId: string | null;
  amount: bigint;
};

export type ScanProgress =
  | { phase: "history"; fraction: number }
  | { phase: "decrypting" };

const TOKEN_TYPE_NAMES: Record<number, PrivateHolding["type"]> = {
  [TokenType.ERC20]: "ERC20",
  [TokenType.ERC721]: "ERC721",
  [TokenType.ERC1155]: "ERC1155",
};
const POOL_EVENTS = new Set(["Shield", "Transact", "Unshield", "Nullified"]);
const poolInterface = new Interface(ABIRailgunSmartWallet);

export type ScanTarget = { chain: RecoveryChain; rpcUrl: URL };

export type SendProgress = { phase: "proving"; fraction: number; circuit: string } | { phase: "building" };

/** A transaction for the user's own wallet to sign and submit; anyone may call `transact`. */
export type UnshieldTransaction = { to: string; data: string };

/** The unlocked wallet, kept loaded for sends and rescans until `close`. */
export type RecoverySession = {
  /** Settles when every chain's first scan has finished (each reports through its callbacks). */
  ready: Promise<void>;
  /** Proves an unshield of `amount` of an ERC-20 to `recipient`, and returns the call to submit. */
  prepareUnshield(args: {
    chain: RecoveryChain;
    tokenAddress: string;
    amount: bigint;
    recipient: string;
    onProgress: (progress: SendProgress) => void;
  }): Promise<UnshieldTransaction>;
  /** Scans one chain again from where the last scan stopped, e.g. after a send confirms. */
  rescan(chain: RecoveryChain): Promise<void>;
  close(): Promise<void>;
};

type ChainState = ScanTarget & {
  railgunChain: { type: number; id: number };
  provider: PollingJsonRpcProvider;
  historyError?: unknown;
  incomplete?: unknown;
};

const TXID_VERSION = TXIDVersion.V2_PoseidonMerkle;

/**
 * Rebuilds Fiber's Railgun wallet and reports spendable private holdings per chain as each scan
 * finishes. Pool history comes from the bundled snapshot plus RPC logs for newer blocks, and is
 * handed to the engine through its quick-sync hook; the engine then decrypts notes locally and
 * checks the rebuilt merkle roots against the pool contract, so a truncated or altered history
 * fails instead of reading as empty.
 *
 * One engine serves every chain: the engine keeps contracts in a process-wide store, and
 * unloading any engine unloads every chain's contracts. It stays loaded for sends until `close`.
 */
export async function startRecovery({
  seed,
  targets,
  onProgress,
  onDone,
  onError,
}: {
  seed: Uint8Array;
  targets: ScanTarget[];
  onProgress: (chain: RecoveryChain, progress: ScanProgress) => void;
  onDone: (chain: RecoveryChain, holdings: PrivateHolding[]) => void;
  onError: (chain: RecoveryChain, error: unknown) => void;
}): Promise<RecoverySession> {
  const states = new Map<number, ChainState>(
    targets.map((target) => [
      target.chain.id,
      {
        ...target,
        railgunChain: { type: 0, id: target.chain.id },
        provider: new PollingJsonRpcProvider(target.rpcUrl.href, target.chain.id, 10_000),
      },
    ]),
  );
  // Encrypts the engine's in-memory wallet store; needed again for every proof.
  const encryptionKey = crypto.getRandomValues(new Uint8Array(32));
  // The engine reports scan failures only through its debugger; keep the latest for diagnostics.
  let engineError: unknown;
  let closed = false;

  let engine: RailgunEngine;
  try {
    engine = await RailgunEngine.initForWallet(
      "fiberrecovery",
      // Wallet state lives in memory and disappears with the page.
      memdown(),
      {
        assertArtifactExists: (nullifiers: number, commitments: number) => {
          if (!hasCircuit(variantName(nullifiers, commitments))) {
            throw new RecoveryError("This send needs more notes than one Railgun proof can spend. Try a smaller amount.");
          }
        },
        getArtifacts: (inputs: { nullifiers: unknown[]; commitmentsOut: unknown[] }) =>
          loadArtifact(variantName(inputs.nullifiers.length, inputs.commitmentsOut.length)),
        getArtifactsPOI: async () => {
          throw new Error("Fiber's pools don't use proofs of innocence");
        },
      } as unknown as Parameters<typeof RailgunEngine.initForWallet>[2],
      async (txidVersion, railgunChain, startingBlock) => {
        const state = states.get(railgunChain.id)!;
        try {
          const { chain, rpcUrl } = state;
          const from = Math.max(startingBlock ?? 0, chain.pool.deploymentBlock);
          // Bundled history covers most blocks; the RPC is asked only for what came after it.
          const snapshot = getPoolSnapshot(chain);
          const snapshotLogs = snapshot ? snapshot.logs.filter((log) => Number(log.blockNumber) >= from) : [];
          const liveFrom = snapshot ? Math.max(from, snapshot.toBlock + 1) : from;

          const head = await rpcBlockNumber(rpcUrl);
          if (snapshot && head < snapshot.toBlock) {
            throw new RecoveryError(`The ${chain.name} RPC is behind this page's saved history. Try another RPC.`);
          }
          const liveLogs =
            head >= liveFrom
              ? await fetchPoolLogs(rpcUrl, chain.pool.proxy, liveFrom, head, (fraction) =>
                  onProgress(chain, { phase: "history", fraction }),
                )
              : [];

          const events = await toEngineEvents(txidVersion, [...snapshotLogs, ...liveLogs]);
          // Everything up to `head` is in these events, so the engine's own slow scan starts there.
          // `setLastSyncedBlock` is private in the typings but is the engine's own resume marker.
          await (engine as unknown as SyncMarker).setLastSyncedBlock(txidVersion, railgunChain, head);
          onProgress(chain, { phase: "decrypting" });
          return events;
        } catch (caught) {
          // The engine swallows quick-sync failures and falls back to a slow scan; remember it instead.
          state.historyError = caught;
          throw caught;
        }
      },
      async () => [],
      async () => true,
      async () => ({ txidIndex: undefined, merkleroot: undefined }),
      { log: () => undefined, error: (error: Error) => (engineError = error), verboseScanLogging: false },
      false,
    );
  } catch (caught) {
    encryptionKey.fill(0);
    for (const state of states.values()) state.provider.destroy();
    throw caught;
  }
  // The prover is set up on the first send, so a problem there can never block scanning.
  let proverReady: Promise<void> | undefined;
  const prepareProver = () =>
    (proverReady ??= (async () => {
      const [{ groth16 }, { buildBn128 }] = await Promise.all([import("snarkjs"), import("ffjavascript")]);
      // snarkjs's verify() takes no thread option and reuses this cached single-thread curve.
      (globalThis as { curve_bn128?: unknown }).curve_bn128 = await buildBn128(true);
      // One thread, as in Fiber's worker: worker threads would need a looser CSP.
      engine.prover.setSnarkJSGroth16(singleThreaded(groth16) as Parameters<typeof engine.prover.setSnarkJSGroth16>[0]);
    })().catch((caught) => {
      proverReady = undefined;
      throw caught;
    }));

  engine.on(
    EngineEvent.UTXOMerkletreeHistoryScanUpdate,
    (event: { scanStatus: MerkletreeScanStatus; chain: { id: number } }) => {
      const state = states.get(event.chain.id);
      if (state && event.scanStatus === MerkletreeScanStatus.Incomplete) state.incomplete = engineError ?? true;
    },
  );

  const loaded: ChainState[] = [];
  for (const state of states.values()) {
    try {
      await engine.loadNetwork(
        state.railgunChain,
        state.chain.pool.proxy,
        state.chain.pool.relayAdapt,
        "",
        "",
        "",
        state.provider,
        state.provider,
        {
          [TXIDVersion.V2_PoseidonMerkle]: state.chain.pool.deploymentBlock,
          [TXIDVersion.V3_PoseidonMerkle]: 0,
        },
        false,
      );
      loaded.push(state);
    } catch (caught) {
      onError(state.chain, new RecoveryError(`Couldn't connect to the ${state.chain.name} RPC.`, { cause: caught }));
    }
  }

  const creationBlockNumbers: number[][] = [[]];
  for (const state of loaded) creationBlockNumbers[0]![state.chain.id] = state.chain.pool.deploymentBlock;
  const wallet = await engine.createWalletFromMnemonic(
    toHex(encryptionKey),
    entropyToMnemonic(seed, wordlist),
    0,
    creationBlockNumbers,
  );

  const scan = async (state: ChainState) => {
    try {
      state.historyError = undefined;
      state.incomplete = undefined;
      await engine.scanContractHistory(state.railgunChain, [wallet.id]);
      if (state.historyError) throw state.historyError;
      if (state.incomplete) {
        const reason = state.incomplete instanceof Error ? describe(state.incomplete) : "";
        // A rebuilt tree that doesn't match the contract means the history was incomplete or wrong.
        if (reason.includes("Invalid merkleroot")) {
          throw new RecoveryError(`The ${state.chain.name} pool history didn't match the contract. Try another RPC.`);
        }
        throw new Error(`${state.chain.name} scan incomplete: ${reason}`, { cause: state.incomplete });
      }
      const balances = await wallet.getTokenBalancesAllTxidVersions(state.railgunChain, [WalletBalanceBucket.Spendable]);
      if (!closed) onDone(state.chain, aggregateHoldings(balances));
    } catch (caught) {
      if (!closed) onError(state.chain, caught);
    }
  };
  const ready = Promise.all(loaded.map(scan)).then(() => undefined);

  const stateFor = (chain: RecoveryChain) => {
    const state = states.get(chain.id);
    if (!state || !loaded.includes(state)) throw new RecoveryError(`${chain.name} isn't loaded.`);
    return state;
  };

  return {
    ready,
    async prepareUnshield({ chain, tokenAddress, amount, recipient, onProgress: onSendProgress }) {
      const state = stateFor(chain);
      let to: string;
      try {
        to = getAddress(recipient);
      } catch {
        throw new RecoveryError("That isn't a valid address.");
      }
      if (amount <= 0n) throw new RecoveryError("Enter an amount above zero.");
      await prepareProver();

      const batch = new TransactionBatch(state.railgunChain, 0n);
      batch.addUnshieldData({ toAddress: to, value: amount, tokenData: getTokenDataERC20(tokenAddress), allowOverride: false });

      let circuit = "";
      const prover = engine.prover as unknown as { artifactGetter: { getArtifacts: (inputs: never) => Promise<unknown> } };
      const getArtifacts = prover.artifactGetter.getArtifacts;
      // Report which circuit is being proved, since a non-bundled one downloads first.
      prover.artifactGetter.getArtifacts = (inputs: never) => {
        const { nullifiers, commitmentsOut } = inputs as { nullifiers: unknown[]; commitmentsOut: unknown[] };
        circuit = variantName(nullifiers.length, commitmentsOut.length);
        onSendProgress({ phase: "proving", fraction: 0, circuit });
        return getArtifacts(inputs);
      };
      try {
        const { provedTransactions } = await batch.generateTransactions(
          engine.prover,
          wallet,
          TXID_VERSION,
          toHex(encryptionKey),
          (progress) => onSendProgress({ phase: "proving", fraction: progress / 100, circuit }),
          false,
        );
        onSendProgress({ phase: "building" });
        const transaction = await RailgunVersionedSmartContracts.generateTransact(
          TXID_VERSION,
          state.railgunChain,
          provedTransactions,
        );
        return { to: String(transaction.to), data: transaction.data };
      } finally {
        prover.artifactGetter.getArtifacts = getArtifacts;
      }
    },
    rescan: (chain) => scan(stateFor(chain)),
    async close() {
      closed = true;
      encryptionKey.fill(0);
      await engine.unload().catch(() => undefined);
      for (const state of states.values()) state.provider.destroy();
    },
  };
}

type Groth16 = { fullProve: (...args: unknown[]) => Promise<unknown>; verify: unknown };

/** Same as Fiber's worker: ask snarkjs for single-threaded witness and proof generation. */
function singleThreaded(groth16: Groth16): Groth16 {
  return {
    ...groth16,
    fullProve: (input, wasm, zkey, logger, wtnsCalcOptions, proverOptions) =>
      groth16.fullProve(
        input,
        wasm,
        zkey,
        logger,
        { ...(wtnsCalcOptions as object), singleThread: true },
        { ...(proverOptions as object), singleThread: true },
      ),
  };
}

/** Formats raw logs with the engine's own V2 event processors, the same path its slow scan uses. */
async function toEngineEvents(txidVersion: TXIDVersion, logs: RawLog[]) {
  const commitmentEvents: CommitmentEvent[] = [];
  const unshieldEvents: UnshieldStoredEvent[] = [];
  const nullifierEvents: Nullifier[] = [];
  const byName = new Map<string, unknown[]>();

  for (const log of logs) {
    const parsed = poolInterface.parseLog({ topics: log.topics, data: log.data });
    if (!parsed || !POOL_EVENTS.has(parsed.name)) continue;
    const event = {
      args: recursivelyDecodeResult(parsed.args),
      transactionHash: log.transactionHash,
      blockNumber: Number(log.blockNumber),
      index: Number(log.logIndex),
    };
    byName.set(parsed.name, [...(byName.get(parsed.name) ?? []), event]);
  }

  const collectCommitments = async (_: TXIDVersion, events: CommitmentEvent[]) => void commitmentEvents.push(...events);
  // Each processor wants its own typechain log type; these are decoded the same way its scanner does.
  const of = (name: string) => (byName.get(name) ?? []) as never;
  await V2Events.processShieldEvents(txidVersion, collectCommitments, of("Shield"));
  await V2Events.processTransactEvents(txidVersion, collectCommitments, of("Transact"));
  await V2Events.processUnshieldEvents(txidVersion, async (_, events) => void unshieldEvents.push(...events), of("Unshield"));
  await V2Events.processNullifiedEvents(txidVersion, async (_, events) => void nullifierEvents.push(...events), of("Nullified"));

  return { commitmentEvents, unshieldEvents, nullifierEvents };
}

/**
 * Copied from the engine's `dist/utils/ethers.js` (not exported from the package root): the exact
 * decoding its own slow scan applies to event args before formatting them.
 */
function recursivelyDecodeResult(result: unknown): unknown {
  if (typeof result !== "object" || result === null) return result;
  const decoded = result as Result;
  try {
    const obj = decoded.toObject();
    if ("_" in obj) throw new Error("Decode as array, not object");
    for (const key of Object.keys(obj)) obj[key] = recursivelyDecodeResult(obj[key]);
    return obj;
  } catch {
    return decoded.toArray().map((item) => recursivelyDecodeResult(item));
  }
}

/* Balances */

/** Same aggregation as the Fiber CLI: positive spendable balances, merged across txid versions. */
function aggregateHoldings(
  balancesByVersion: Awaited<ReturnType<RailgunWallet["getTokenBalancesAllTxidVersions"]>>,
): PrivateHolding[] {
  const holdings = new Map<string, PrivateHolding>();
  for (const tokenBalances of Object.values(balancesByVersion)) {
    for (const treeBalance of Object.values(tokenBalances ?? {})) {
      if (treeBalance.balance <= 0n) continue;
      const type = TOKEN_TYPE_NAMES[treeBalance.tokenData.tokenType];
      if (!type) continue;
      const address = `0x${treeBalance.tokenData.tokenAddress.replace(/^0x/i, "").slice(-40).toLowerCase()}`;
      const tokenId = type === "ERC20" ? null : BigInt(treeBalance.tokenData.tokenSubID).toString();
      const key = `${type}:${address}:${tokenId ?? ""}`;
      holdings.set(key, {
        type,
        address,
        tokenId,
        amount: (holdings.get(key)?.amount ?? 0n) + treeBalance.balance,
      });
    }
  }
  return [...holdings.values()];
}

/** Flattens an error and its causes into one line, since the engine wraps the real reason. */
function describe(error: Error): string {
  const parts: string[] = [];
  for (let current: unknown = error; current instanceof Error; current = current.cause) parts.push(current.message);
  return parts.join(" ← ");
}

type SyncMarker = {
  setLastSyncedBlock(txidVersion: TXIDVersion, chain: { type: number; id: number }, block: number): Promise<void>;
};

type RailgunWallet = Awaited<ReturnType<RailgunEngine["createWalletFromMnemonic"]>>;

const toHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
