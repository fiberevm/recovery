import { ARTIFACT_GATEWAY, BUNDLED_VARIANTS } from "./artifact-variants";
import { connect, listBrowserWallets, sendTransaction, waitForReceipt } from "./browser-wallet";
import { networkIcon } from "./network-icons";
import { ALL_CHAINS, type Chain, type RecoveryChain, type Token } from "./chains";
import { addressKind, evmAddresses, findPrivateKey, keyAt, MAX_DERIVATION_INDEX, type RecoveredKey } from "./derive";
import {
  NATIVE_TOKEN,
  PUBLIC_ADDRESS_COUNT,
  readBalances,
  transferScan,
  type TransferScan,
  sweepBalances,
  type Owner,
  type PublicAsset,
} from "./public-holdings";
import {
  decryptFiberSeed,
  MAX_FIBERSEED_BYTES,
  parseFiberSeedFile,
  RecoveryError,
  type FiberSeedFile,
  type PublicHolding,
} from "./fiberseed";
import { broadcast, gasSymbol, preparePublicSend, type PublicSendInput } from "./public-send";
import { CATEGORIES, marketFor, type Category, type Market } from "./market";
import { watchPrices, type PriceWatcher } from "./prices";
import { formatUnits, parseRpcUrls } from "./rpc";
import { getAddress, Interface } from "ethers";
import type { PrivateHolding, RecoverySession, ScanProgress, SendProgress } from "./railgun";

/** ERC-4626: burns the owner's shares and pays the underlying token to the receiver. */
const VAULT = new Interface(["function redeem(uint256 shares, address receiver, address owner) returns (uint256)"]);

/** One network's scan, shown as a chip under the balance. */
type ChainStatus = {
  state: "scanning" | "done" | "failed";
  progress: (progress: ScanProgress) => void;
  done: (holdings: PrivateHolding[]) => void;
  fail: (error: unknown) => void;
};

/** One holding on one network: its own row, never merged with the same asset elsewhere. */
type Row = {
  key: string;
  chain: Chain;
  rpcUrls: URL[];
  token: Token | undefined;
  market: Market;
  holding: PrivateHolding;
  /** Set for a balance at one of the wallet's own addresses, outside the private pool. */
  owner?: Owner;
  el: HTMLLIElement;
  earn: HTMLElement;
  amount: HTMLElement;
  sub: HTMLElement;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const unlockView = $("unlock-view");
const walletView = $("wallet-view");
const form = $<HTMLFormElement>("unlock-form");
const dropzone = $<HTMLLabelElement>("dropzone");
const fileInput = $<HTMLInputElement>("file-input");
const dropzoneTitle = $("dropzone-title");
const dropzoneHint = $("dropzone-hint");
const iconEmpty = $("dropzone-icon-empty");
const iconLoaded = $("dropzone-icon-loaded");
const passwordStep = $("password-step");
const passwordInput = $<HTMLInputElement>("password");
const errorText = $("error");
const unlockButton = $<HTMLButtonElement>("unlock-button");
const rpcSettings = $<HTMLDetailsElement>("rpc-settings");
const rpcFields = $("rpc-fields");
const tabs = $("tabs");
const heroBalance = $("hero-balance");
const heroNote = $("hero-note");
const networks = $("networks");
const networkErrors = $("network-errors");
const notices = $("notices");
const sections = $("sections");
const elsewhere = $("elsewhere");
const publicStatus = $("public-status");
const publicText = $("public-text");
const deepScan = $<HTMLButtonElement>("deep-scan");
const keyForm = $<HTMLFormElement>("key-form");
const keyAddress = $<HTMLInputElement>("key-address");
const keyButton = $<HTMLButtonElement>("key-button");
const keyError = $("key-error");
const keyResult = $("key-result");
const keyValue = $("key-value");
const keyReveal = $<HTMLButtonElement>("key-reveal");
const lockButton = $<HTMLButtonElement>("lock-button");

const COPY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V7a2.5 2.5 0 0 0-2.5-2.5H7A2.5 2.5 0 0 0 4.5 7v6A2.5 2.5 0 0 0 7 15.5h1.5"/></svg>';
const CHECK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

let backup: FiberSeedFile | null = null;
// Needed by both sections; wiped on lock and when the page goes away.
let seed: Uint8Array | null = null;
let unlocking = false;
let scanning = false;
// The unlocked Railgun wallet, kept for sends until the page is locked.
let recovery: RecoverySession | null = null;
// Each lock bumps this, so results from a scan or search started earlier are dropped.
let session = 0;
// Origins written into the runtime CSP. Policies only ever tighten, so these are fixed per page load.
let lockedOrigins: Set<string> | null = null;
// Everything the holdings view shows, rebuilt from scratch on each unlock.
const rows = new Map<string, Row>();
const statuses = new Map<number, ChainStatus>();
let prices: PriceWatcher | null = null;
let ticker: ReturnType<typeof setInterval> | undefined;
// The backup's own list of public holdings: a head start, never the whole answer.
let publicHints: PublicHolding[] = [];
let publicHintsTruncated = false;
// True while the first pass over the wallet's public addresses runs, so the total waits for it.
let sweeping = false;

/* File selection */

async function loadFile(file: File) {
  clearError(errorText);
  backup = null;
  try {
    if (file.size > MAX_FIBERSEED_BYTES) throw new RecoveryError("This file is too large to be a Fiber backup.");
    backup = parseFiberSeedFile(await file.text());
    showLoadedFile(file.name, backup.createdAt);
    passwordInput.focus();
  } catch (caught) {
    resetDropzone();
    showError(caught, errorText);
  }
  syncUnlockButton();
}

function showLoadedFile(name: string, createdAt: string | undefined) {
  dropzone.classList.add("dropzone--loaded");
  // SVG elements have no `hidden` property, so toggle the attribute itself.
  iconEmpty.toggleAttribute("hidden", true);
  iconLoaded.toggleAttribute("hidden", false);
  passwordStep.hidden = false;
  dropzoneTitle.textContent = name;
  const created = createdAt ? new Date(createdAt) : null;
  dropzoneHint.textContent =
    created && !Number.isNaN(created.getTime())
      ? `Backup from ${created.toLocaleDateString(undefined, { dateStyle: "medium" })} · Choose another`
      : "Choose another";
}

function resetDropzone() {
  dropzone.classList.remove("dropzone--loaded", "dropzone--active");
  iconEmpty.toggleAttribute("hidden", false);
  iconLoaded.toggleAttribute("hidden", true);
  passwordStep.hidden = true;
  passwordInput.value = "";
  passwordInput.classList.remove("field__input--error");
  dropzoneTitle.textContent = "Drop your .fiberseed file";
  dropzoneHint.textContent = "or click to browse";
  fileInput.value = "";
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void loadFile(file);
});

// A file dropped anywhere on the page counts, and the browser never navigates away to open it.
let dragDepth = 0;
// Safari only allows a drop when both dragenter and dragover are cancelled.
window.addEventListener("dragenter", (event) => {
  event.preventDefault();
  if (!hasFiles(event) || unlockView.hidden) return;
  dragDepth++;
  dropzone.classList.add("dropzone--active");
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropzone.classList.remove("dropzone--active");
});
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  dropzone.classList.remove("dropzone--active");
  if (unlockView.hidden || unlocking) return;
  const file = event.dataTransfer?.files[0];
  if (file) void loadFile(file);
});

function hasFiles(event: DragEvent) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/* Unlock */

passwordInput.addEventListener("input", () => {
  passwordInput.classList.remove("field__input--error");
  syncUnlockButton();
});

