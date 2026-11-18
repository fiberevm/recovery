# Fiber Recovery

Get your money out of Fiber using only your backup file, even if Fiber's app and servers are gone.

Fiber Recovery is a single web page. You give it your `.fiberseed` backup and its password, and it can:

- **Show your private balance.** It scans Fiber's private pools on Ethereum, Arbitrum, Base and BNB Chain as soon as you unlock. Your total is at the top, in dollars, and grows live as earning balances accrue. Below it, every token on every network has its own row, under Stablecoins, Stocks, Metals, Crypto or Other.
- **Send them out.** Move a private balance to any address on the same chain. Your own browser wallet (MetaMask, Rabby, …) pays the gas. Earning balances are unwrapped on the way, so the address receives plain USDC or USDT.
- **Find what's outside the pools.** It checks your wallet's own addresses on every network Fiber takes deposits on, and lists any tokens sitting there.
- **Recover private keys.** Paste one of your wallet addresses and it shows that address's private key, so you can import it into another wallet such as MetaMask or Phantom.

Hosted at **https://recovery.fiber.so**. Source: **https://github.com/fiberevm/recovery**.

## Is it safe?

- **Your backup and password never leave your browser.** Everything is decrypted and computed on your device.
- **Key recovery works offline.** It never touches the network.
- **The page only talks to the servers you choose.** The servers (RPCs) are listed under **RPC settings** before you unlock. By default that's several public servers per chain, used together for speed; replace the list to use only your own. When the scan starts, the page locks itself so it can only connect to those servers, plus one IPFS gateway (`ipfs-lb.com`) for proving files a send may need. The servers see your IP address and that someone read a pool's public history, never your keys or which funds are yours.
- **Sending never exposes your backup.** The page makes the zero-knowledge proof itself and hands your browser wallet a finished transaction to submit. The wallet pays gas, and never sees the backup or its keys.
- **The page can't be lied to quietly.** After rebuilding a pool's history, the page checks the result against the pool's live contract. If a server leaves out part of the history, the page asks the other servers for it again, and if none of them has it the scan fails with an error instead of showing an empty wallet.
- **Check the address bar.** The real page is only ever served from `https://recovery.fiber.so`. You can also download it and open it from your own computer (see below).

Anyone who sees a private key can take everything at that address. Never share it, paste it into a website you don't trust, or send it to support.

## Using it

1. Open https://recovery.fiber.so, or your own copy of `index.html`.
2. Drop your `.fiberseed` file on the page, or click to choose it. A green checkmark means the file was read.
3. Optional: open **RPC settings** to replace the default servers with your own (one URL per line).
4. Enter the password you set when you exported the backup, then press **Unlock**. Scanning starts right away.
5. Choose what you need:
   - **Holdings:** your total, then a row per token per network. A chip for each network shows its scan; if one fails, press **Retry** on it. To move a balance out, press **Send** on its row, enter the address to send to and the amount (**Max** sends everything), pick the browser wallet that will pay gas, and press **Send**. Approve the transaction in your wallet. When it confirms, the page shows a link to the block explorer and refreshes the balance.
     For an earning balance the button is **Unwrap and send**: the balance moves to your browser wallet, is unwrapped to the stablecoin it holds (shown on the row), and that stablecoin goes to the address you entered. Your wallet confirms two transactions. If the second one fails, the balance is safe in your wallet and the button tries the unwrap again.
     Rows marked **public** are tokens at one of your wallet's own addresses, outside the private pool. **Send** moves them to any address: the page signs with that address's own key, and if the address has nothing to pay the network fee with, the page tops it up first, from another of your addresses on that network or from your browser wallet. **Show key** gives the address's private key, to import into another wallet instead. **Look for other tokens** reads transfer history for tokens Fiber has no name for; it can take a long time on free servers, and **Carry on** resumes it if it stops.
   - **Private keys:** paste an address (`0x…` for EVM networks, or a Solana address) and press **Find private key**. The key is blurred until you press **Reveal**.
6. Press **Lock** when you're done. Closing the tab also clears everything.

Sending moves funds out of Fiber's private pool to a public address, on the same chain. You need a little ETH (Ethereum, Arbitrum, Base) or BNB (BNB Chain) in your browser wallet for gas. Gas on Ethereum costs much more than on the other chains.

You get the `.fiberseed` file from the Fiber app, under Settings → Export wallet.

