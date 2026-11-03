/**
 * Writes the pool history bundled into the page (src/snapshots/<chain>.json), up to each chain's
 * finalized block. Existing snapshots are extended from where they stop; `--full` starts over
 * from the deployment block.
 *
 * Usage: bun scripts/snapshot.ts [--full] [--only <slug>] [--arbitrum-rpc URL] [--base-rpc URL] [--bnb-rpc URL]
 *
 * Without one, a chain reads from all its public defaults. RPCs can also come from ETHEREUM_RPC_URL,
 * ARBITRUM_RPC_URL, BASE_RPC_URL and BNB_RPC_URL (omni's names), which keeps keyed URLs out of shell
 * history. Keyed URLs are never printed.
 */
import { resolve } from "node:path";
import { RECOVERY_CHAINS } from "../src/chains";
import { fetchPoolLogs, liveRpcs, rpcFinalizedBlock } from "../src/pool-logs";
import type { PoolSnapshotFile, SnapshotLog } from "../src/snapshots";

const args = process.argv.slice(2);
const full = args.includes("--full");
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const only = option("--only");
for (const chain of RECOVERY_CHAINS.filter((candidate) => !only || candidate.slug === only)) {
  const key = chain.slug;
  const path = resolve(import.meta.dir, `../src/snapshots/${key}.json`);
  const custom = option(`--${key}-rpc`) ?? process.env[`${key.toUpperCase()}_RPC_URL`];
  const live = await liveRpcs(custom ? [new URL(custom)] : chain.defaultRpcs.map((url) => new URL(url)));
  // Provider URLs often carry an API key, so only name the public defaults.
  const via = custom ? "your RPC" : `${live.rpcUrls.length} public RPCs`;

  const existing = full ? null : await readSnapshot(path);
  const usable =
    existing &&
    existing.chainId === chain.id &&
    existing.proxy.toLowerCase() === chain.pool.proxy.toLowerCase() &&
    existing.fromBlock <= chain.pool.deploymentBlock;
  const fromBlock = usable ? existing.toBlock + 1 : chain.pool.deploymentBlock;
  const logs: SnapshotLog[] = usable ? existing.logs : [];

  const toBlock = Math.min(await rpcFinalizedBlock(live.rpcUrls), live.head);
  if (toBlock < fromBlock) {
    console.log(`${chain.name}: already at finalized block ${toBlock.toLocaleString()}`);
    continue;
  }

  console.log(`${chain.name}: blocks ${fromBlock.toLocaleString()}–${toBlock.toLocaleString()} via ${via}`);
  const started = Date.now();
  let lastStep = -1;
  const fresh = await fetchPoolLogs(live.rpcUrls, chain.pool.proxy, fromBlock, toBlock, (fraction) => {
    const step = Math.floor(fraction * 10);
    if (step !== lastStep) {
      lastStep = step;
      console.log(`  ${step * 10}% · ${Math.round((Date.now() - started) / 1000)}s`);
    }
  });

  for (const log of fresh) {
    logs.push([Number(log.blockNumber), Number(log.logIndex), log.transactionHash, log.topics, log.data]);
  }
  logs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const snapshot: PoolSnapshotFile = {
    chainId: chain.id,
    proxy: chain.pool.proxy,
    fromBlock: chain.pool.deploymentBlock,
    toBlock,
    createdAt: new Date().toISOString(),
    logs,
  };
  await Bun.write(path, serialize(snapshot));
  console.log(`  ${fresh.length} new logs, ${logs.length} total → src/snapshots/${key}.json`);
}

async function readSnapshot(path: string): Promise<PoolSnapshotFile | null> {
  const file = Bun.file(path);
  return (await file.exists()) ? ((await file.json()) as PoolSnapshotFile) : null;
}

/** One log per line keeps snapshot updates readable in a diff. */
function serialize({ logs, ...header }: PoolSnapshotFile): string {
  const fields = JSON.stringify(header, null, 2).slice(0, -2);
  const lines = logs.map((log) => `    ${JSON.stringify(log)}`).join(",\n");
  return `${fields},\n  "logs": [\n${lines}\n  ]\n}\n`;
}