function syncUnlockButton() {
  unlockButton.disabled = unlocking || !backup || passwordInput.value.length === 0;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!backup || unlocking) return;

  clearError(errorText);
  const rpcUrls = readRpcUrls();
  if (!rpcUrls) return;

  setUnlocking(true);
  try {
    const opened = await decryptFiberSeed(backup, passwordInput.value);
    seed = opened.seed;
    publicHints = opened.publicHoldings;
    publicHintsTruncated = opened.publicHoldingsTruncated;
    passwordInput.value = "";
    unlockView.hidden = true;
    walletView.hidden = false;
    tabs.hidden = false;
    lockButton.hidden = false;
    showView("holdings-view");
    $("wallet-heading").focus();
    void scanHoldings(rpcUrls);
  } catch (caught) {
    showError(caught, errorText);
    passwordInput.classList.add("field__input--error");
    passwordInput.select();
  } finally {
    setUnlocking(false);
  }
});

function setUnlocking(next: boolean) {
  unlocking = next;
  setLoading(unlockButton, next);
  passwordInput.disabled = next;
  fileInput.disabled = next;
  syncUnlockButton();
}

/* Private holdings */

for (const chain of ALL_CHAINS) {
  const field = element("div", "field");
  const label = element("label", "field__label field__label--network");
  label.append(networkIcon(chain.slug), `${chain.name} RPC`);
  label.htmlFor = `rpc-${chain.id}`;
  const input = element("textarea", "field__input field__input--mono field__input--list");
  input.id = `rpc-${chain.id}`;
  input.rows = chain.defaultRpcs.length;
  input.spellcheck = false;
  input.autocomplete = "off";
  input.value = chain.defaultRpcs.join("\n");
  input.addEventListener("input", () => input.classList.remove("field__input--error"));
  field.append(label, input);
  rpcFields.append(field);
}

const rpcInput = (chain: Chain) => $<HTMLTextAreaElement>(`rpc-${chain.id}`);

/** Validates every RPC field, opening the settings to show the first bad one. */
function readRpcUrls(): Map<Chain, URL[]> | null {
  const rpcUrls = new Map<Chain, URL[]>();
  for (const chain of ALL_CHAINS) {
    try {
      rpcUrls.set(chain, parseRpcUrls(rpcInput(chain).value, chain.name));
    } catch (caught) {
      rpcSettings.open = true;
      rpcInput(chain).classList.add("field__input--error");
      showError(caught, errorText);
      return null;
    }
  }
  return rpcUrls;
}

/** Scans every chain as soon as the backup unlocks; holdings appear as each chain finishes. */
async function scanHoldings(rpcUrls: Map<Chain, URL[]>) {
  if (!seed || scanning) return;
  const current = session;
  resetHoldings();
  // Only networks with a private pool are scanned by the engine and get a chip.
  const pools = [...rpcUrls].filter((entry): entry is [RecoveryChain, URL[]] => "pool" in entry[0]);
  for (const [chain, urls] of pools) statuses.set(chain.id, chainStatus(chain, urls, current));
  const status = (chain: RecoveryChain) => statuses.get(chain.id)!;

  // Proving files for uncommon sends come from one IPFS gateway; nothing else is reachable.
  const origins = new Set([...[...rpcUrls.values()].flat().map((url) => url.origin), ARTIFACT_GATEWAY]);
  if (!lockConnections(origins)) {
    const error = new RecoveryError("Reload the page to use different RPCs.");
    for (const chainStatus of statuses.values()) chainStatus.fail(error);
    return;
  }

  // Prices come from the same servers, so they start only once the page is locked to them.
  prices = watchPrices(new Map([...rpcUrls].map(([chain, urls]) => [chain.id, urls])), () => {
    if (current === session) layout();
  });
  startTicker();
  // The total waits for the public addresses too, which are checked once the pools have been.
  sweeping = true;
  publicStatus.hidden = false;
  deepScan.hidden = true;
  publicText.textContent = "Public addresses are checked next…";

  scanning = true;
  try {
    // The scanner carries the Railgun engine; load it only once a backup is unlocked.
    const { startRecovery } = await import("./railgun");
    if (!seed || current !== session) return;
    const started = await startRecovery({
      seed,
      targets: pools.map(([chain, urls]) => ({ chain, rpcUrls: urls })),
      onProgress: (chain, progress) => status(chain).progress(progress),
      onDone: (chain, holdings) => status(chain).done(holdings),
      onError: (chain, error) => status(chain).fail(error),
    });
    // Locked while the engine was starting: shut it down instead of keeping it.
    if (current !== session) return void started.close();
    recovery = started;
    await started.ready;
  } catch (caught) {
    // A failure before any chain started (the engine itself) applies to every chain.
    for (const chainStatus of statuses.values()) chainStatus.fail(caught);
  } finally {
    if (current === session) {
      scanning = false;
      // After the pools, so the two don't compete for the same servers' rate limits.
      void scanPublic(rpcUrls, current);
    }
  }
}

/**
 * Adds a second Content-Security-Policy that only allows the given origins.
 * Browsers enforce every policy on the page, so this can only narrow what the first one allows.
 */
function lockConnections(origins: Set<string>): boolean {
  if (lockedOrigins) return [...origins].every((origin) => lockedOrigins!.has(origin));
  const policy = document.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = `connect-src ${[...origins].join(" ")}`;
  document.head.append(policy);
  lockedOrigins = origins;
  // The page can't reach other servers from now on, so freeze the fields to match.
  for (const chain of ALL_CHAINS) rpcInput(chain).readOnly = true;
  $("rpc-settings-locked").hidden = false;
  return true;
}

/** Adds one network's chip under the balance and returns the handlers that update it. */
function chainStatus(chain: RecoveryChain, rpcUrls: URL[], scanSession: number): ChainStatus {
  const chip = element("div", "network");
  const text = element("span", "network__status", "Starting…");
  const retry = element("button", "network__retry", "Retry");
  retry.type = "button";
  retry.hidden = true;
  chip.append(networkIcon(chain.slug), element("span", "network__name", chain.name), text, retry);
  networks.append(chip);
  const problem = element("p", "network-errors__item");
  problem.setAttribute("role", "alert");

  // Results from a scan started before the last lock are dropped.
  const current = () => scanSession === session;
  const set = (state: ChainStatus["state"], label: string) => {
    status.state = state;
    chip.dataset.state = state;
    text.textContent = label;
    retry.hidden = state !== "failed";
    if (state !== "failed") problem.remove();
  };

  const status: ChainStatus = {
    state: "scanning",
    progress(progress) {
      if (!current()) return;
      set("scanning", progress.phase === "history" ? `${Math.floor(progress.fraction * 100)}%` : "Finding your funds…");
    },
    done(holdings) {
      if (!current()) return;
      set("done", "");
      chip.title = rpcUrls.length === 1 ? `Read through ${rpcUrls[0]!.host}` : `Read through ${rpcUrls.length} RPCs`;
      setHoldings(chain, rpcUrls, holdings);
    },
    fail(error) {
      if (!current()) return;
      set("failed", "Couldn't scan");
      problem.textContent =
        error instanceof RecoveryError ? error.message : `Couldn't scan ${chain.name}. Check the RPC and try again.`;
      networkErrors.append(problem);
      if (!(error instanceof RecoveryError)) console.error(error);
      layout();
    },
  };
  chip.dataset.state = status.state;

  retry.addEventListener("click", async () => {
    if (!recovery || !current()) return;
    set("scanning", "Scanning…");
    layout();
    try {
      // Reports through `done` or `fail` like the first scan.
      await recovery.rescan(chain);
    } catch (caught) {
      status.fail(caught);
    }
  });

  return status;
}

/* Public holdings: tokens at the wallet's own addresses, outside the private pool. */

const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
let owners: Owner[] = [];
// One per chain, kept across retries so a failed history scan carries on instead of starting over.
const historyScans = new Map<number, TransferScan>();

/**
 * Checks the wallet's public addresses on every chain: every labelled token and the gas token at
 * each address, plus anything the backup lists. History for other tokens is a separate, slow scan.
 */
