# DeFi Wallet — Chrome Extension

A Manifest V3 wallet extension that injects an EIP-1193 provider on every page, so any dApp (Uniswap, PancakeSwap, Aave, 1inch, Curve, etc.) sees your wallet exactly like MetaMask. Multi-chain (BSC, Ethereum, Base, Arbitrum, Optimism, Polygon).

## Install (load unpacked — no Chrome Web Store review)

```bash
git clone https://github.com/ZENSEE1314/defi-wallet-extension.git
cd defi-wallet-extension
npm install
npm run build
```

Then in Chrome:

1. Open `chrome://extensions`
2. Toggle **Developer mode** on (top-right)
3. Click **Load unpacked** → select the `dist/` folder
4. Pin the extension to the toolbar (puzzle icon → pin)

## First time setup

1. Click the extension icon
2. Choose **+ New** (generates a fresh wallet) or **Import key** (paste an existing 0x… private key)
3. Set a password (8+ chars). Your key is encrypted with AES-256-GCM (PBKDF2-SHA256 / 310k iters) and stored in `chrome.storage.local`. The plaintext only lives in service-worker memory while unlocked.

## Use on any dApp

1. Visit https://app.uniswap.org / https://pancakeswap.finance / etc.
2. Click **Connect Wallet** → the dApp will see DeFi Wallet via EIP-6963 (or as `window.ethereum` if no other wallet is installed)
3. Approve the connection in the extension popup
4. Sign txs / messages — every signing request opens the popup with the details

## What's inside

| File | Job |
|---|---|
| `src/inpage.ts` | EIP-1193 provider injected into the page world |
| `src/content.ts` | Bridges page ↔ background via `window.postMessage` and `chrome.runtime.sendMessage` |
| `src/background.ts` | Service worker — holds wallets, routes RPC, queues approval prompts |
| `src/popup.ts` | Vanilla TS popup — unlock, approve, network switcher, connected sites |
| `src/crypto.ts` | AES-256-GCM keystore (Web Crypto) |
| `src/chains.ts` | Multi-chain registry |

## Security notes

- Keys live in `chrome.storage.local`, AES-256-GCM encrypted with your password
- Service worker holds the unlocked plaintext **in memory only** — Chrome evicts the worker after a few minutes of inactivity, requiring re-unlock
- Every signing request requires a popup approval, no auto-signing
- The page-side `window.ethereum` cannot read the key — it only requests, the background signs
- Per-origin permission grants — sites you've approved are remembered until you remove them in the popup

## Development

```bash
npm run watch   # rebuilds dist/ on file change — reload the extension in chrome://extensions to pick up changes
```

## Limits / known gaps (v0.1)

- One signing approval at a time (queue not yet exposed)
- No HD wallet — single-key per record
- No EIP-712 nested types preview UI yet (raw JSON shown)
- No token approval guardrails (yet) — review every `eth_sendTransaction` carefully
