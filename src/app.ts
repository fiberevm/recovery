import { ARTIFACT_GATEWAY, BUNDLED_VARIANTS } from "./artifact-variants";
import { connect, listBrowserWallets, sendTransaction, waitForReceipt } from "./browser-wallet";
import { networkIcon } from "./network-icons";
import { RECOVERY_CHAINS, type RecoveryChain, type Token } from "./chains";
import { addressKind, findPrivateKey, MAX_DERIVATION_INDEX } from "./derive";
import {
  decryptFiberSeed,
  MAX_FIBERSEED_BYTES,
  parseFiberSeedFile,
  RecoveryError,
  type FiberSeedFile,
} from "./fiberseed";
import { formatUnits, parseRpcUrls } from "./rpc";
import type { PrivateHolding, RecoverySession, ScanProgress } from "./railgun";

type ChainRow = {
  progress: (progress: ScanProgress) => void;
  done: (holdings: PrivateHolding[]) => void;
  fail: (error: unknown) => void;
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
const holdingsResults = $("holdings-results");
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
    seed = await decryptFiberSeed(backup, passwordInput.value);
    passwordInput.value = "";
    unlockView.hidden = true;
    walletView.hidden = false;
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

for (const chain of RECOVERY_CHAINS) {
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

const rpcInput = (chain: RecoveryChain) => $<HTMLTextAreaElement>(`rpc-${chain.id}`);

/** Validates every RPC field, opening the settings to show the first bad one. */
function readRpcUrls(): Map<RecoveryChain, URL[]> | null {
  const rpcUrls = new Map<RecoveryChain, URL[]>();
  for (const chain of RECOVERY_CHAINS) {
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

/** Scans every chain as soon as the backup unlocks; each chain's row fills in as it finishes. */
async function scanHoldings(rpcUrls: Map<RecoveryChain, URL[]>) {
  if (!seed || scanning) return;
  const current = session;
  holdingsResults.replaceChildren();
  const rows = new Map([...rpcUrls].map(([chain, urls]) => [chain.id, chainRow(chain, urls, current)]));
  const row = (chain: RecoveryChain) => rows.get(chain.id)!;

  // Proving files for uncommon sends come from one IPFS gateway; nothing else is reachable.
  const origins = new Set([...[...rpcUrls.values()].flat().map((url) => url.origin), ARTIFACT_GATEWAY]);
  if (!lockConnections(origins)) {
    const error = new RecoveryError("Reload the page to use different RPCs.");
    for (const chainRow of rows.values()) chainRow.fail(error);
    return;
  }

  scanning = true;
  try {
    // The scanner carries the Railgun engine; load it only once a backup is unlocked.
    const { startRecovery } = await import("./railgun");
    if (!seed || current !== session) return;
    const started = await startRecovery({
      seed,
      targets: [...rpcUrls].map(([chain, urls]) => ({ chain, rpcUrls: urls })),
      onProgress: (chain, progress) => row(chain).progress(progress),
      onDone: (chain, holdings) => row(chain).done(holdings),
      onError: (chain, error) => row(chain).fail(error),
    });
    // Locked while the engine was starting: shut it down instead of keeping it.
    if (current !== session) return void started.close();
    recovery = started;
    await started.ready;
  } catch (caught) {
    // A failure before any chain started (the engine itself) applies to every row.
    for (const chainRow of rows.values()) chainRow.fail(caught);
  } finally {
    if (current === session) scanning = false;
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
  for (const chain of RECOVERY_CHAINS) rpcInput(chain).readOnly = true;
  $("rpc-settings-locked").hidden = false;
  return true;
}

/** Adds one chain's row to the results and returns the handlers that update it. */
function chainRow(chain: RecoveryChain, rpcUrls: URL[], scanSession: number): ChainRow {
  const group = element("section", "holdings__group");
  const head = element("div", "holdings__head");
  const status = element("span", "holdings__status", "Starting…");
  const name = element("span", "holdings__name");
  name.append(networkIcon(chain.slug), chain.name);
  head.append(name, status);
  const bar = element("div", "progress");
  const fill = element("div", "progress__fill");
  bar.append(fill);
  // Confirmed sends, kept above the list so a rescan doesn't wipe them.
  const notices = element("div", "holdings__notices");
  group.append(head, bar, notices);
  holdingsResults.append(group);

  // Results from a scan started before the last lock are dropped.
  const current = () => scanSession === session;
  let content: HTMLElement | null = null;
  const announce = (text: string, link: string) => {
    const notice = element("p", "holdings__notice", text);
    const anchor = element("a", "send__link", "View on explorer");
    anchor.href = link;
    anchor.target = "_blank";
    anchor.rel = "noreferrer";
    notice.append(" ", anchor);
    notices.append(notice);
  };

  return {
    progress(progress) {
      // Only the first scan shows progress; rescans after a send update the list in place.
      if (!current() || !bar.isConnected) return;
      if (progress.phase === "history") {
        fill.style.width = `${Math.round(progress.fraction * 90)}%`;
        status.textContent = `Reading recent pool history · ${Math.floor(progress.fraction * 100)}%`;
      } else {
        fill.style.width = "95%";
        status.textContent = "Finding your funds…";
      }
    },
    done(holdings) {
      if (!current()) return;
      bar.remove();
      status.textContent = rpcUrls.length === 1 ? `via ${rpcUrls[0]!.host}` : `via ${rpcUrls.length} RPCs`;
      status.classList.remove("holdings__status--error");
      const next = holdings.length
        ? holdingsList(chain, rpcUrls, holdings, announce)
        : element("p", "holdings__empty", "No private holdings");
      if (content) content.replaceWith(next);
      else group.append(next);
      content = next;
    },
    fail(error) {
      if (!current()) return;
      bar.remove();
      status.textContent =
        error instanceof RecoveryError ? error.message : `Couldn't scan ${chain.name}. Check the RPC and try again.`;
      status.classList.add("holdings__status--error");
      if (!(error instanceof RecoveryError)) console.error(error);
    },
  };
}

type Announce = (text: string, link: string) => void;

function holdingsList(chain: RecoveryChain, rpcUrls: URL[], holdings: PrivateHolding[], announce: Announce) {
  const list = element("ul", "asset-list");
  for (const holding of holdings) {
    const token = chain.tokens.find((candidate) => candidate.address.toLowerCase() === holding.address);
    const label = element("span", "asset__label");
    const amount = element("span", "asset__amount");
    const row = element("li", "asset");
    const line = element("div", "asset__line");

    if (token && holding.type === "ERC20") {
      label.append(element("span", "asset__symbol", token.symbol), element("span", "asset__name", token.name));
      // Muted fractional digits, per the Decimal Fade rule in DESIGN.md.
      const { whole, fraction } = formatUnits(holding.amount, token.decimals);
      amount.append(whole, element("span", "asset__fraction", fraction));

      const sendButton = element("button", "text-button", "Send");
      sendButton.type = "button";
      sendButton.addEventListener("click", () => {
        const open = row.querySelector(".send");
        if (open) return void open.remove();
        row.append(sendForm(chain, rpcUrls, token, holding, announce));
      });
      line.append(label, amount, sendButton);
    } else {
      // Unlabelled tokens show the contract and the raw on-chain amount, so nothing is hidden.
      const short = `${holding.address.slice(0, 6)}…${holding.address.slice(-4)}`;
      const name = holding.tokenId === null ? holding.type : `${holding.type} #${holding.tokenId}`;
      label.append(element("span", "asset__symbol", short), element("span", "asset__name", name));
      label.title = holding.address;
      amount.append(holding.amount.toString());
      line.append(label, amount);
    }

    row.append(line);
    list.append(row);
  }
  return list;
}

/**
 * Unshields a token out of Fiber's pool to any address on the same chain. The proof is made
 * here; the user's browser wallet submits it and pays gas.
 */
function sendForm(chain: RecoveryChain, rpcUrls: URL[], token: Token, holding: PrivateHolding, announce: Announce) {
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
    const { whole, fraction } = formatUnits(holding.amount, token.decimals, token.decimals);
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
    `This moves ${token.symbol} out of Fiber's private pool to a public address. Your browser wallet pays the ${chain.nativeSymbol} gas on ${chain.name}; the proof is made here first, which can take a minute.`,
  );
  const error = element("p", "field__error");
  error.hidden = true;
  error.setAttribute("role", "alert");
  const status = element("p", "send__status");
  status.hidden = true;
  status.setAttribute("role", "status");
  const submit = element("button", "button button--primary");
  submit.type = "submit";
  submit.append(element("span", "button__label", `Send ${token.symbol}`), element("span", "spinner"));

  form.append(
    labelled("Send to", recipient),
    labelled(`Amount (${token.symbol})`, amount, maxButton),
    wallets.length
      ? labelled("Pay gas with", walletPicker)
      : element("p", "field__error", "No browser wallet found. Install MetaMask or Rabby to pay gas, then reload."),
    note,
    error,
    status,
    submit,
  );
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
      value = parseUnits(amount.value, token.decimals);
      if (value <= 0n) throw new RecoveryError("Enter an amount above zero.");
      if (value > holding.amount) throw new RecoveryError(`You have ${formatUnitsPlain(holding.amount, token.decimals)} ${token.symbol}.`);
      if (!/^0x[0-9a-fA-F]{40}$/.test(recipient.value.trim())) throw new RecoveryError("Enter a 0x… address to send to.");
    } catch (caught) {
      return showError(caught, error);
    }

    const wallet = wallets.find((candidate) => candidate.id === walletPicker.value) ?? wallets[0]!;
    const current = session;
    const locked = [recipient, amount, walletPicker, maxButton];
    setLoading(submit, true);
    for (const control of locked) control.disabled = true;
    try {
      showStatus(`Connect ${wallet.name}…`);
      const from = await connect(wallet);

      const transaction = await recovery.prepareUnshield({
        chain,
        tokenAddress: token.address,
        amount: value,
        recipient: recipient.value.trim(),
        onProgress: (progress) => {
          if (progress.phase === "building") return showStatus("Preparing the transaction…");
          const bundled = (BUNDLED_VARIANTS as readonly string[]).includes(progress.circuit);
          showStatus(
            progress.fraction === 0 && !bundled
              ? "Downloading proving files…"
              : `Making the proof · ${Math.round(progress.fraction * 100)}%`,
          );
        },
      });
      if (current !== session) return;

      showStatus(`Confirm the transaction in ${wallet.name}.`);
      const hash = await sendTransaction(wallet, chain, rpcUrls, from, transaction);
      const link = `${chain.explorer}/tx/${hash}`;
      showStatus("Sent. Waiting for it to confirm…", link);
      await waitForReceipt(rpcUrls, hash);
      if (current !== session) return;

      const to = recipient.value.trim();
      announce(`Sent ${formatUnitsPlain(value, token.decimals)} ${token.symbol} to ${to.slice(0, 6)}…${to.slice(-4)}.`, link);
      form.remove();
      // Refresh the balances; the list re-renders when the rescan finishes.
      void recovery.rescan(chain);
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
    $("key-network").textContent = `${found.network} · account ${found.index + 1}`;
    $("key-path").textContent = found.path;
    keyValue.textContent = found.privateKey;
    keyResult.hidden = false;
  } finally {
    setLoading(keyButton, false);
  }
});

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
  scanning = false;
  hideKey();
  keyAddress.value = "";
  keyButton.disabled = true;
  clearError(keyError);
  holdingsResults.replaceChildren();
  resetDropzone();
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