async function scanPublic(rpcUrls: Map<Chain, URL[]>, current: number) {
  if (!seed) return;
  sweeping = true;
  publicStatus.hidden = false;
  deepScan.hidden = true;
  const evmHints = publicHints.filter((hint) => hint.network === "evm");
  const count = Math.max(PUBLIC_ADDRESS_COUNT, ...evmHints.map((hint) => hint.derivationIndex + 1));
  publicText.textContent = `Checking ${count} public addresses…`;
  try {
    const addresses = await evmAddresses(seed, count);
    if (current !== session) return;
    owners = addresses.map((address, index) => ({ address, index }));

    const failed: string[] = [];
    await Promise.all(
      [...rpcUrls].map(async ([chain, urls]) => {
        try {
          // The backup may list tokens Fiber has no label for; they are read alongside the sweep.
          const listed = evmHints.flatMap((hint) => {
            const owner = owners[hint.derivationIndex];
            // A listed address that this seed doesn't produce is not this wallet's to recover.
            if (!owner || owner.address.toLowerCase() !== hint.address.toLowerCase()) return [];
            return hint.tokens
              .filter((token) => token.chainId === chain.id)
              .map((token) => ({ owner, tokenAddress: token.tokenAddress }));
          });
          // A slow or rate-limited server gets two more tries before the network is given up on.
          for (let attempt = 1; ; attempt++) {
            try {
              const [swept, hinted] = await Promise.all([
                sweepBalances(chain, urls, owners),
                readBalances(chain, urls, listed),
              ]);
              if (current === session) addPublic(chain, urls, [...swept, ...hinted]);
              break;
            } catch (caught) {
              if (attempt >= 3 || current !== session) throw caught;
            }
          }
        } catch (caught) {
          failed.push(chain.name);
          console.error(caught);
        }
      }),
    );
    if (current !== session) return;
    const note = publicHintsTruncated ? " Your backup's own list of public addresses was cut short." : "";
    publicText.textContent = failed.length
      ? `Couldn't check public addresses on ${failed.join(", ")}.${note}`
      : `Checked ${count} public addresses on ${rpcUrls.size} networks for known tokens.${note}`;
    deepScan.textContent = "Look for other tokens";
    deepScan.hidden = false;
    deepScan.onclick = () => void scanHistory(rpcUrls, current);
  } finally {
    if (current === session) {
      sweeping = false;
      renderElsewhere(rpcUrls);
      layout();
    }
  }
}

/** The slow pass: reads transfer history for tokens the sweep can't know to look for. */
async function scanHistory(rpcUrls: Map<Chain, URL[]>, current: number) {
  deepScan.hidden = true;
  const progress = new Map<string, string>([...rpcUrls.keys()].map((chain) => [chain.name, "0%"]));
  const show = () => {
    if (current !== session) return;
    publicText.textContent = `Reading transfer history, which takes a while · ${[...progress]
      .map(([name, state]) => `${name} ${state}`)
      .join(" · ")}`;
  };
  show();
  const failed: string[] = [];
  let found = 0;
  await Promise.all(
    [...rpcUrls].map(async ([chain, urls]) => {
      try {
        let scan = historyScans.get(chain.id);
        if (!scan) historyScans.set(chain.id, (scan = transferScan(chain, urls, owners)));
        const assets = await scan.run((fraction) => {
          progress.set(chain.name, `${Math.floor(fraction * 100)}%`);
          show();
        });
        progress.set(chain.name, "done");
        if (current === session) found += addPublic(chain, urls, assets);
      } catch (caught) {
        progress.set(chain.name, "failed");
        failed.push(chain.name);
        console.error(caught);
      }
      show();
    }),
  );
  if (current !== session) return;
  const result = found ? `found ${found} more ${found === 1 ? "holding" : "holdings"}` : "found nothing more";
  publicText.textContent = failed.length
    ? `Transfer history ${result}, but couldn't be read on ${failed.join(", ")}.`
    : `Transfer history read on every network: ${result}.`;
  if (failed.length) {
    deepScan.textContent = "Carry on";
    deepScan.hidden = false;
  }
}

const publicKey = (chain: Chain, owner: string, tokenAddress: string) =>
  `${chain.id}:public:${owner.toLowerCase()}:${tokenAddress.toLowerCase()}`;

/** Reads the given public balances again after a send, dropping rows that are now empty. */
async function rereadPublic(chain: Chain, rpcUrls: URL[], pairs: Array<{ owner: Owner; tokenAddress: string }>) {
  const current = session;
  const assets = await readBalances(chain, rpcUrls, pairs);
  if (current !== session) return;
  const held = new Set(assets.map((asset) => publicKey(chain, asset.owner, asset.tokenAddress)));
  for (const pair of pairs) {
    const key = publicKey(chain, pair.owner.address, pair.tokenAddress);
    if (held.has(key)) continue;
    rows.get(key)?.el.remove();
    rows.delete(key);
  }
  addPublic(chain, rpcUrls, assets);
}

/** Adds or updates public rows, and returns how many were new. */
function addPublic(chain: Chain, rpcUrls: URL[], assets: PublicAsset[]): number {
  let added = 0;
  for (const asset of assets) {
    const key = publicKey(chain, asset.owner, asset.tokenAddress);
    const holding: PrivateHolding = { type: "ERC20", address: asset.tokenAddress, tokenId: null, amount: asset.amount };
    const existing = rows.get(key);
    if (existing) {
      existing.holding = holding;
      continue;
    }
    const row = createRow(key, chain, rpcUrls, holding, asset);
    enter(row.el, "row--enter", Math.min(added++, 8) * 40);
    rows.set(key, row);
  }
  layout();
  return added;
}

/**
 * Lists what the backup says is held on networks this page has no server for. The page can't read
 * those balances, but it can still give the key for each address.
 */
function renderElsewhere(rpcUrls: Map<Chain, URL[]>) {
  const here = new Set([...rpcUrls.keys()].map((chain) => chain.id));
  const items: HTMLElement[] = [];
  for (const hint of publicHints) {
    const names =
      hint.network === "evm"
        ? [...new Set(hint.tokens.filter((token) => !here.has(token.chainId)).map((token) => token.chainId))].map(
            (chainId) => `Chain ${chainId}`,
          )
        : [hint.network[0]!.toUpperCase() + hint.network.slice(1)];
    for (const name of names) {
      const count =
        hint.network === "evm" ? hint.tokens.filter((token) => !here.has(token.chainId)).length : hint.tokens.length;
      const item = element("li", "row");
      const main = element("div", "row__main");
      const icon = element("span", "row__icon row__icon--other");
      icon.append(element("span", "row__glyph", name.slice(0, 4)));
      const identity = element("span", "row__identity");
      identity.append(
        element("span", "row__name", name),
        element("span", "row__detail", `${shortAddress(hint.address)} · ${count} ${count === 1 ? "token" : "tokens"} in your backup's list`),
      );
      identity.title = hint.address;
      main.append(icon, identity);
      if (hint.network === "evm" || hint.network === "solana") {
        const keyButton = element("button", "pill pill--quiet", "Show key");
        keyButton.type = "button";
        const kind = hint.network;
        keyButton.addEventListener("click", () => showKeyAt(kind, hint.derivationIndex, hint.address));
        main.append(keyButton);
      }
      item.append(main);
      items.push(item);
    }
  }
  if (!items.length) return void elsewhere.replaceChildren();
  const section = element("section", "section");
  const header = element("header", "section__header");
  header.append(
    element("h2", "section__title", "On other networks"),
    element("span", "section__meta", "Not read by this page"),
  );
  const list = element("ul", "rows");
  list.append(...items);
  section.append(header, list);
  elsewhere.replaceChildren(section);
}

/* Holdings: one row per token per network, filed by category under a live total. */

const holdingKey = (chain: RecoveryChain, holding: PrivateHolding) =>
  `${chain.id}:${holding.type}:${holding.address}:${holding.tokenId ?? ""}`;

