// Reads a pool contract's logs over JSON-RPC. Kept free of the Railgun engine so the snapshot
// script (scripts/snapshot.ts) can use exactly the same fetching as the page.
import { RecoveryError } from "./fiberseed";

export type RawLog = {
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
  topics: string[];
  data: string;
};

/**
 * Reads every pool log in [from, to]. Free RPCs cap ranges anywhere from 1k to millions of
 * blocks, so windows start large, split in half when refused, and run a few at a time.
 */
export async function fetchPoolLogs(
  rpcUrl: URL,
  address: string,
  from: number,
  to: number,
  onProgress: (fraction: number) => void,
): Promise<RawLog[]> {
  const total = to - from + 1;
  let done = 0;
  onProgress(0);
  let span = 500_000;
  const queue: Array<[number, number]> = [];
  for (let start = from; start <= to; start += span) queue.push([start, Math.min(to, start + span - 1)]);

  const logs: RawLog[] = [];
  const pacer = new Pacer();
  const worker = async () => {
    while (queue.length) {
      const [start, end] = queue.shift()!;
      // Once an RPC has refused a size, don't keep asking for it.
      if (end - start + 1 > span) {
        const middle = start + span - 1;
        queue.unshift([start, middle], [middle + 1, end]);
        continue;
      }
      try {
        logs.push(...(await getLogsWithRetry(rpcUrl, pacer, address, start, end)));
        done += end - start + 1;
        onProgress(done / total);
      } catch (caught) {
        if (!(caught instanceof RangeRefused) || end === start) throw caught;
        // Use the limit when the RPC states it ("maximum 1000 blocks"); otherwise halve and retry.
        const stated = caught.maxBlocks;
        const next = stated && stated < end - start + 1 ? stated : Math.floor((end - start + 1) / 2);
        span = Math.min(span, Math.max(1, next));
        queue.unshift([start, end]);
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  return logs.sort(
    (a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex),
  );
}

class RangeRefused extends Error {
  /** The block limit the RPC named in its error, if it named one. */
  readonly maxBlocks: number | undefined;

  constructor(message: string) {
    super(message);
    // "maximum 1000 blocks", "ranges over 10000 blocks", "exceed maximum block range: 5000".
    const match = message.match(/(?:maximum|max|over|up to|limited to)\D{0,30}?(\d[\d,]*)/i);
    const value = match ? Number(match[1]!.replace(/,/g, "")) : Number.NaN;
    this.maxBlocks = Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
}

/**
 * Spaces out request starts across all workers. Free RPCs rate-limit at very different speeds,
 * so the gap widens on each rate-limit error and narrows again as requests succeed.
 */
class Pacer {
  // Tenderly's free Base endpoint, the slowest default, sustains about 10–12 requests a second.
  private gapMs = 60;
  private nextAt = 0;

  async wait() {
    const now = Date.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + this.gapMs;
    if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
  }

  slowDown() {
    this.gapMs = Math.min(1_000, this.gapMs * 1.3);
  }

  speedUp() {
    // Recover quickly; this settles where roughly one request in ten is rate-limited.
    this.gapMs = Math.max(40, this.gapMs * 0.95);
  }
}

async function getLogsWithRetry(
  rpcUrl: URL,
  pacer: Pacer,
  address: string,
  start: number,
  end: number,
): Promise<RawLog[]> {
  for (let attempt = 0; ; attempt++) {
    await pacer.wait();
    try {
      const logs = await rpc<RawLog[]>(rpcUrl, "eth_getLogs", [
        { address, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` },
      ]);
      pacer.speedUp();
      return logs;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message.toLowerCase() : "";
      const rateLimited = /429|rate|too many|limit reached|exceeded/.test(message) && !/range|blocks/.test(message);
      if (!rateLimited) throw new RangeRefused(message);
      if (attempt >= 30) {
        throw new RecoveryError("The RPC kept rate-limiting the scan. Try again later or use your own RPC.");
      }
      pacer.slowDown();
    }
  }
}

export async function rpcBlockNumber(rpcUrl: URL): Promise<number> {
  return Number.parseInt(await rpc<string>(rpcUrl, "eth_blockNumber", []), 16);
}

export async function rpc<T>(rpcUrl: URL, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as { result?: T; error?: { message?: string; data?: unknown } };
  if (payload.error || payload.result === undefined) {
    throw new Error(`${payload.error?.message ?? "No result"} ${JSON.stringify(payload.error?.data ?? "")}`);
  }
  return payload.result;
}

/** The newest block the chain considers final, so a snapshot can never be undone by a reorg. */
export async function rpcFinalizedBlock(rpcUrl: URL): Promise<number> {
  const block = await rpc<{ number: string }>(rpcUrl, "eth_getBlockByNumber", ["finalized", false]);
  return Number.parseInt(block.number, 16);
}