## Running your own copy

You need [Bun](https://bun.sh) 1.3 or newer.

```bash
git clone https://github.com/fiberevm/recovery.git
cd recovery
bun install
bun run build
open dist/index.html
```

`bun run build` produces one self-contained file, `dist/index.html` (about 37 MB: the private-pool engine, saved pool history, and the common proving circuits). It has no other files, so you can copy it to a USB stick or an offline computer. Key recovery works fully offline. Scanning and sending need the network.

### Commands

| Command | What it does |
| --- | --- |
| `bun run dev` | Serves the page at http://localhost:3000 and rebuilds it every time you refresh. |
| `bun run build` | Writes the single-file page to `dist/index.html`. |
| `bun run snapshot` | Updates the saved pool history (see [Pool snapshots](#pool-snapshots)). |
| `bun run artifacts` | Re-downloads the bundled proving circuits and checks their hashes. |
| `bun run fixture` | Writes a test backup you can try the page with. |
| `bun run typecheck` | Checks the TypeScript. |
| `bun test` | Scans a local fork of Base through a faulty RPC. Needs Foundry's `anvil`. |

### Trying it without a real backup

`bun run fixture` writes `fixtures/test-wallet.fiberseed`, with the password `correct horse battery`. Its first addresses are:

- EVM `0xACA6302EcBde40120cb8A08361D8BD461282Bd18`
- Solana `8x5oj8rEbxiUwjFydDBV48uMS9J7EzxVt3WDA3LdByGm`

These match the [Fiber CLI](https://github.com/fiberevm/cli) for the same file. The test wallet is empty, so a holdings scan finds nothing.

To try scanning and sending with test funds, use a local fork of Arbitrum ([Foundry](https://getfoundry.sh)'s `anvil`):

```bash
anvil --fork-url https://arb1.arbitrum.io/rpc
bun scripts/fork-shield.ts 100 25.5   # gives the test wallet two private fUSDT0 notes
```

Then set the Arbitrum RPC to `http://127.0.0.1:8545` under **RPC settings** and unlock the test backup. To send, your browser wallet must also be connected to the fork.

## Deploying

`render.yaml` is a [Render](https://render.com) Blueprint for https://recovery.fiber.so. It builds the page with Bun and serves `dist/index.html` as a static site, with headers that stop other sites from framing it. In Render, create a Blueprint from this repo's `main` branch, then point `recovery.fiber.so` at the service in DNS as Render instructs. Every push to `main` redeploys.

Every push to `main` also publishes the page as a [GitHub Release](https://github.com/fiberevm/recovery/releases) (`.github/workflows/release.yml`). The workflow builds twice to check the build is reproducible, then attaches `fiber-recovery-v<version>.html`, its `.sha256`, and a build-provenance attestation. The version is `package.json`'s major and minor plus `main`'s commit count, so `0.1.7` is the seventh commit. A push that leaves the page byte-identical makes no release. To check a download came from this workflow:

```bash
gh attestation verify fiber-recovery-v0.1.7.html --repo fiberevm/recovery
```

docs.fiber.so links to the [latest release](https://github.com/fiberevm/recovery/releases/latest), so the release notes are the one place each file's hash is published.

Refresh the pool snapshots (`bun run snapshot`) and commit them before pushing to `main`, so scans start from recent history.

## How it works

### 1. Opening the backup

A `.fiberseed` file is your wallet's seed, locked with your password. The page turns the password into a key (PBKDF2-SHA256, 600,000 rounds) and unlocks the seed with it (AES-256-GCM), using the browser's built-in cryptography. A wrong password or a damaged file can't be unlocked. Code: `src/fiberseed.ts`.

### 2. Recovering a private key

Every address in a Fiber wallet comes from the seed through a numbered path:

- EVM networks: `m/44'/60'/0'/0/<n>`
- Solana: `m/44'/501'/<n>'/0'`

These are the same paths Fiber's servers and the Fiber CLI use. The page tries `n` from 0 to 999 until one produces the address you pasted, then shows that key. EVM keys are shown as `0x…` hex, and Solana keys in the format Phantom imports. Code: `src/derive.ts`.

### 3. Finding private holdings

Fiber's private balances live in Fiber's own Railgun pools (a fork of [Railgun](https://railgun.org)). Deposits in a pool are encrypted notes. Only keys derived from your seed can tell which ones are yours.

To find them, the page:

1. Rebuilds your pool wallet from the seed, the same way the Fiber CLI does.
2. Collects each pool's full public history: the saved snapshot, plus anything newer from the RPC.
3. Gives that history to the Railgun engine, which rebuilds the pool's record of deposits (its merkle tree) and decrypts the notes that belong to you.
4. Checks the rebuilt tree against the live pool contract. If it doesn't match, the scan fails.
5. Adds up your unspent notes and lists them by token.

Code: `src/railgun.ts` (engine), `src/pool-logs.ts` (fetching history), `src/snapshots.ts` (saved history).

### 4. Unwrapping earning balances

USDC Prime, Galaxy USDT, FUSDT0 and FUSDT are shares in ERC-4626 vaults. A share is only useful to someone who knows to redeem it, so **Unwrap and send** does both steps: it unshields the shares to the browser wallet that pays gas, then has that wallet call the vault's `redeem` with the recipient as receiver. Any holder may redeem from these vaults; that was checked by simulating a redeem from each pool's own shares. The page remembers that the shares have left the pool, so a retry only redeems.

### 5. Public holdings

A Fiber wallet also has ordinary addresses, numbered 0, 1, 2… in the order Fiber created them. Newer backups list the addresses that held tokens when the backup was made, but the page doesn't depend on that list. It derives the first 200 addresses (more if the backup lists a higher one) and checks them itself, on the four pool networks and on Polygon, Unichain, Monad, HyperEVM, Robinhood Chain, Arc and Plasma:

1. **Sweep.** Reads the balance of the gas token and of every token Fiber has a name for, at every address, a few hundred balances per call through Multicall3. This takes seconds and doesn't depend on history.
2. **Transfer history** (the **Look for other tokens** button). Reads ERC-20 `Transfer` logs sent to those addresses since 1 August 2026, the month Fiber launched, then checks what is still held. This finds tokens with no name in Fiber's registry. Free servers allow only a few thousand blocks per request and rate-limit long scans, so this can take from minutes to hours depending on the network. The scan keeps its place, so **Carry on** resumes it.

A token found only by its history is shown with the symbol its own contract reports and no dollar value, because anyone can deploy a contract that calls itself USDC. Holdings the backup lists on Solana, Stellar and Tron are shown under **On other networks** without a balance; the page can give the Solana key.

Sending a public holding needs no proof and no browser wallet. The page derives the address's key, signs a plain transfer (a legacy transaction, which every one of these networks accepts) and submits it through your RPCs. The first press of **Send** only shows the amount, recipient and highest possible fee; the second sends. Three cases around the fee:

- Sending the gas token itself: the fee comes out of the amount, so "Max" arrives slightly short. The same goes for USDC on Arc, where USDC is the gas token.
- The address holds a token but too little gas: the page first sends it the fee, from another of the backup's addresses on that network if one holds twice the amount, else by asking the browser wallet.
- On Base and Unichain a second fee for posting data is read from the chain's gas oracle and doubled as a margin.

Code: `src/public-holdings.ts`, `src/public-send.ts`, `src/derive.ts` (`evmAddresses`, `keyAt`), `src/fiberseed.ts` (the backup's list).

### 6. Dollar values

Dollar values are estimates, read on-chain through the same RPCs, so the page needs no price server:

- **Market prices** come from [Chainlink](https://data.chain.link) price feeds: stocks, gold, the Canadian dollar, ETH, BTC, SOL and BNB. USDC and USDT count as one dollar. A tokenized stock is valued at its share price, which can differ slightly from the token's own price.
- **Earning balances** (USDC Prime, Galaxy USDT, FUSDT0, FUSDT) are vault shares, valued with the vault's own share price. The page reads that price about once a minute, measures how fast it is growing, and ticks the balance forward at that rate in between. The rate shown on the row is the measured one.
- **No feed, no price.** AMD, Broadcom, Eli Lilly, Marvell, SanDisk and the silver trust have no Chainlink feed, and unknown tokens have none either. They show their amount and are left out of the total, which says so.

Each chain's prices come from one call to Multicall3, so a reading is consistent with its block time. Code: `src/market.ts` (categories and feeds), `src/prices.ts` (reading and projecting).

### 7. Sending (unshielding)

Moving funds out of a pool is called unshielding. In Fiber's fork of the Railgun contracts, only Fiber can put funds into a pool, but anyone can take them out with a valid proof. So recovery doesn't need Fiber at all.

When you press **Send**, the page:

1. Picks which of your notes to spend and builds the transaction, the same way Fiber's own servers do (Railgun's engine).
2. Makes a zero-knowledge proof that you own those notes, in your browser. This uses Railgun's standard proving circuits. Circuits for spending one or two notes are built into the page. Others download from IPFS. Every circuit is checked against Railgun's published hashes first.
3. Checks the proof, and estimates gas through your RPC. If the transaction would fail, it stops before asking your wallet.
4. Asks your browser wallet to switch to the right chain and submit the transaction. The wallet pays gas.
5. Waits for it to confirm through your RPC, then rescans that chain.

Fiber's pools charge no unshield fee, so the recipient gets exactly the amount sent. A balance spread over many notes needs bigger circuits, which take longer to download and prove.

Code: `src/railgun.ts` (`prepareUnshield`), `src/artifacts.ts` (circuits), `src/browser-wallet.ts` (wallet connection).

### Pools and servers

| Chain | Fiber pool |
| --- | --- |
| Ethereum | `0xc835F7252338E1A7a533927C64fC148D6A940C5F` |
| Arbitrum | `0x7233d17ec3Ce855Acb8F7A9412Bf90757117A092` |
| Base | `0x22F45899EE13042ae046f7Aa7C2292Ea74C7F1c6` |
| BNB Chain | `0x7233d17ec3Ce855Acb8F7A9412Bf90757117A092` |

Arbitrum and BNB Chain share a pool address; the page always picks the pool by chain. These come from omni's `packages/shared/asset-definitions/railgun.ts` and are set in `src/chains.ts`.

The default servers are in the same file, as a list per chain taken from [Chainlist](https://chainlist.org/rpcs.json). Most listed servers don't suit this page: many refuse browser requests or old history, and some answer log queries with an empty list instead of an error. The defaults are the ones that returned the right logs from a browser origin in testing, so test a new server against a block range known to hold logs before adding it.

A scan first drops servers that don't answer or are behind the others, then hands out block ranges from a shared queue, so faster servers do more of the work. The page reads each server's limits from its error messages, slows down when it is rate-limited, and moves a range to another server when one fails or takes too long. If you have your own RPC (Alchemy, QuickNode, etc.), you can paste it in instead.

BNB Chain is the hard one. Few public BNB servers keep log history, and several answer old ranges with an empty list. The two defaults return the right logs but only for 1,000 and 100 blocks a request, so a BNB scan is quick with a fresh snapshot and slows as the snapshot ages. Refresh the snapshots often, or paste in your own BNB RPC.

Public holdings are also looked for on the other networks Fiber takes deposits on: Polygon, Unichain, Monad, HyperEVM, Robinhood Chain, Arc and Plasma. They have no pool, so nothing is scanned there except your own addresses. Each has its own list of default servers in `src/chains.ts` and its own field under **RPC settings**. Solana, Stellar and Tron balances aren't read; holdings your backup lists there show under **On other networks**, with the key for Solana addresses.

### Pool snapshots

Reading a pool's whole history from free servers is slow. To avoid that, the page ships with each pool's history saved up to a recent block, in `src/snapshots/<chain>.json`. A scan replays the snapshot and only asks the server for newer blocks.

The snapshot doesn't have to be trusted. The final checks against the live contract, on the merkle root and the number of leaves, catch any missing or changed history.

A snapshot only covers blocks that are final, so it can't be undone by a chain reorganization. Refresh the snapshots before each release:

```bash
bun run snapshot                     # add new blocks to every snapshot
bun run snapshot --only base         # one chain: ethereum, arbitrum, base or bnb
bun run snapshot --full              # start over from each pool's first block
bun run snapshot --bnb-rpc <url>     # use another server (also --ethereum-rpc, --arbitrum-rpc, --base-rpc)
```

Without a flag, each chain reads from all its default servers. A full rebuild is slower, because few free servers reach the oldest blocks. A paid RPC is much faster; the BNB Chain snapshot took 34 seconds on QuickNode. Pass keyed URLs through environment variables, which keeps them out of your shell history and the script's output:

```bash
ETHEREUM_RPC_URL=… BNB_RPC_URL=… BASE_RPC_URL=… ARBITRUM_RPC_URL=… bun run snapshot
```

The snapshot files only contain public pool history. No RPC URL is ever written to them.

The older a snapshot is, the more a scan has to fetch live from the free servers. With fresh snapshots, scanning all four chains takes a few seconds.

## Project layout

```
index.html            The page
src/
  app.ts              Page logic: file drop, unlock, holdings and private keys
  fiberseed.ts        Reading and unlocking .fiberseed files
  derive.ts           Address and private key derivation
  chains.ts           Pools, deposit networks and default servers per chain
  tokens.ts           Token names per chain, from Fiber's token registry
  market.ts           Category and price source for each token
  prices.ts           Dollar values, read on-chain through the RPCs
  public-holdings.ts  Tokens at the wallet's own addresses, on every deposit network
  public-send.ts      Signs and submits a send from one of those addresses
  network-icons.ts    Network icons
  railgun.ts          Private holdings scan and sends (Railgun engine)
  pool-logs.ts        Fetching pool history from a server
  snapshots.ts        Loading saved pool history
  snapshots/*.json    Saved pool history
  artifacts.ts        Loading and checking proving circuits
  artifacts/          Bundled circuits and Railgun's circuit hashes
  browser-wallet.ts   Connecting to the browser wallet that pays gas
  node-shims.ts       Node.js globals the engine expects
  styles.css          Styles, following Fiber's design system
  fonts/              Geist and Space Grotesk
scripts/
  build.ts            Builds dist/index.html
  serve.ts            Local server for `bun run dev`
  snapshot.ts         Updates the saved pool history
  artifacts.ts        Downloads and checks the bundled circuits
  make-fixture.ts     Writes the test backup
  fork-shield.ts      Gives the test wallet private funds on a local fork
shims/                Browser stand-ins for Node-only packages (see below)
```

## Notes for developers

The Railgun engine was written for Node.js, so the browser build needs a few stand-ins:

- `scripts/build.ts` bundles with Bun and puts the CSS and JavaScript inline in one HTML file. `bun build --compile` would do this in one step, but it skips the browser versions of Node built-ins that the engine needs.
- `src/node-shims.ts` defines `global`, `Buffer` and `process.nextTick` before the engine loads.
- `shims/assert` replaces Bun's browser version of `assert`, which older packages can't call.
- `shims/no-wasm.js` replaces two WebAssembly packages that read files from disk; the engine falls back to equivalent JavaScript.
- `shims/micro-ftch` replaces an unused Node network helper that comes in through web3.

- The page's security policy allows `'wasm-unsafe-eval'`, because the proof library compiles WebAssembly. It doesn't allow JavaScript `eval`.
- Proofs run on one thread, as on Fiber's servers. Worker threads would need a looser security policy.
- Railgun's own download server doesn't allow browser requests, so circuits that aren't built in come from the `ipfs-lb.com` IPFS gateway, which serves the same files.

`bun run dev` serves the built page rather than using Bun's own dev server, because Bun's live-reload connection is blocked by the page's security policy and breaks the page in Safari.

## Supply chain

The page handles wallet keys, so its dependencies are kept small and checked:

- **Six direct dependencies**, all pinned to exact versions: Fiber's fork of the Railgun engine, `ethers` (which the engine requires), `snarkjs`, `memdown`, `brotli` and `@noble/curves`.
- **Nothing unused is installed.** `package.json` `overrides` replace packages the page never loads (web3 and some snarkjs tooling) with an empty stub that throws if anything ever loads it. That cuts the install from about 470 packages to about 130 without changing what ships.
- **Only releases at least 3 days old.** `bunfig.toml` sets `minimumReleaseAge`, so a freshly hijacked npm release can't be installed. Every npm package in the lockfile is over 40 days old today.
- **No install scripts.** No dependency is trusted to run scripts, and the Render build installs with `--ignore-scripts`.
- **Locked and verified.** Installs use `bun.lock`, which records an integrity hash for every package. The two Railgun forks are pinned to exact commits.
- **`bun audit` is clean.** Two advisories in packages the engine pulls in (`bn.js`, `ws`) are overridden to patched versions.
- **Nothing loads from a CDN at runtime.** The page is one file. Proving circuits fetched from IPFS are checked against Railgun's published hashes before use.

Run `bun audit` before each release.

## License

MIT; see `LICENSE`. The bundled fonts (Geist, Space Grotesk) are under the SIL Open Font License; see `src/fonts/`. The bundled proving circuits are Railgun's.