/** Replaces one chain's rows with the result of its latest scan, keeping rows that are still held. */
function setHoldings(chain: RecoveryChain, rpcUrls: URL[], holdings: PrivateHolding[]) {
  const held = new Set(holdings.map((holding) => holdingKey(chain, holding)));
  for (const [key, row] of rows) {
    if (row.owner || row.chain.id !== chain.id || held.has(key)) continue;
    row.el.remove();
    rows.delete(key);
  }
  let added = 0;
  for (const holding of holdings) {
    const key = holdingKey(chain, holding);
    const existing = rows.get(key);
    if (existing) {
      existing.holding = holding;
      continue;
    }
    const row = createRow(key, chain, rpcUrls, holding);
    // New rows rise in one after another; the class goes once it has played, so moving a row
    // later doesn't replay it.
    enter(row.el, "row--enter", Math.min(added++, 8) * 40);
    rows.set(key, row);
  }
  layout();
}

function createRow(
  key: string,
  chain: Chain,
  rpcUrls: URL[],
  holding: PrivateHolding,
  publicAsset?: PublicAsset,
): Row {
  const token = publicAsset
    ? publicAsset.token
    : holding.type === "ERC20"
      ? chain.tokens.find((candidate) => candidate.address.toLowerCase() === holding.address)
      : undefined;
  // A token that names itself gets no price: anyone can deploy a contract called "USDC".
  const market = publicAsset && !publicAsset.labelled ? marketFor(undefined) : marketFor(token);
  const owner = publicAsset ? { address: publicAsset.owner, index: publicAsset.index } : undefined;
  // An earning vault's shares are unwrapped to the dollar token it holds on the way out.
  const unwraps = market.vault?.earns ? market.vault.underlyingSymbol : undefined;

  const el = element("li", "row");
  const main = element("div", "row__main");
  const icon = element("span", `row__icon row__icon--${market.category}`);
  // Unlabelled tokens show the contract, so nothing is hidden.
  const short = `${holding.address.slice(0, 6)}…${holding.address.slice(-4)}`;
  const glyph = token ? (token.symbol.split(" ")[0] ?? token.symbol).slice(0, 4) : "?";
  icon.append(element("span", "row__glyph", glyph), networkIcon(chain.slug));

  const identity = element("span", "row__identity");
  const kind = holding.tokenId === null ? holding.type : `${holding.type} #${holding.tokenId}`;
  identity.append(
    element("span", "row__name", token ? token.name : short),
    element(
      "span",
      "row__detail",
      `${token ? token.symbol : kind} · ${chain.name}${unwraps ? ` · holds ${unwraps}` : ""}${owner ? ` · public ${shortAddress(owner.address)}` : ""}`,
    ),
  );
  if (!token) identity.title = holding.address;

  const earn = element("span", "row__earn");
  earn.hidden = true;
  const value = element("span", "row__value");
  const amount = element("span", "row__amount");
  const sub = element("span", "row__sub");
  value.append(amount, sub);
  main.append(icon, identity, earn, value);

  const row: Row = { key, chain, rpcUrls, token, market, holding, owner, el, earn, amount, sub };
  if (token) prices?.track(key, chain.id, token, market);
  if (owner) {
    // The address's own key moves a public balance from any wallet, with or without this page.
    const keyButton = element("button", "pill pill--quiet", "Show key");
    keyButton.type = "button";
    keyButton.addEventListener("click", () => showKeyAt("evm", owner.index, owner.address));
    main.append(keyButton);
  }
  if (token) {
    const sendButton = element("button", "pill pill--quiet", unwraps && !owner ? "Unwrap and send" : "Send");
    sendButton.type = "button";
    sendButton.setAttribute("aria-expanded", "false");
    sendButton.addEventListener("click", () => {
      const open = el.querySelector<HTMLElement>(".send");
      if (open?.dataset.closing) return;
      if (open) {
        open.dataset.closing = "true";
        collapse(open, () => open.remove());
      } else {
        const close = () => sendButton.setAttribute("aria-expanded", "false");
        const form = owner ? publicSendForm(row, token, owner, close) : sendForm(row, token, close);
        el.append(form);
        expand(form);
      }
      sendButton.setAttribute("aria-expanded", String(!open));
    });
    main.append(sendButton);
  }
  el.append(main);
  return row;
}

const quantity = (row: Row) => (row.token ? Number(row.holding.amount) / 10 ** row.token.decimals : 0);

/** A row's dollar value right now, or null while it has no price. */
function valueOf(row: Row, nowMs: number): number | null {
  const usd = row.token ? (prices?.usd(row.key, nowMs) ?? null) : null;
  return usd === null ? null : quantity(row) * usd;
}

type Section = { el: HTMLElement; meta: HTMLElement; list: HTMLUListElement };
const sectionsByCategory = new Map<Category, Section>();

function sectionFor(category: Category): Section {
  let section = sectionsByCategory.get(category);
  if (!section) {
    const el = element("section", "section");
    const header = element("header", "section__header");
    const meta = element("span", "section__meta");
    header.append(element("h2", "section__title", CATEGORIES.find(({ id }) => id === category)!.title), meta);
    const list = element("ul", "rows");
    el.append(header, list);
    enter(el, "section--enter");
    section = { el, meta, list };
    sectionsByCategory.set(category, section);
  }
  return section;
}

/**
 * Files rows under their categories, largest first, and updates everything that changes only when
 * holdings or prices do. Rows are moved, never rebuilt, so an open send form stays as it is.
 */
function layout() {
  const now = Date.now();
  const order: HTMLElement[] = [];
  for (const { id } of CATEGORIES) {
    const members = [...rows.values()]
      .filter((row) => row.market.category === id)
      .sort((a, b) => (valueOf(b, now) ?? -1) - (valueOf(a, now) ?? -1) || a.key.localeCompare(b.key));
    if (!members.length) {
      sectionsByCategory.get(id)?.el.remove();
      continue;
    }
    const section = sectionFor(id);
    place(section.list, members.map((row) => row.el));
    order.push(section.el);
  }

  const settled = [...statuses.values()].every((status) => status.state !== "scanning");
  if (!order.length && settled && statuses.size) {
    const anyDone = [...statuses.values()].some((status) => status.state === "done");
    const empty = element(
      "p",
      "empty",
      anyDone ? "No private holdings in this backup." : "Nothing could be scanned. Retry a network above, or reload to use other RPCs.",
    );
    sections.replaceChildren(empty);
  } else {
    sections.querySelector(".empty")?.remove();
    place(sections, order);
  }

  for (const row of rows.values()) {
    const earns = Boolean(row.market.vault?.earns);
    const apy = prices?.apy(row.key) ?? null;
    row.earn.hidden = !earns;
    row.earn.textContent = apy === null ? "Earning" : `Earning ${(apy * 100).toFixed(1)}%`;
  }
  refresh();
}

/** Puts `children` in `parent` in this order, touching the DOM only when the order changed. */
function place(parent: HTMLElement, children: HTMLElement[]) {
  const same = parent.children.length === children.length && children.every((child, index) => parent.children[index] === child);
  if (!same) parent.replaceChildren(...children);
}

