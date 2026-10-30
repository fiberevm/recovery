// Pool history bundled into the page, written by `bun run snapshot` (scripts/snapshot.ts).
// A scan replays these logs and asks the RPC only for blocks after `toBlock`. The snapshot isn't
// trusted: the engine checks the rebuilt merkle root against the live contract, so missing or
// altered logs fail the scan.
import type { RecoveryChain } from "./chains";
import type { RawLog } from "./pool-logs";
import arbitrum from "./snapshots/arbitrum.json";
import base from "./snapshots/base.json";
import bnb from "./snapshots/bnb.json";

/** One log as [block, logIndex, transactionHash, topics, data]; tuples keep the page smaller. */
export type SnapshotLog = [number, number, string, string[], string];

export type PoolSnapshotFile = {
  chainId: number;
  proxy: string;
  fromBlock: number;
  /** Last block covered; the chain's finalized block when the snapshot was taken. */
  toBlock: number;
  createdAt: string;
  logs: SnapshotLog[];
};

export type PoolSnapshot = { fromBlock: number; toBlock: number; createdAt: string; logs: RawLog[] };

const FILES = [arbitrum, base, bnb] as PoolSnapshotFile[];

/** Returns the bundled history for a chain's pool, or null if none matches it. */
export function getPoolSnapshot(chain: RecoveryChain): PoolSnapshot | null {
  const file = FILES.find(
    (candidate) => candidate.chainId === chain.id && candidate.proxy.toLowerCase() === chain.pool.proxy.toLowerCase(),
  );
  // A snapshot that starts after the deployment would silently skip early history.
  if (!file || file.fromBlock > chain.pool.deploymentBlock || file.toBlock < file.fromBlock) return null;

  return {
    fromBlock: file.fromBlock,
    toBlock: file.toBlock,
    createdAt: file.createdAt,
    logs: file.logs.map(([block, logIndex, transactionHash, topics, data]) => ({
      blockNumber: `0x${block.toString(16)}`,
      logIndex: `0x${logIndex.toString(16)}`,
      transactionHash,
      topics,
      data,
    })),
  };
}
