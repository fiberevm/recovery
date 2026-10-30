# Fiber Recovery

Get your money out of Fiber using only your backup file, even if Fiber's app and servers are gone.

Fiber Recovery is a single web page. You give it your `.fiberseed` backup and its password, and it can:

- **Find your private holdings.** It scans Fiber's private pools on Arbitrum, Base and BNB Chain as soon as you unlock, and lists what you own in them.
- **Send them out.** Move a private balance to any address on the same chain. Your own browser wallet (MetaMask, Rabby, …) pays the gas.
- **Recover private keys.** Paste one of your wallet addresses and it shows that address's private key, so you can import it into another wallet such as MetaMask or Phantom.

Hosted at **https://recovery.fiber.so**. Source: **https://github.com/fiberevm/recovery**.

## Is it safe?

- **Your backup and password never leave your browser.** Everything is decrypted and computed on your device.
- **Key recovery works offline.** It never touches the network.
- **The page only talks to the servers you choose.** The servers (RPCs) are listed under **RPC settings** before you unlock. When the scan starts, the page locks itself so it can only connect to those servers, plus one IPFS gateway (`ipfs-lb.com`) for proving files a send may need. The servers see that someone read a pool's public history, never your keys or which funds are yours.
- **Sending never exposes your backup.** The page makes the zero-knowledge proof itself and hands your browser wallet a finished transaction to submit. The wallet pays gas, and never sees the backup or its keys.
- **The page can't be lied to quietly.** After rebuilding a pool's history, the page checks the result against the pool's live contract. If a server leaves out or changes anything, the scan fails with an error instead of showing an empty wallet.
- **Check the address bar.** The real page is only ever served from `https://recovery.fiber.so`. You can also download it and open it from your own computer (see below).

Anyone who sees a private key can take everything at that address. Never share it, paste it into a website you don't trust, or send it to support.

## Using it

1. Open https://recovery.fiber.so, or your own copy of `index.html`.
2. Drop your `.fiberseed` file on the page, or click to choose it. A green checkmark means the file was read.
3. Optional: open **RPC settings** to replace the default servers with your own.
4. Enter the password you set when you exported the backup, then press **Unlock**. Scanning starts right away.
5. Choose what you need:
   - **Private holdings:** each chain lists what you hold. To move a balance out, press **Send**, enter the address to send to and the amount (**Max** sends everything), pick the browser wallet that will pay gas, and press **Send**. Approve the transaction in your wallet. When it confirms, the page shows a link to the block explorer and refreshes the balance.
   - **Private key recovery:** paste an address (`0x…` for EVM networks, or a Solana address) and press **Find private key**. The key is blurred until you press **Reveal**.
6. Press **Lock** when you're done. Closing the tab also clears everything.

Sending moves funds out of Fiber's private pool to a public address, on the same chain. You need a little ETH (Arbitrum, Base) or BNB (BNB Chain) in your browser wallet for gas.

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

Refresh the pool snapshots (`bun run snapshot`) and commit them before a release, so scans start from recent history.

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

### 4. Sending (unshielding)

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

| Chain | Fiber pool | Default server (RPC) |
| --- | --- | --- |
| Arbitrum | `0x7233d17ec3Ce855Acb8F7A9412Bf90757117A092` | `https://arb1.arbitrum.io/rpc` |
| Base | `0x22F45899EE13042ae046f7Aa7C2292Ea74C7F1c6` | `https://base.gateway.tenderly.co` |
| BNB Chain | `0x7233d17ec3Ce855Acb8F7A9412Bf90757117A092` | `https://bsc.rpc.blxrbdn.com` |

Arbitrum and BNB Chain share a pool address; the page always picks the pool by chain. These come from omni's `packages/shared/asset-definitions/railgun.ts` and are set in `src/chains.ts`.

Most free servers refuse to return old history, or only return a few blocks at a time. The defaults are the free servers that worked in testing:

- **Arbitrum:** fast, with large ranges. A scan takes seconds.
- **Base:** 1,000 blocks per request and about 10 requests a second.
- **BNB Chain:** 5,000 blocks per request, but slow (1–4 seconds each).

The page reads each server's limits from its error messages and slows down when it is rate-limited. If you have your own RPC (Alchemy, QuickNode, etc.), paste it in for a faster scan.

### Pool snapshots

Reading years of blocks from a free server is slow; Base's full history takes about 14 minutes. To avoid that, the page ships with each pool's history saved up to a recent block, in `src/snapshots/<chain>.json`. A scan replays the snapshot and only asks the server for newer blocks.

The snapshot doesn't have to be trusted. The final check against the live contract catches any missing or changed history.

A snapshot only covers blocks that are final, so it can't be undone by a chain reorganization. Refresh the snapshots before each release:

```bash
bun run snapshot                     # add new blocks to every snapshot
bun run snapshot --only base         # one chain: arbitrum, base or bnb
bun run snapshot --full              # start over from each pool's first block
bun run snapshot --bnb-rpc <url>     # use another server (also --arbitrum-rpc, --base-rpc)
```

The free servers make a full rebuild slow (Base takes about 14 minutes). A paid RPC is much faster; the BNB Chain snapshot took 34 seconds on QuickNode. Pass keyed URLs through environment variables, which keeps them out of your shell history and the script's output:

```bash
BNB_RPC_URL=… BASE_RPC_URL=… ARBITRUM_RPC_URL=… bun run snapshot
```

The snapshot files only contain public pool history. No RPC URL is ever written to them.

The older a snapshot is, the more a scan has to fetch live from the free servers. Each day it ages adds roughly 4 seconds to a Base scan; BNB Chain's free server is slower. With fresh snapshots, scanning all three chains takes a few seconds.

## Project layout

```
index.html            The page
src/
  app.ts              Page logic: file drop, unlock, both sections
  fiberseed.ts        Reading and unlocking .fiberseed files
  derive.ts           Address and private key derivation
  chains.ts           Pools, default servers and token names per chain
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

## License

MIT; see `LICENSE`. The bundled fonts (Geist, Space Grotesk) are under the SIL Open Font License; see `src/fonts/`. The bundled proving circuits are Railgun's.