/** Rewrites every amount that moves with time: earning rows, section totals and the balance. */
function refresh() {
  const now = Date.now();
  let total = 0;
  let yearly = 0;
  let unpriced = 0;
  let pending = false;
  const byCategory = new Map<Category, { count: number; total: number; priced: number }>();

  for (const row of rows.values()) {
    const value = valueOf(row, now);
    const group = byCategory.get(row.market.category) ?? { count: 0, total: 0, priced: 0 };
    group.count++;
    byCategory.set(row.market.category, group);

    if (value !== null && row.token) {
      const earns = Boolean(row.market.vault?.earns);
      // Earning balances show six decimals, so the growth is visible as it happens.
      setMoney(row.amount, value, earns ? 6 : 2);
      const { whole, fraction } = formatUnits(row.holding.amount, row.token.decimals);
      setText(row.sub, `${whole}${fraction} ${row.token.symbol}`);
      total += value;
      yearly += value * (prices?.apy(row.key) ?? 0);
      group.total += value;
      group.priced++;
    } else if (row.token) {
      const { whole, fraction } = formatUnits(row.holding.amount, row.token.decimals);
      setParts(row.amount, whole, fraction);
      const waiting = !prices?.settled(row.key);
      setText(row.sub, waiting ? "Pricing…" : `${row.token.symbol} · no price`);
      if (waiting) pending = true;
      else unpriced++;
    } else {
      // No label means no decimals either: show the raw on-chain amount.
      setParts(row.amount, row.holding.amount.toString(), "");
      setText(row.sub, "Unknown token");
      unpriced++;
    }
  }

  for (const [category, group] of byCategory) {
    const count = `${group.count} ${group.count === 1 ? "asset" : "assets"}`;
    setText(sectionsByCategory.get(category)!.meta, group.priced ? `${count} · ${plainMoney(group.total)}` : count);
  }

  // The balance waits for the first network and for prices, so it never flashes a partial number.
  const anyDone = [...statuses.values()].some((status) => status.state === "done");
  const allFailed = statuses.size > 0 && [...statuses.values()].every((status) => status.state === "failed");
  const loading = !allFailed && (!anyDone || pending || sweeping);
  heroBalance.classList.toggle("hero__balance--loading", loading);
  heroBalance.setAttribute("aria-busy", String(loading));
  if (loading) {
    if (!heroBalance.querySelector(".skeleton")) {
      delete heroBalance.dataset.kind;
      heroBalance.replaceChildren(element("span", "skeleton hero__skeleton"));
    }
  } else {
    if (heroBalance.querySelector(".skeleton")) {
      delete heroBalance.dataset.kind;
      heroBalance.replaceChildren();
      enter(heroBalance, "hero__balance--enter");
    }
    // Twelve digits in all, as in Fiber: the fraction shortens as the dollars grow.
    setMoney(heroBalance, total, Math.max(2, 12 - String(Math.floor(total)).length));
  }

  const notes: string[] = [];
  if (yearly >= 0.01) notes.push(`Earning about ${plainMoney(yearly)} a year`);
  if (unpriced) notes.push(`${unpriced} ${unpriced === 1 ? "holding has" : "holdings have"} no on-chain price and ${unpriced === 1 ? "isn't" : "aren't"} counted`);
  heroNote.hidden = loading || !notes.length;
  // A small pulsing dot marks a balance that is growing as you watch.
  heroNote.classList.toggle("hero__note--live", yearly >= 0.01);
  setText(heroNote, notes.join(" · "));
}

const plainMoney = (value: number) =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Whole dollars in ink and the fraction muted, per the Decimal Fade rule in DESIGN.md. Each digit
 * rolls to its new value, as Fiber's balances do; screen readers get the plain amount instead.
 */
function setMoney(target: HTMLElement, value: number, digits: number) {
  const [whole = "0", fraction = ""] = value.toFixed(digits).split(".");
  if (target.dataset.kind !== "money") {
    const spoken = element("span", "sr-only");
    const parts = [element("span", "money__whole roll"), element("span", "money__fraction roll")];
    for (const part of parts) part.setAttribute("aria-hidden", "true");
    target.replaceChildren(...parts, spoken);
    target.dataset.kind = "money";
  }
  const dollars = `$${Number(whole).toLocaleString("en-US")}`;
  roll(target.children[0] as HTMLElement, dollars);
  roll(target.children[1] as HTMLElement, fraction ? `.${fraction}` : "");
  // Two decimals are enough to hear, and keep a ticking balance from being re-announced.
  setText(target.children[2] as HTMLElement, plainMoney(value));
}

/** Shows `text` with each digit as a 0–9 strip that slides to its value; other characters stay put. */
function roll(target: HTMLElement, text: string) {
  if (target.dataset.text === text) return;
  const chars = [...text];
  const isDigit = (char: string) => char >= "0" && char <= "9";
  // The strips are rebuilt only when the layout of digits and separators changes.
  const shape = chars.map((char) => (isDigit(char) ? "0" : char)).join("");
  if (target.dataset.shape !== shape) {
    target.replaceChildren(
      ...chars.map((char) => {
        if (!isDigit(char)) return element("span", "roll__char", char);
        const digit = element("span", "roll__digit");
        const strip = element("span", "roll__strip");
        for (let value = 0; value < 10; value++) strip.append(element("span", "", String(value)));
        digit.append(strip);
        return digit;
      }),
    );
    target.dataset.shape = shape;
  }
  chars.forEach((char, index) => {
    if (!isDigit(char)) return;
    const strip = target.children[index]!.firstElementChild as HTMLElement;
    strip.style.transform = `translateY(-${Number(char) * 10}%)`;
  });
  target.dataset.text = text;
}

function setParts(target: HTMLElement, whole: string, fraction: string) {
  if (target.dataset.kind !== "parts") {
    target.replaceChildren(element("span", "money__whole"), element("span", "money__fraction"));
    target.dataset.kind = "parts";
  }
  setText(target.children[0] as HTMLElement, whole);
  setText(target.children[1] as HTMLElement, fraction);
}

