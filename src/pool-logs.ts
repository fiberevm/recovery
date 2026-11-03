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

/** Largest window asked of an RPC, so one slow server can't hold up much of a scan. */
const MAX_SPAN = 50_000;
/** Failures in a row before an RPC is dropped from a scan. */
const MAX_STRIKES = 30;
/** With other RPCs to turn to, a window that takes longer than this goes back in the queue. */
const POOLED_TIMEOUT_MS = 5_000;
/** An RPC further behind the newest one than this sits out the scan. */
const MAX_LAG_BLOCKS = 32;
/** How long the other RPCs get to report their head once the first has answered. */
const HEAD_GRACE_MS = 1_500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads every pool log in [from, to] across all the given RPCs. Workers share one queue, so faster
 * servers take more of the windows. Free RPCs cap ranges anywhere from 1k to millions of blocks,
 * so each server's windows start large and split in half when refused. A window a server fails
 * goes back in the queue for any other; the read only fails once every server has been dropped.
 */
export async function fetchPoolLogs(
  rpcUrls: URL[],
  address: string,
  from: number,
  to: number,
  onProgress: (fraction: number) => void,
): Promise<RawLog[]> {
  const total = to - from + 1;
  let done = 0;
  onProgress(0);
  const queue: Array<[number, number]> = [[from, to]];

  const logs: RawLog[] = [];
  const timeoutMs = rpcUrls.length > 1 ? POOLED_TIMEOUT_MS : undefined;
  let failure: unknown;
  const worker = async (endpoint: Endpoint) => {
    while (done < total && endpoint.strikes < MAX_STRIKES) {
      // Waits before taking a window, so servers that are ready get to it first.
      await endpoint.pacer.wait();
      const next = queue.shift();
      if (!next) {
        // The rest is with other workers, and they may hand some of it back.
        await sleep(50);
        continue;
      }
      const start = next[0];
      let end = next[1];
      // Once an RPC has refused a size, don't keep asking for it.
      if (end - start + 1 > endpoint.span) {
        queue.unshift([start + endpoint.span, end]);
        end = start + endpoint.span - 1;
      }
      try {
        const params = [{ address, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` }];
        logs.push(...(await rpc<RawLog[]>(endpoint.url, "eth_getLogs", params, timeoutMs)));
        endpoint.pacer.speedUp();
        endpoint.strikes = 0;
        done += end - start + 1;
        onProgress(done / total);
      } catch (caught) {
        queue.unshift([start, end]);
        endpoint.strikes++;
        const message = caught instanceof Error ? caught.message.toLowerCase() : "";
        if (/429|rate|too many|limit reached|exceeded/.test(message) && !/range|blocks/.test(message)) {
          endpoint.pacer.slowDown();
          failure = new RecoveryError("The RPCs kept rate-limiting the scan. Try again later or use your own RPC.");
        } else {
          failure = new RangeRefused(message);
          // A server that can't return a single block has nothing to offer.
          if (end === start) endpoint.strikes = MAX_STRIKES;
          // Use the limit when the RPC states it ("maximum 1000 blocks"); otherwise halve and retry.
          const stated = (failure as RangeRefused).maxBlocks;
          const size = stated && stated < end - start + 1 ? stated : Math.floor((end - start + 1) / 2);
          endpoint.span = Math.min(endpoint.span, Math.max(1, size));
        }
        await sleep(Math.min(1_000, endpoint.strikes * 100));
      }
    }
  };
  // One RPC gets six workers, as many gets two each.
  const perEndpoint = Math.max(2, Math.ceil(6 / rpcUrls.length));
  await Promise.all(
    rpcUrls.flatMap((url) => {
      const endpoint: Endpoint = { url, span: MAX_SPAN, strikes: 0, pacer: new Pacer() };
      return Array.from({ length: perEndpoint }, () => worker(endpoint));
    }),
  );
  if (done < total) throw failure;

  return logs.sort(
    (a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex),
  );
}

type Endpoint = { url: URL; span: number; strikes: number; pacer: Pacer };

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
  // About 16 requests a second to start with, which most free RPCs sustain.
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

/**
 * Keeps the RPCs that answer and are caught up, fastest first. Public servers trail each other by
 * a few blocks and many return an empty list for blocks they don't have yet, so `head` is the
 * newest block all of the returned RPCs have.
 */
export async function liveRpcs(rpcUrls: URL[]): Promise<{ rpcUrls: URL[]; head: number }> {
  const answers: Array<{ url: URL; head: number }> = [];
  const asks = rpcUrls.map(async (url) => void answers.push({ url, head: await rpcBlockNumber(url) }));
  await Promise.any(asks);
  await Promise.race([Promise.allSettled(asks), sleep(HEAD_GRACE_MS)]);

  const newest = Math.max(...answers.map((answer) => answer.head));
  const live = answers.filter((answer) => answer.head >= newest - MAX_LAG_BLOCKS);
  return { rpcUrls: live.map((answer) => answer.url), head: Math.min(...live.map((answer) => answer.head)) };
}

export async function rpcBlockNumber(rpcUrl: URL): Promise<number> {
  return Number.parseInt(await rpc<string>(rpcUrl, "eth_blockNumber", []), 16);
}

export async function rpc<T>(rpcUrl: URL, method: string, params: unknown[], timeoutMs = 30_000): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    // Some servers send their block limit as a 429 ("limited to 1000 blocks"), so keep the reason.
    const body = (await response.json().catch(() => null)) as { message?: string; error?: { message?: string } } | null;
    throw new Error(`HTTP ${response.status} ${body?.error?.message ?? body?.message ?? ""}`);
  }
  const payload = (await response.json()) as { result?: T; error?: { message?: string; data?: unknown } };
  if (payload.error || payload.result === undefined) {
    throw new Error(`${payload.error?.message ?? "No result"} ${JSON.stringify(payload.error?.data ?? "")}`);
  }
  return payload.result;
}

/** Asks each RPC in turn until one answers, for calls any of them can serve. */
export async function rpcAny<T>(rpcUrls: URL[], method: string, params: unknown[]): Promise<T> {
  let failure: unknown;
  for (const rpcUrl of rpcUrls) {
    try {
      return await rpc<T>(rpcUrl, method, params);
    } catch (caught) {
      failure ??= caught;
    }
  }
  throw failure;
}

/**
 * The newest block every RPC considers final, so a snapshot can never be undone by a reorg.
 * Some public servers report their head as final, so the lowest answer wins.
 */
export async function rpcFinalizedBlock(rpcUrls: URL[]): Promise<number> {
  const answers = await Promise.allSettled(
    rpcUrls.map((rpcUrl) => rpc<{ number: string }>(rpcUrl, "eth_getBlockByNumber", ["finalized", false])),
  );
  const blocks = answers.flatMap((answer) =>
    answer.status === "fulfilled" ? [Number.parseInt(answer.value.number, 16)] : [],
  );
  if (!blocks.length) throw new Error("No RPC reported a finalized block");
  return Math.min(...blocks);
}