function setText(target: HTMLElement, text: string) {
  if (target.textContent !== text) target.textContent = text;
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Earning balances tick at Fiber's pace: a new value every 600ms, which the digits take 600ms to
 * roll to, so they never stop moving. With reduced motion, every five seconds without the roll.
 */
function startTicker() {
  clearInterval(ticker);
  ticker = setInterval(() => {
    if (document.visibilityState === "visible" && !walletView.hidden) refresh();
  }, reducedMotion() ? 5_000 : 600);
}

/** Plays a one-off entrance, then drops the class so the element can be moved without replaying it. */
function enter(target: HTMLElement, className: string, delayMs = 0) {
  target.classList.add(className);
  target.style.animationDelay = `${delayMs}ms`;
  target.addEventListener("animationend", function done(event) {
    if (event.target !== target) return;
    target.classList.remove(className);
    target.style.animationDelay = "";
    target.removeEventListener("animationend", done);
  });
}

const FOLDED = { height: "0px", opacity: 0, paddingTop: "0px", paddingBottom: "0px", marginBottom: "0px" };

/** Opens a panel from nothing to its own height. */
function expand(target: HTMLElement) {
  if (reducedMotion()) return;
  target.style.overflow = "hidden";
  const motion = target.animate([FOLDED, { height: `${target.offsetHeight}px`, opacity: 1 }], {
    duration: 240,
    easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  });
  motion.onfinish = () => (target.style.overflow = "");
}

/** Folds a panel away, then calls `done` to remove it. */
function collapse(target: HTMLElement, done: () => void) {
  if (reducedMotion()) return done();
  target.style.overflow = "hidden";
  target.animate([{ height: `${target.offsetHeight}px`, opacity: 1 }, FOLDED], { duration: 180, easing: "ease-out" }).onfinish = done;
}

function resetHoldings() {
  clearInterval(ticker);
  prices?.stop();
  prices = null;
  rows.clear();
  statuses.clear();
  sectionsByCategory.clear();
  networks.replaceChildren();
  networkErrors.replaceChildren();
  notices.replaceChildren();
  sections.replaceChildren();
  elsewhere.replaceChildren();
  owners = [];
  historyScans.clear();
  sweeping = false;
  publicStatus.hidden = true;
  heroNote.hidden = true;
  heroBalance.classList.add("hero__balance--loading");
  delete heroBalance.dataset.kind;
  heroBalance.replaceChildren(element("span", "skeleton hero__skeleton"));
}

/** A confirmed send, kept above the holdings so the rescan that follows doesn't wipe it. */
function announce(text: string, link: string) {
  const notice = element("p", "notice", text);
  const anchor = element("a", "send__link", "View on explorer");
  anchor.href = link;
  anchor.target = "_blank";
  anchor.rel = "noreferrer";
  notice.append(" ", anchor);
  notices.append(notice);
}

/**
 * Unshields a token out of Fiber's pool to any address on the same chain. The proof is made
 * here; the user's browser wallet submits it and pays gas.
 */
function sendForm(row: Row, token: Token, onClose: () => void) {
  // Only private rows have a send form, and those are always on a network with a pool.
  const chain = row.chain as RecoveryChain;
  const { rpcUrls } = row;
  // For an earning vault, the shares leave the pool to the browser wallet, which then redeems
  // them so the recipient gets the dollar token itself.
  const unwraps = row.market.vault?.earns ? row.market.vault.underlyingSymbol : undefined;
  // Set once the shares are in the wallet, so a retry only redeems and never unshields twice.
  let unwrapping: { from: string; shares: bigint; wallet: string } | null = null;
  const form = element("form", "send");
  form.noValidate = true;
  const id = `${chain.id}-${token.address}`;

  const recipient = element("input", "field__input field__input--mono");
  recipient.id = `send-to-${id}`;
  recipient.placeholder = `0x… address on ${chain.name}`;
  recipient.spellcheck = false;
  recipient.autocomplete = "off";

  const amount = element("input", "field__input field__input--mono");
  amount.id = `send-amount-${id}`;
  amount.inputMode = "decimal";
  amount.autocomplete = "off";
  const max = () => {
    const { whole, fraction } = formatUnits(row.holding.amount, token.decimals, token.decimals);
    return `${whole.replace(/,/g, "")}${fraction}`;
  };
  amount.value = max();
  const maxButton = element("button", "text-button", "Max");
  maxButton.type = "button";
  maxButton.addEventListener("click", () => (amount.value = max()));

  const wallets = listBrowserWallets();
  const walletPicker = element("select", "field__input");
  walletPicker.id = `send-wallet-${id}`;
  for (const wallet of wallets) {
    const option = element("option", "", wallet.name);
    option.value = wallet.id;
    walletPicker.append(option);
  }

  const note = element(
    "p",
    "send__note",
    unwraps
      ? `This moves ${token.symbol} out of Fiber's private pool into your browser wallet, unwraps it to ${unwraps}, and sends the ${unwraps} to the address above on ${chain.name}. Your wallet confirms two transactions and pays the ${chain.nativeSymbol} gas. The proof is made here first, which can take a minute.`
      : `This moves ${token.symbol} out of Fiber's private pool to a public address on ${chain.name}. Your browser wallet pays the ${chain.nativeSymbol} gas. The proof is made here first, which can take a minute.`,
  );
  const error = element("p", "field__error field__error--start");
  error.hidden = true;
  error.setAttribute("role", "alert");
  const status = element("p", "send__status");
  status.hidden = true;
  status.setAttribute("role", "status");
  const submit = element("button", "button button--primary");
  submit.type = "submit";
  const submitLabel = element("span", "button__label", unwraps ? `Send as ${unwraps}` : `Send ${token.symbol}`);
  submit.append(submitLabel, element("span", "spinner"));

  const fields = element("div", "send__fields");
  fields.append(
    labelled("Send to", recipient),
    labelled(`Amount (${token.symbol})`, amount, maxButton),
    wallets.length
      ? labelled("Pay gas with", walletPicker)
      : element("p", "field__error field__error--start", "No browser wallet found. Install MetaMask or Rabby to pay gas, then reload."),
    submit,
  );
  form.append(fields, note, error, status);
  submit.disabled = !wallets.length;

  const showStatus = (text: string, link?: string) => {
    status.hidden = false;
    status.textContent = text;
    if (link) {
      const anchor = element("a", "send__link", "View on explorer");
      anchor.href = link;
      anchor.target = "_blank";
      anchor.rel = "noreferrer";
      status.append(" ", anchor);
    }
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!recovery) return showError(new RecoveryError("Still scanning. Try again in a moment."), error);
    clearError(error);
    status.hidden = true;

    let value: bigint;
    try {
      value = unwrapping ? unwrapping.shares : parseUnits(amount.value, token.decimals);
      if (value <= 0n) throw new RecoveryError("Enter an amount above zero.");
      if (!unwrapping && value > row.holding.amount) {
        throw new RecoveryError(`You have ${formatUnitsPlain(row.holding.amount, token.decimals)} ${token.symbol}.`);
      }
      if (!/^0x[0-9a-fA-F]{40}$/.test(recipient.value.trim())) throw new RecoveryError("Enter a 0x… address to send to.");
    } catch (caught) {
      return showError(caught, error);
    }

    const wallet = wallets.find((candidate) => candidate.id === walletPicker.value) ?? wallets[0]!;
    const current = session;
    const proving = (progress: SendProgress) => {
      if (progress.phase === "building") return showStatus("Preparing the transaction…");
      const bundled = (BUNDLED_VARIANTS as readonly string[]).includes(progress.circuit);
      showStatus(
        progress.fraction === 0 && !bundled
          ? "Downloading proving files…"
          : `Making the proof · ${Math.round(progress.fraction * 100)}%`,
      );
    };
    const locked = [recipient, amount, walletPicker, maxButton];
    setLoading(submit, true);
    for (const control of locked) control.disabled = true;
    try {
      showStatus(`Connect ${wallet.name}…`);
      const from = await connect(wallet);
      const to = recipient.value.trim();

      if (unwraps) {
        if (unwrapping && unwrapping.from.toLowerCase() !== from.toLowerCase()) {
          throw new RecoveryError(
            `Your ${token.symbol} is in ${unwrapping.from.slice(0, 6)}…${unwrapping.from.slice(-4)}. Switch ${wallet.name} to that account to unwrap it.`,
          );
        }
        if (!unwrapping) {
          const unshield = await recovery.prepareUnshield({
            chain,
            tokenAddress: token.address,
            amount: value,
            recipient: from,
            onProgress: proving,
          });
          if (current !== session) return;
          showStatus(`Step 1 of 2: confirm the transaction in ${wallet.name}.`);
          const unshieldHash = await sendTransaction(wallet, chain, rpcUrls, from, unshield);
          showStatus(`Step 1 of 2: moving ${token.symbol} to your wallet…`, `${chain.explorer}/tx/${unshieldHash}`);
          await waitForReceipt(rpcUrls, unshieldHash);
          if (current !== session) return;
          // From here the shares are public, in the wallet: a failure below must say so.
          unwrapping = { from, shares: value, wallet: wallet.name };
          submitLabel.textContent = `Unwrap to ${unwraps}`;
          void recovery.rescan(chain);
        }

        const redeem = {
          to: token.address,
          data: VAULT.encodeFunctionData("redeem", [unwrapping.shares, getAddress(to), from]),
        };
        showStatus(`Step 2 of 2: confirm the unwrap in ${wallet.name}.`);
        let redeemHash: string;
        try {
          redeemHash = await sendTransaction(wallet, chain, rpcUrls, from, redeem);
        } catch (caught) {
          // A server a block behind doesn't see the shares yet; ask once more before giving up.
          if (!(caught instanceof RecoveryError) || !caught.message.includes("would fail")) throw caught;
          await new Promise((resolve) => setTimeout(resolve, 4_000));
          redeemHash = await sendTransaction(wallet, chain, rpcUrls, from, redeem);
        }
        const redeemLink = `${chain.explorer}/tx/${redeemHash}`;
        showStatus(`Step 2 of 2: unwrapping and sending ${unwraps}…`, redeemLink);
        await waitForReceipt(rpcUrls, redeemHash);
        if (current !== session) return;

        announce(
          `Unwrapped ${formatUnitsPlain(value, token.decimals)} ${token.symbol} and sent the ${unwraps} to ${to.slice(0, 6)}…${to.slice(-4)}.`,
          redeemLink,
        );
        form.remove();
        onClose();
        return;
      }

      const transaction = await recovery.prepareUnshield({
        chain,
        tokenAddress: token.address,
        amount: value,
        recipient: to,
        onProgress: proving,
      });
      if (current !== session) return;

      showStatus(`Confirm the transaction in ${wallet.name}.`);
      const hash = await sendTransaction(wallet, chain, rpcUrls, from, transaction);
      const link = `${chain.explorer}/tx/${hash}`;
      showStatus("Sent. Waiting for it to confirm…", link);
      await waitForReceipt(rpcUrls, hash);
      if (current !== session) return;

      announce(`Sent ${formatUnitsPlain(value, token.decimals)} ${token.symbol} to ${to.slice(0, 6)}…${to.slice(-4)}.`, link);
      form.remove();
      onClose();
      // Refresh the balances; the row updates when the rescan finishes.
      void recovery.rescan(chain);
    } catch (caught) {
      if (current !== session) return;
      status.hidden = true;
      showError(caught, error);
      if (unwrapping) {
        const where = `${unwrapping.from.slice(0, 6)}…${unwrapping.from.slice(-4)}`;
        error.textContent += ` Your ${token.symbol} is safe in ${unwrapping.wallet} (${where}), outside the private pool. Press “Unwrap to ${unwraps}” to try the unwrap again.`;
      }
    } finally {
      setLoading(submit, false);
      // Once the shares have left the pool, the amount is fixed; only the destination can change.
      for (const control of locked) control.disabled = Boolean(unwrapping) && control !== recipient;
    }
  });

  return form;
}

/**
 * Sends a token held at one of the wallet's own addresses. The page signs with that address's key
 * and submits through the user's RPCs. With no wallet prompt to act as a check, the first press
 * shows what will happen and the second sends it.
 */
function publicSendForm(row: Row, token: Token, owner: Owner, onClose: () => void) {
  const { chain, rpcUrls } = row;
  const tokenAddress = row.holding.address.toLowerCase();
  const gas = gasSymbol(chain);
  const form = element("form", "send");
  form.noValidate = true;
  const id = `${chain.id}-${owner.index}-${tokenAddress}`;

  const recipient = element("input", "field__input field__input--mono");
  recipient.id = `send-to-${id}`;
  recipient.placeholder = `0x… address on ${chain.name}`;
  recipient.spellcheck = false;
  recipient.autocomplete = "off";

  const amount = element("input", "field__input field__input--mono");
  amount.id = `send-amount-${id}`;
  amount.inputMode = "decimal";
  amount.autocomplete = "off";
  const max = () => {
    const { whole, fraction } = formatUnits(row.holding.amount, token.decimals, token.decimals);
    return `${whole.replace(/,/g, "")}${fraction}`;
  };
  amount.value = max();
  const maxButton = element("button", "text-button", "Max");
  maxButton.type = "button";

  const note = element(
    "p",
    "send__note",
    `This sends ${token.symbol} from your address ${shortAddress(owner.address)} on ${chain.name}. The page signs it with that address's key from your backup, and the address pays the network fee in ${gas}. If it has none, the page tops it up first.`,
  );
  const error = element("p", "field__error field__error--start");
  error.hidden = true;
  error.setAttribute("role", "alert");
  const status = element("p", "send__status");
  status.hidden = true;
  status.setAttribute("role", "status");
  const submit = element("button", "button button--primary");
  submit.type = "submit";
  const submitLabel = element("span", "button__label", `Send ${token.symbol}`);
  submit.append(submitLabel, element("span", "spinner"));

  const fields = element("div", "send__fields send__fields--public");
  fields.append(labelled("Send to", recipient), labelled(`Amount (${token.symbol})`, amount, maxButton), submit);
  form.append(fields, note, error, status);

  const showStatus = (text: string, link?: string) => {
    status.hidden = false;
    status.textContent = text;
    if (link) {
      const anchor = element("a", "send__link", "View on explorer");
      anchor.href = link;
      anchor.target = "_blank";
      anchor.rel = "noreferrer";
      status.append(" ", anchor);
    }
  };

  // What the first press showed. Any edit afterwards means it has to be shown again.
  let reviewed: { to: string; amount: bigint } | null = null;
  const edited = () => {
    if (!reviewed) return;
    reviewed = null;
    submitLabel.textContent = `Send ${token.symbol}`;
    status.hidden = true;
  };
  recipient.addEventListener("input", edited);
  amount.addEventListener("input", edited);
  maxButton.addEventListener("click", () => {
    amount.value = max();
    edited();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!seed) return;
    clearError(error);

    let input: PublicSendInput;
    try {
      const value = parseUnits(amount.value, token.decimals);
      if (value <= 0n) throw new RecoveryError("Enter an amount above zero.");
      if (value > row.holding.amount) {
        throw new RecoveryError(`You have ${formatUnitsPlain(row.holding.amount, token.decimals)} ${token.symbol}.`);
      }
      let to: string;
      try {
        to = getAddress(recipient.value.trim());
      } catch {
        throw new RecoveryError("Enter a valid 0x… address to send to. Check it for typos.");
      }
      const key = keyAt(seed, "evm", owner.index);
      if (key.address.toLowerCase() !== owner.address.toLowerCase()) {
        throw new RecoveryError("This backup doesn't hold the key for that address.");
      }
      input = { chain, rpcUrls, privateKey: key.privateKey, tokenAddress, decimals: token.decimals, amount: value, recipient: to };
    } catch (caught) {
      return showError(caught, error);
    }

    const current = session;
    const to = input.recipient;
    const where = `${to.slice(0, 6)}…${to.slice(-4)}`;
    const locked = [recipient, amount, maxButton];
    setLoading(submit, true);
    for (const control of locked) control.disabled = true;
    try {
      if (!reviewed || reviewed.to !== to || reviewed.amount !== input.amount) {
        showStatus("Working out the network fee…");
        const prepared = await preparePublicSend(input);
        if (current !== session) return;
        const topUp = prepared.shortfall > 0n ? gasSource(row, owner, prepared.shortfall + prepared.fee / 2n) : null;
        const fee = `${formatGas(prepared.fee)} ${gas}`;
        showStatus(
          `Send ${formatUnitsPlain(prepared.amount, token.decimals)} ${token.symbol} to ${where}? The network fee is at most ${fee}${
            topUp ? `; this address has too little, so ${topUp.plan} first` : ""
          }. A send can't be undone.`,
        );
        reviewed = { to, amount: input.amount };
        submitLabel.textContent = "Confirm send";
        return;
      }

      showStatus("Preparing the transaction…");
      let prepared = await preparePublicSend(input);
      if (current !== session) return;
      const donors: Owner[] = [];
      if (prepared.shortfall > 0n) {
        const topUp = gasSource(row, owner, prepared.shortfall + prepared.fee / 2n);
        showStatus(`Sending ${gas} for the network fee to ${shortAddress(owner.address)}…`);
        const donor = await topUp.send();
        if (donor) donors.push(donor);
        if (current !== session) return;
        prepared = await preparePublicSend(input);
        if (prepared.shortfall > 0n) {
          // A server a block behind doesn't see the top-up yet; ask once more before giving up.
          await new Promise((resolve) => setTimeout(resolve, 4_000));
          prepared = await preparePublicSend(input);
        }
        if (current !== session) return;
        if (prepared.shortfall > 0n) {
          throw new RecoveryError(`The network fee rose while this was being prepared. Press “Confirm send” to try again.`);
        }
      }

      const hash = await broadcast(rpcUrls, prepared.raw);
      const link = `${chain.explorer}/tx/${hash}`;
      showStatus("Sent. Waiting for it to confirm…", link);
      await waitForReceipt(rpcUrls, hash);
      if (current !== session) return;

      announce(`Sent ${formatUnitsPlain(prepared.amount, token.decimals)} ${token.symbol} to ${where}.`, link);
      form.remove();
      onClose();
      void rereadPublic(chain, rpcUrls, [
        { owner, tokenAddress },
        ...[owner, ...donors].map((address) => ({ owner: address, tokenAddress: NATIVE_TOKEN })),
      ]).catch((caught) => console.warn("Couldn't refresh balances after a send", caught));
    } catch (caught) {
      if (current !== session) return;
      status.hidden = true;
      showError(caught, error);
    } finally {
      setLoading(submit, false);
      for (const control of locked) control.disabled = false;
    }
  });

  return form;
}

/**
 * Where gas for a public address with none comes from: another of the backup's own addresses on
 * the same network if one holds enough, or else the browser wallet. `send` resolves once the
 * top-up has confirmed, with the address it came from when that is one of the backup's.
 */
function gasSource(row: Row, owner: Owner, needed: bigint): { plan: string; send: () => Promise<Owner | null> } {
  const { chain, rpcUrls } = row;
  const gas = gasSymbol(chain);
  const amount = `${formatGas(needed)} ${gas}`;
  const donor = [...rows.values()].find(
    (candidate) =>
      candidate.owner &&
      candidate.chain.id === chain.id &&
      candidate.holding.address === NATIVE_TOKEN &&
      candidate.owner.address.toLowerCase() !== owner.address.toLowerCase() &&
      // Twice over, so the donor can pay the fee of its own transfer too.
      candidate.holding.amount >= needed * 2n,
  )?.owner;
  if (donor) {
    return {
      plan: `the page moves ${amount} to it from your address ${shortAddress(donor.address)}`,
      send: async () => {
        if (!seed) throw new RecoveryError("The page was locked.");
        const prepared = await preparePublicSend({
          chain,
          rpcUrls,
          privateKey: keyAt(seed, "evm", donor.index).privateKey,
          tokenAddress: NATIVE_TOKEN,
          decimals: 18,
          amount: needed,
          recipient: getAddress(owner.address),
        });
        if (prepared.from.toLowerCase() !== donor.address.toLowerCase() || prepared.amount < needed) {
          throw new RecoveryError(`Couldn't move ${gas} for the network fee from ${shortAddress(donor.address)}.`);
        }
        await waitForReceipt(rpcUrls, await broadcast(rpcUrls, prepared.raw));
        return donor;
      },
    };
  }
  const wallet = listBrowserWallets()[0];
  if (wallet) {
    return {
      plan: `${wallet.name} will ask you to send it ${amount}`,
      send: async () => {
        const from = await connect(wallet);
        const hash = await sendTransaction(wallet, chain, rpcUrls, from, {
          to: getAddress(owner.address),
          value: `0x${needed.toString(16)}`,
        });
        await waitForReceipt(rpcUrls, hash);
        return null;
      },
    };
  }
  throw new RecoveryError(
    `This address has no ${gas} to pay the network fee. Send about ${amount} to ${getAddress(owner.address)} on ${chain.name}, then try again.`,
  );
}

function labelled(text: string, control: HTMLElement, action?: HTMLElement) {
  const field = element("div", "field");
  const label = element("label", "field__label", text);
  label.htmlFor = control.id;
  if (!action) {
    field.append(label, control);
    return field;
  }
  const row = element("div", "field__row");
  row.append(control, action);
  field.append(label, row);
  return field;
}

/** Parses a decimal amount ("12.5") into token units, rejecting more decimals than the token has. */
function parseUnits(text: string, decimals: number): bigint {
  const value = text.trim().replace(/,/g, "");
  const match = value.match(/^(\d*)(?:\.(\d*))?$/);
  if (!match || value === "" || value === ".") throw new RecoveryError("Enter an amount, like 12.5.");
  const [, whole = "", fraction = ""] = match;
  if (fraction.length > decimals) throw new RecoveryError(`This token has at most ${decimals} decimals.`);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

const formatUnitsPlain = (amount: bigint, decimals: number) => {
  const { whole, fraction } = formatUnits(amount, decimals);
  return `${whole}${fraction}`;
};

/** A network fee in gas-token units. Fees are often far below a millionth, so it keeps two digits. */
const formatGas = (wei: bigint) =>
  (Number(wei) / 1e18).toLocaleString("en-US", { maximumSignificantDigits: 2, maximumFractionDigits: 18 });

/* Private key recovery */

keyAddress.addEventListener("input", () => {
  keyAddress.classList.remove("field__input--error");
  keyButton.disabled = keyAddress.value.trim().length === 0;
});

keyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!seed) return;
  clearError(keyError);
  hideKey();

  const address = keyAddress.value.trim();
  if (!addressKind(address)) {
    keyAddress.classList.add("field__input--error");
    showError(new RecoveryError("That doesn't look like an EVM (0x…) or Solana address."), keyError);
    return;
  }

  const current = session;
  setLoading(keyButton, true);
  try {
    const found = await findPrivateKey(seed, address);
    if (current !== session) return;
    if (!found) {
      keyAddress.classList.add("field__input--error");
      showError(
        new RecoveryError(`This address isn't in the first ${MAX_DERIVATION_INDEX.toLocaleString()} accounts of this backup.`),
        keyError,
      );
      return;
    }
    showKey(found);
  } finally {
    setLoading(keyButton, false);
  }
});

function showKey(found: RecoveredKey) {
  $("key-network").textContent = `${found.network} · account ${found.index + 1}`;
  $("key-path").textContent = found.path;
  keyValue.textContent = found.privateKey;
  keyResult.hidden = false;
}

/** Opens the Private keys section on the key for a holding whose derivation index is known. */
function showKeyAt(kind: "evm" | "solana", index: number, address: string) {
  if (!seed) return;
  showView("keys-view");
  clearError(keyError);
  hideKey();
  keyAddress.value = address;
  keyButton.disabled = false;
  const found = keyAt(seed, kind, index);
  // The index comes from the scan or the backup's list; the key shown must be this address's.
  if (found.address.toLowerCase() !== address.toLowerCase() && found.address !== address) {
    return showError(new RecoveryError("This backup doesn't hold the key for that address."), keyError);
  }
  showKey(found);
  $("keys-title").focus();
}

// The key stays blurred until asked for, so it doesn't land in a screenshot or screen share by accident.
keyReveal.addEventListener("click", () => {
  const revealed = keyValue.dataset.revealed !== "true";
  keyValue.dataset.revealed = String(revealed);
  keyReveal.textContent = revealed ? "Hide" : "Reveal";
});

function hideKey() {
  keyResult.hidden = true;
  keyValue.textContent = "";
  keyValue.dataset.revealed = "false";
  keyReveal.textContent = "Reveal";
}

/* Sections of the unlocked wallet */

function showView(id: string) {
  for (const tab of tabs.querySelectorAll<HTMLButtonElement>(".tab")) {
    const active = tab.dataset.view === id;
    tab.classList.toggle("tab--active", active);
    if (active) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
    $(tab.dataset.view!).hidden = !active;
  }
}

for (const tab of tabs.querySelectorAll<HTMLButtonElement>(".tab")) {
  tab.addEventListener("click", () => showView(tab.dataset.view!));
}

/* Shared */

for (const button of document.querySelectorAll<HTMLButtonElement>(".copy-button")) {
  button.innerHTML = COPY_ICON;
  button.addEventListener("click", async () => {
    const value = $(button.dataset.copy!).textContent ?? "";
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return;
    }
    button.innerHTML = CHECK_ICON;
    button.classList.add("copy-button--done");
    setTimeout(() => {
      button.innerHTML = COPY_ICON;
      button.classList.remove("copy-button--done");
    }, 1400);
  });
}

lockButton.addEventListener("click", () => {
  session++;
  void recovery?.close();
  recovery = null;
  wipe();
  backup = null;
  publicHints = [];
  publicHintsTruncated = false;
  scanning = false;
  hideKey();
  keyAddress.value = "";
  keyButton.disabled = true;
  clearError(keyError);
  resetHoldings();
  resetDropzone();
  tabs.hidden = true;
  lockButton.hidden = true;
  walletView.hidden = true;
  unlockView.hidden = false;
  syncUnlockButton();
  fileInput.focus();
});

function wipe() {
  seed?.fill(0);
  seed = null;
}

window.addEventListener("pagehide", wipe);

function setLoading(button: HTMLButtonElement, loading: boolean) {
  button.classList.toggle("button--loading", loading);
  button.setAttribute("aria-busy", String(loading));
  button.disabled = loading;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showError(caught: unknown, target: HTMLElement) {
  target.textContent =
    caught instanceof RecoveryError ? caught.message : "Something went wrong reading this backup. Try the file again.";
  target.hidden = false;
  if (!(caught instanceof RecoveryError)) console.error(caught);
}

function clearError(target: HTMLElement) {
  target.hidden = true;
  target.textContent = "";
}
